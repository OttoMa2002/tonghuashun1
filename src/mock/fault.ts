// 故障注入层(T04)。语义以 docs/data-contract.md §4 为准、architecture.md §5.3 为依据。
// src/mock/CLAUDE.md 规则 4:故障层包裹生成/查询层,故障全关时输出与直出逐字节一致。
//
// §4 四种故障(各可独立开启,默认全关):
//  - timeout:不返回数据,延迟至客户端超时后回执 timeout 错误(默认 CLIENT_TIMEOUT_MILLIS=10s)
//  - http_5xx:返回 ErrorResponse(internal),模拟 5xx
//  - slow:延迟后正常返回(默认 3000ms)
//  - out_of_order:values 内随机交换相邻样本对(默认交换率 5%),产出乱序时间戳
//    —— §4 审定:乱序对下游透明由 Worker(T05)解析侧排序兜底,本层只忠实产出乱序
//
// 配置「按 series key 或全局开关」(§4):timeout/http_5xx/slow 作用于整个查询调用(全局开关);
// out_of_order 按 targetKeys 定向到具体序列(省略 = 全部命中序列)。契约未定义响应级故障与
// series key 的组合规则,故不发明:响应级故障一律全局,定向能力由查询 selector 自身承担。
//
// 确定性(CLAUDE.md 规则 3):故障判定走可种子化 PRNG,种子由 seed + 查询标识派生,
// 同 seed + 同查询 → 同判定;禁裸用 Math.random。

import { CLIENT_TIMEOUT_MILLIS, seriesKey } from '../contract';
import type { QueryRangeParams, QueryRangeResponse } from '../contract';

import { createPrng, hashSeed, type Prng } from './prng';
import { queryRange, type MockDataset } from './query';

/** timeout 故障:延迟 afterMillis 后回执 timeout 错误,默认客户端超时基准。 */
export interface TimeoutFault {
  /** 触发概率 [0,1]。0 = 关闭(默认);1 = 定向常开。 */
  probability: number;
  /** 延迟多久后回执(ms),默认 CLIENT_TIMEOUT_MILLIS。 */
  afterMillis?: number;
}

/** http_5xx 故障:返回 ErrorResponse(internal)。 */
export interface Http5xxFault {
  /** 触发概率 [0,1]。0 = 关闭(默认);1 = 定向常开。 */
  probability: number;
}

/** slow 故障:延迟 delayMillis 后正常返回数据。 */
export interface SlowFault {
  /** 触发概率 [0,1]。0 = 关闭(默认);1 = 定向常开。 */
  probability: number;
  /** 延迟毫秒,默认 3000。 */
  delayMillis?: number;
}

/** out_of_order 故障:对成功响应的 values 交换相邻样本对(产出乱序 tsMillis)。 */
export interface OutOfOrderFault {
  /** 对本次查询施加乱序的概率 [0,1]。0 = 关闭(默认);1 = 定向常开。 */
  probability: number;
  /** 相邻样本对(不重叠,步长 2)的交换率,默认 0.05。 */
  swapRate?: number;
}

/** 故障配置:四种故障各自独立,默认(省略)即关闭。 */
export interface FaultConfig {
  timeout?: TimeoutFault;
  http5xx?: Http5xxFault;
  slow?: SlowFault;
  outOfOrder?: OutOfOrderFault;
  /**
   * out_of_order 定向开关:仅对这些 series key 施加乱序(省略 = 全部命中序列)。
   * 响应级故障(timeout/http5xx/slow)不受此约束,见文件头说明。
   */
  targetKeys?: readonly string[];
}

/** 注入延迟实现。默认 setTimeout;测试可替换以避免真实等待并断言延迟时长。 */
export type Sleep = (millis: number) => Promise<void>;

export interface FaultInjectorOptions {
  /** 故障判定 PRNG 的全局种子,默认固定常量(保证开箱确定性)。 */
  seed?: number;
  /** 延迟实现,默认基于 setTimeout。 */
  sleep?: Sleep;
}

/** 故障注入器:包裹 dataset + queryRange,对外暴露 async 查询(故障可能引入延迟)。 */
export interface FaultInjector {
  /** 执行查询并按当前配置注入故障。错误一律以 ErrorResponse 回执(绝不抛出)。 */
  query(params: QueryRangeParams): Promise<QueryRangeResponse>;
  /** 替换故障配置(T09 借此模拟故障出现/恢复)。 */
  setConfig(config: FaultConfig): void;
}

