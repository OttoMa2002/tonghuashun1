// query_range 实现(T03)。语义以 docs/data-contract.md §2 为准、ADR-0003 为依据:
//  - selector:metric name + label 等值匹配(仅 =,无正则/PromQL)
//  - stepped 模式:在 start+k*step 评估栅格上采样,取「该时刻之前最近样本」,
//    lookback 窗口 5 分钟(LOOKBACK_MILLIS),窗口内无样本则该评估点为空(matrix 中省略)
//  - raw 模式(省略 stepMillis):返回 [start,end] 内全部原始样本,不做评估对齐(ADR-0004)
// src/mock/CLAUDE.md:对外唯一输出格式是 MatrixResponse / ErrorResponse,错误不抛而回执。
// prom-query-semantics 反例 1/4:评估对齐以时间为基准(非下标抽稀),不发明契约外行为。

import type { GeneratedSeries } from './generator';

import { LOOKBACK_MILLIS } from '../contract';
import type {
  MatrixResponse,
  MatrixSeries,
  QueryRangeParams,
  QueryRangeResponse,
  Sample,
  Selector,
} from '../contract';

/**
 * mock 数据集:query_range 查询的底层原始样本源(已由 generateSeries 在固定栅格上产出)。
 * 数据集一次生成、稳定不变,使同一 tsMillis 的取值与查询窗口无关(确定性可复现)。
 */
export type MockDataset = readonly GeneratedSeries[];

/** 选择器匹配:name 等值,且 selector.labels 每一项都在序列 labels 中等值命中(§2,仅 =)。 */
function matches(series: GeneratedSeries, selector: Selector): boolean {
  if (series.metric.name !== selector.name) {
    return false;
  }
  const labels = selector.labels;
  if (!labels) {
    return true;
  }
  for (const k of Object.keys(labels)) {
    if (series.metric.labels[k] !== labels[k]) {
      return false;
    }
  }
  return true;
}

/** 样本按 tsMillis 升序;返回 ts <= t 的最右样本下标,无则 -1(二分,适配 raw 百万点)。 */
function lastIndexAtOrBefore(samples: readonly Sample[], t: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid][0] <= t) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/** 返回 ts >= t 的最左样本下标,无则 samples.length(二分)。 */
function firstIndexAtOrAfter(samples: readonly Sample[], t: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid][0] < t) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** stepped 评估:栅格 start+k*step(k=0..floor((end-start)/step)),取最近样本 + lookback。 */
function evaluateStepped(samples: readonly Sample[], start: number, end: number, step: number): Array<[number, number]> {
  const count = Math.floor((end - start) / step) + 1;
  const values: Array<[number, number]> = [];
  for (let k = 0; k < count; k++) {
    const t = start + k * step;
    const idx = lastIndexAtOrBefore(samples, t);
    if (idx < 0) {
      continue; // 该评估时刻之前无任何样本 → 空点,matrix 中省略
    }
    const [sampleTs, value] = samples[idx];
    if (t - sampleTs <= LOOKBACK_MILLIS) {
      values.push([t, value]); // 评估点时间戳取评估时刻,值取最近样本(Prometheus 语义)
    }
    // 否则:最近样本超出 lookback 窗口 → 空点,省略
  }
  return values;
}

/** raw 评估:返回 [start,end] 闭区间内全部原始样本,不做对齐(ADR-0004,仅 million-points 页用)。 */
function evaluateRaw(samples: readonly Sample[], start: number, end: number): Array<[number, number]> {
  const from = firstIndexAtOrAfter(samples, start);
  const values: Array<[number, number]> = [];
  for (let i = from; i < samples.length && samples[i][0] <= end; i++) {
    values.push([samples[i][0], samples[i][1]]);
  }
  return values;
}

/**
 * 针对数据集执行 query_range,返回 matrix(§2)。错误以 ErrorResponse 回执,绝不抛出
 * (src/mock/CLAUDE.md 规则 6:对外唯一格式是 MatrixResponse / ErrorResponse)。
 *
 * - startMillis < endMillis 为契约硬性要求(§2),违反 → bad_request
 * - stepMillis 省略 = raw 模式;给出时须 > 0,否则 bad_request
 * - 选择器匹配不到任何序列 → 成功响应、空 result(对齐 Prometheus:无匹配非错误)
 */
export function queryRange(dataset: MockDataset, params: QueryRangeParams): QueryRangeResponse {
  const { selector, startMillis, endMillis, stepMillis } = params;

  if (!(startMillis < endMillis)) {
    return { status: 'error', errorType: 'bad_request', message: 'startMillis 必须 < endMillis(§2)' };
  }
  const isStepped = stepMillis !== undefined;
  if (isStepped && !(stepMillis > 0)) {
    return { status: 'error', errorType: 'bad_request', message: 'stepMillis 必须 > 0' };
  }

  const result: MatrixSeries[] = [];
  for (const series of dataset) {
    if (!matches(series, selector)) {
      continue;
    }
    const values = isStepped
      ? evaluateStepped(series.samples, startMillis, endMillis, stepMillis)
      : evaluateRaw(series.samples, startMillis, endMillis);
    result.push({ metric: { name: series.metric.name, labels: series.metric.labels }, values });
  }

  const response: MatrixResponse = { status: 'success', data: { result } };
  return response;
}
