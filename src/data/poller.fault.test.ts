// T09 调度器对接 T04 四种故障(超时/5xx/慢响应/乱序)的行为断言。
// 这是真实链路集成测试:真 FaultInjector(T04)+ 真 Worker handler(T05)→ 进程内 client,
// 调度器据回执做退避/去重/恢复决策。fake timers 同时驱动调度器定时器与故障注入的 sleep。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFaultInjector } from '../mock/fault';
import type { FaultConfig } from '../mock/fault';
import { generateSeries } from '../mock/generator';
import type { MockDataset } from '../mock/query';
import { createMockSource } from '../worker/source';
import { createQueryHandler } from '../worker/handler';

import type {
  MainToWorkerMessage,
  QueryExecPayload,
  QueryReceipt,
} from '../contract';

import { createPoller } from './poller';
import type { QueryClient } from './queryClient';

/** 占位数据集:一条 gauge,栅格 0..60s/15s(5 点),足够覆盖故障路径。 */
function buildDataset(): MockDataset {
  return generateSeries(
    { name: 'up', type: 'gauge', labelSets: [{ job: 'api' }], valueRange: [0, 1] },
    { startMillis: 0, endMillis: 60_000, stepMillis: 15_000 },
    1,
  );
}

/**
 * 进程内 client:用真 Worker handler + mock source 替代真实 Worker(jsdom 无 Worker)。
 * exec→handler.handle,handler.post→广播给订阅者,与 createWorkerClient 行为同构。
 * 记录每次 exec 的(fake)时刻与全部回执,供断言退避曲线/去重。
 */