const DEFAULT_SLOW_DELAY_MILLIS = 3000;
const DEFAULT_SWAP_RATE = 0.05;
/** 任意固定常量,作默认全局种子,保证不传 seed 时仍确定性可复现。 */
const DEFAULT_SEED = 0x9e3779b9;

const defaultSleep: Sleep = (millis) => new Promise<void>((resolve) => setTimeout(resolve, millis));

/** 查询标识:把 selector(规范化)+ 时间窗 + step 拼成稳定字符串,用于派生本次查询的子种子。 */
function queryKey(params: QueryRangeParams): string {
  const sel = seriesKey(params.selector.name, params.selector.labels ?? {});
  return `${sel}|${params.startMillis}|${params.endMillis}|${params.stepMillis ?? 'raw'}`;
}

/** 不重叠相邻对交换(步长 2):values[i] ↔ values[i+1],每对以 swapRate 概率触发。 */
function swapAdjacentPairs(
  values: ReadonlyArray<readonly [number, number]>,
  swapRate: number,
  prng: Prng,
): Array<[number, number]> {
  const out: Array<[number, number]> = values.map((v) => [v[0], v[1]]);
  for (let i = 0; i + 1 < out.length; i += 2) {
    if (prng.next() < swapRate) {
      const tmp = out[i];
      out[i] = out[i + 1];
      out[i + 1] = tmp;
    }
  }
  return out;
}

/**
 * 创建故障注入器。故障全关(config 省略各项或概率为 0)时,query 的解析值与
 * queryRange(dataset, params) 逐字段一致(回归测试断言,§4 / CLAUDE.md 规则 4)。
 *
 * 判定优先级:timeout > http5xx >(slow 与 out_of_order 同作用于成功路径)。
 * 即 timeout 命中即短路返回超时错误,其后才轮到 5xx,二者皆未命中才计算数据并可叠加 slow/乱序。
 */
export function createFaultInjector(
  dataset: MockDataset,
  config: FaultConfig = {},
  options: FaultInjectorOptions = {},
): FaultInjector {
  const seed = options.seed ?? DEFAULT_SEED;
  const sleep = options.sleep ?? defaultSleep;
  let active: FaultConfig = config;

  /** probability>0 且 PRNG 抽样命中(draw < probability)即触发;probability 0 直接跳过、不抽样。 */
  function triggers(probability: number | undefined, prng: Prng): boolean {
    if (!probability || probability <= 0) {
      return false;
    }
    return prng.next() < probability;
  }

  async function query(params: QueryRangeParams): Promise<QueryRangeResponse> {
    const prng = createPrng(hashSeed(seed, queryKey(params)));

    // 抽样顺序固定为 timeout → http5xx → slow → out_of_order,保证同配置同判定。
    if (triggers(active.timeout?.probability, prng)) {
      const afterMillis = active.timeout?.afterMillis ?? CLIENT_TIMEOUT_MILLIS;
      await sleep(afterMillis);
      return { status: 'error', errorType: 'timeout', message: `mock timeout after ${afterMillis}ms(§4)` };
    }

    if (triggers(active.http5xx?.probability, prng)) {
      return { status: 'error', errorType: 'internal', message: 'mock http 5xx(§4)' };
    }

    const slowHit = triggers(active.slow?.probability, prng);
    const outOfOrderHit = triggers(active.outOfOrder?.probability, prng);

    const base = queryRange(dataset, params);

    if (slowHit) {
      await sleep(active.slow?.delayMillis ?? DEFAULT_SLOW_DELAY_MILLIS);
    }

    if (!outOfOrderHit || base.status !== 'success') {
      return base;
    }

    const swapRate = active.outOfOrder?.swapRate ?? DEFAULT_SWAP_RATE;
    const targetKeys = active.targetKeys;
    const result = base.data.result.map((series) => {
      const key = seriesKey(series.metric.name, series.metric.labels);
      if (targetKeys && !targetKeys.includes(key)) {
        return series; // 定向未命中:原样保留
      }
      return { metric: series.metric, values: swapAdjacentPairs(series.values, swapRate, prng) };
    });
    return { status: 'success', data: { result } };
  }

  return {
    query,
    setConfig(next: FaultConfig): void {
      active = next;
    },
  };
}
