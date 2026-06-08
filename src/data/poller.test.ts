// T09 调度器纯节奏单测:fake timers + 假 client + 假可见性源,覆盖 DoD 四场景:
// 对齐、退避曲线、in-flight 去重、暂停恢复。client 由测试手动投递回执,
// 以精确控制「已收回执 / 仍 in-flight」两态。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  QueryErrorMessage,
  QueryExecPayload,
  QueryReceipt,
  QueryResultMessage,
} from '../contract';

import { createPoller } from './poller';
import type { QueryClient } from './queryClient';
import type { VisibilitySource } from './poller';

/** 假 client:记录每次 exec 的 envelope id,允许测试向订阅者投递回执。 */
function createFakeClient() {
  const listeners = new Set<(receipt: QueryReceipt) => void>();
  const execIds: string[] = [];
  const cancelled: string[] = [];
  let seq = 0;

  const client: QueryClient = {
    exec(): string {
      const id = `exec-${seq++}`;
      execIds.push(id);
      return id;
    },
    cancel(queryId: string): void {
      cancelled.push(queryId);
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
    execIds,
    cancelled,
    get execCount(): number {
      return execIds.length;
    },
    /** 投递某 exec 的成功回执。 */
    resolveOk(execId: string): void {
      const receipt: QueryResultMessage = {
        id: execId,
        type: 'query.result',
        payload: {
          queryId: 'q',
          frame: { ts: new Float64Array(0), series: [] },
          meta: { rawPointCount: 0, elapsedMs: 1 },
        },
      };
      for (const l of listeners) {
        l(receipt);
      }
    },
    /** 投递某 exec 的错误回执。 */
    resolveErr(execId: string): void {
      const receipt: QueryErrorMessage = {
        id: execId,
        type: 'query.error',
        payload: { queryId: 'q', kind: 'http', message: 'boom' },
      };
      for (const l of listeners) {
        l(receipt);
      }
    },
  };
}

/** 可手动翻转的可见性源。 */
function createFakeVisibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const source: VisibilitySource = {
    isHidden: () => hidden,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    set(next: boolean): void {
      hidden = next;
      for (const l of listeners) {
        l();
      }
    },
  };
}

const PAYLOAD: QueryExecPayload = {
  queryId: 'q',
  selector: { name: 'up' },
  startMillis: 0,
  endMillis: 1000,
  stepMillis: 100,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPoller 节奏', () => {
  it('对齐:成功后的下一拍落在 interval 边界', () => {
    vi.setSystemTime(4000); // 不在边界上
    const fake = createFakeClient();
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => PAYLOAD,
      intervalMillis: 15_000,
    });

    poller.start(); // 首拍 exec-0(t=4000)
    expect(fake.execCount).toBe(1);
    fake.resolveOk(fake.execIds[0]); // 回执到 → 下一拍已对齐排到 t=15000

    vi.advanceTimersByTime(15_000 - 4000 - 1); // t=14999
    expect(fake.execCount).toBe(1); // 还没到边界

    vi.advanceTimersByTime(1); // t=15000,边界
    expect(fake.execCount).toBe(2);

    poller.stop();
  });

  it('退避曲线:连续失败按 interval·2^n 截到上限,成功后重置', () => {
    const fake = createFakeClient();
    const interval = 1000;
    const cap = 8000;
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => PAYLOAD,
      intervalMillis: interval,
      backoffCapMillis: cap,
    });

    poller.start(); // exec-0(t=0)
    const expectedDelays = [1000, 2000, 4000, 8000, 8000]; // 末两拍触顶
    let n = 1;
    for (const delay of expectedDelays) {
      fake.resolveErr(fake.execIds[n - 1]); // 第 n 次失败 → 排退避
      vi.advanceTimersByTime(delay - 1);
      expect(fake.execCount).toBe(n); // 退避未到点
      vi.advanceTimersByTime(1);
      expect(fake.execCount).toBe(n + 1); // 退避到点,发第 n+1 拍
      n += 1;
    }

    // 成功 → 退避重置,后续失败应重新从 interval·2^0 起。
    fake.resolveOk(fake.execIds[n - 1]);
    // 成功后回到对齐节奏(此刻系统时间为 1000+2000+4000+8000+8000=23000,interval=1000 → 边界,delay=interval)
    vi.advanceTimersByTime(interval);
    expect(fake.execCount).toBe(n + 1);
    fake.resolveErr(fake.execIds[n]); // 再失败一次
    vi.advanceTimersByTime(1000 - 1);
    expect(fake.execCount).toBe(n + 1); // 退避从 1000 重新起步,证明已重置
    vi.advanceTimersByTime(1);
    expect(fake.execCount).toBe(n + 2);

    poller.stop();
  });

  it('去重:in-flight 期间到点的拍子跳过,不发新指令', () => {
    const fake = createFakeClient();
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => PAYLOAD,
      intervalMillis: 1000,
    });

    poller.start(); // exec-0(t=0),未投递回执 → 持续 in-flight
    vi.advanceTimersByTime(1000); // t=1000 拍 → in-flight,跳过
    vi.advanceTimersByTime(1000); // t=2000 拍 → in-flight,跳过
    expect(fake.execCount).toBe(1); // 去重生效:始终只有一笔

    fake.resolveOk(fake.execIds[0]); // 回执到(t=2000)→ 下一拍排到 t=3000
    vi.advanceTimersByTime(1000); // t=3000
    expect(fake.execCount).toBe(2);

    poller.stop();
  });

  it('暂停恢复:隐藏停拍,可见立即补一次', () => {
    const fake = createFakeClient();
    const vis = createFakeVisibility();
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => PAYLOAD,
      intervalMillis: 1000,
      visibility: vis.source,
    });

    poller.start(); // exec-0(t=0)
    fake.resolveOk(fake.execIds[0]); // 下一拍排到 t=1000

    vis.set(true); // 隐藏 → 暂停,清掉 pending 拍
    vi.advanceTimersByTime(5000);
    expect(fake.execCount).toBe(1); // 暂停期间不发

    vis.set(false); // 可见 → 立即补一次
    expect(fake.execCount).toBe(2);

    poller.stop();
  });

  it('stop 取消 in-flight 查询并退订', () => {
    const fake = createFakeClient();
    const poller = createPoller({
      client: fake.client,
      buildPayload: () => PAYLOAD,
      intervalMillis: 1000,
    });

    poller.start(); // exec-0,in-flight
    poller.stop();
    expect(fake.cancelled).toEqual(['q']); // 取消了未回执的查询

    // 退订后回执不再触发任何排程
    vi.advanceTimersByTime(10_000);
    expect(fake.execCount).toBe(1);
  });
});