function createInProcessClient(config: FaultConfig) {
  const injector = createFaultInjector(buildDataset(), config);
  const source = createMockSource(injector);
  const listeners = new Set<(receipt: QueryReceipt) => void>();
  const handler = createQueryHandler({
    source,
    post: (message) => {
      for (const l of listeners) {
        l(message);
      }
    },
    now: () => 0,
  });

  const execTimes: number[] = [];
  const received: QueryReceipt[] = [];
  listeners.add((r) => received.push(r));
  let seq = 0;

  const client: QueryClient = {
    exec(payload: QueryExecPayload): string {
      const id = `exec-${seq++}`;
      execTimes.push(Date.now());
      const message: MainToWorkerMessage = { id, type: 'query.exec', payload };
      void handler.handle(message);
      return id;
    },
    cancel(queryId: string): void {
      const message: MainToWorkerMessage = {
        id: `cancel-${seq++}`,
        type: 'query.cancel',
        payload: { queryId },
      };
      void handler.handle(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    client,
    execTimes,
    received,
    get execCount(): number {
      return execTimes.length;
    },
  };
}

const STEPPED_PAYLOAD: QueryExecPayload = {
  queryId: 'q',
  selector: { name: 'up' },
  startMillis: 0,
  endMillis: 60_000,
  stepMillis: 15_000,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('调度器 × T04 故障', () => {
  it('timeout:回执 kind=timeout,触发指数退避重试(间隔随失败翻倍)', async () => {
    // interval > afterMillis,聚焦退避语义,排除节奏拍干扰。
    const fake = createInProcessClient({ timeout: { probability: 1, afterMillis: 2000 } });
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => STEPPED_PAYLOAD,
      intervalMillis: 10_000,
      backoffCapMillis: 120_000,
    });

    poller.start(); // exec-0 @0 → 超时 sleep 2000
    await vi.advanceTimersByTimeAsync(2000); // @2000 回执 timeout → 退避 10000 → 重试 @12000
    expect(fake.received.at(-1)).toMatchObject({ type: 'query.error', payload: { kind: 'timeout' } });
    expect(fake.execCount).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000); // @12000 重试 exec-1 → 超时 sleep 2000
    expect(fake.execCount).toBe(2);

    await vi.advanceTimersByTimeAsync(2000); // @14000 再超时 → 退避翻倍 20000 → 重试 @34000
    await vi.advanceTimersByTimeAsync(20_000); // @34000 exec-2
    expect(fake.execCount).toBe(3);

    // 退避曲线:每拍间隔 = 2000(超时等待) + 退避;退避 10000→20000 翻倍。
    expect(fake.execTimes[1] - fake.execTimes[0]).toBe(12_000);
    expect(fake.execTimes[2] - fake.execTimes[1]).toBe(22_000);

    poller.stop();
  });

  it('http_5xx:回执 kind=http,触发指数退避重试(纯退避,无延迟)', async () => {
    const fake = createInProcessClient({ http5xx: { probability: 1 } });
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => STEPPED_PAYLOAD,
      intervalMillis: 10_000,
      backoffCapMillis: 120_000,
    });

    poller.start(); // exec-0 @0 → 立即 5xx
    await vi.advanceTimersByTimeAsync(0); // flush 微任务 → 回执 http → 退避 10000
    expect(fake.received.at(-1)).toMatchObject({ type: 'query.error', payload: { kind: 'http' } });
    expect(fake.execCount).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000); // @10000 exec-1 → 5xx → 退避 20000
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.execCount).toBe(2);

    await vi.advanceTimersByTimeAsync(20_000); // @30000 exec-2
    expect(fake.execCount).toBe(3);

    // 纯退避(无等待):间隔即退避值,10000→20000 翻倍。
    expect(fake.execTimes[1] - fake.execTimes[0]).toBe(10_000);
    expect(fake.execTimes[2] - fake.execTimes[1]).toBe(20_000);

    poller.stop();
  });

  it('slow:慢响应期间到点的拍子被去重跳过,响应后节奏恢复', async () => {
    // interval < delayMillis:慢响应跨越多个节奏边界,去重必须把这些拍压掉。
    const fake = createInProcessClient({ slow: { probability: 1, delayMillis: 3000 } });
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => STEPPED_PAYLOAD,
      intervalMillis: 1000,
    });

    poller.start(); // exec-0 @0 → 慢响应 sleep 3000(期间 @1000/@2000 拍应被去重)
    await vi.advanceTimersByTimeAsync(2999);
    expect(fake.execCount).toBe(1); // 去重生效:慢响应在途,无新指令
    expect(fake.received).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1); // @3000 慢响应返回成功
    expect(fake.received.at(-1)).toMatchObject({ type: 'query.result' });

    await vi.advanceTimersByTimeAsync(1000); // 响应后节奏恢复 → 再发一拍
    expect(fake.execCount).toBeGreaterThanOrEqual(2);

    poller.stop();
  });

  it('out_of_order:乱序响应经 Worker 排序为成功回执,节奏正常推进', async () => {
    // swapRate=1 强制全对交换 → values 乱序;Worker(§4)解析侧按 ts 升序排序后列式化。
    const fake = createInProcessClient({ outOfOrder: { probability: 1, swapRate: 1 } });
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => STEPPED_PAYLOAD,
      intervalMillis: 1000,
    });

    poller.start(); // exec-0 @0 → 成功(乱序已被 Worker 排序)
    await vi.advanceTimersByTimeAsync(0); // flush → 回执 result
    const last = fake.received.at(-1);
    expect(last?.type).toBe('query.result');
    if (last?.type === 'query.result') {
      const ts = last.payload.frame.ts;
      // §4/§6:Worker 排序后 ts 严格递增(对下游透明)。
      for (let i = 1; i < ts.length; i++) {
        expect(ts[i]).toBeGreaterThan(ts[i - 1]);
      }
      expect(ts.length).toBeGreaterThan(1);
    }

    await vi.advanceTimersByTimeAsync(1000); // 成功后对齐节奏继续推进
    expect(fake.execCount).toBeGreaterThanOrEqual(2);

    poller.stop();
  });
});
