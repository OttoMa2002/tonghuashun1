import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import type {
  ColumnarFrame,
  QueryExecPayload,
  QueryReceipt,
} from '../contract';
import { DEFAULT_SCRAPE_INTERVAL_MILLIS } from '../contract';
import { DataLayerProvider, createColumnarStore } from '../data';
import type { QueryClient } from '../data';
import { DASHBOARD_COUNTER_SELECTOR, DASHBOARD_GAUGE_SELECTOR } from '../worker/dashboard-dataset';

import { DashboardView } from './DashboardPage';

// jsdom 无法真实渲染 canvas/ResizeObserver,mock 掉,使数据态下图表挂载不崩(同 MillionPointsPage.test)。
vi.mock('uplot', () => ({
  default: class {
    setData = vi.fn();
    setSize = vi.fn();
    destroy = vi.fn();
  },
}));
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

beforeEach(() => {
  vi.useFakeTimers();
  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 假 client:记录每次 exec 的 (envelope id, payload),允许测试按 envelope id 投递回执。
 * 调度器以 envelope id 匹配 in-flight,hook 以 payload.queryId 匹配,故回执需同时带两者。
 */
function createFakeClient() {
  const listeners = new Set<(receipt: QueryReceipt) => void>();
  const calls: Array<{ execId: string; payload: QueryExecPayload }> = [];
  let seq = 0;

  const client: QueryClient = {
    exec(payload) {
      const execId = `exec-${seq++}`;
      calls.push({ execId, payload });
      return execId;
    },
    cancel() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    client,
    calls,
    emit(receipt: QueryReceipt): void {
      for (const listener of listeners) {
        listener(receipt);
      }
    },
    /** 某 selector 名下最近一次 exec 调用(轮询会多拍,取最新一拍)。 */
    last(selectorName: string): { execId: string; payload: QueryExecPayload } {
      const hit = [...calls].reverse().find((c) => c.payload.selector.name === selectorName);
      if (!hit) {
        throw new Error(`无 ${selectorName} 的 exec 调用`);
      }
      return hit;
    },
    count(selectorName: string): number {
      return calls.filter((c) => c.payload.selector.name === selectorName).length;
    },
  };
}

function frame(): ColumnarFrame {
  const ts = Float64Array.from({ length: 4 }, (_v, i) => i * 1000);
  return { ts, series: [{ key: 'k', name: 'm', labels: {}, values: ts.slice() }] };
}

function resultReceipt(execId: string, queryId: string): QueryReceipt {
  return {
    id: execId,
    type: 'query.result',
    payload: { queryId, frame: frame(), meta: { rawPointCount: 4, elapsedMs: 2 } },
  };
}

function errorReceipt(execId: string, queryId: string): QueryReceipt {
  return {
    id: execId,
    type: 'query.error',
    payload: { queryId, kind: 'http', message: 'mock http 5xx(§4)' },
  };
}

function renderView(fake: ReturnType<typeof createFakeClient>) {
  return render(
    <DataLayerProvider value={{ client: fake.client, store: createColumnarStore() }}>
      <DashboardView />
    </DataLayerProvider>,
  );
}

describe('DashboardView', () => {
  it('挂载即由调度器下发两类面板查询:gauge 直读(无 rate)+ counter rate(带 stepMillis)', () => {
    const fake = createFakeClient();
    renderView(fake);

    const gauge = fake.last(DASHBOARD_GAUGE_SELECTOR.name);
    const rate = fake.last(DASHBOARD_COUNTER_SELECTOR.name);

    // gauge 面板:stepped 直读,无 rate。
    expect(gauge.payload.stepMillis).toBeGreaterThan(0);
    expect(gauge.payload.rate).toBeUndefined();
    // rate 面板:带 rate 窗口且必带 stepMillis(契约 §5,否则 Worker bad_request)。
    expect(rate.payload.rate?.windowMillis).toBeGreaterThan(0);
    expect(rate.payload.stepMillis).toBeGreaterThan(0);

    // 两面板初始均为加载态(可见)。
    expect(screen.getByTestId('panel-gauge-placeholder').textContent).toContain('加载中');
    expect(screen.getByTestId('panel-rate-placeholder').textContent).toContain('加载中');
  });

  it('DoD1:面板查询由调度器轮询驱动(无组件内 setInterval)——回执后到点自动再发一拍', () => {
    const fake = createFakeClient();
    renderView(fake);

    const first = fake.last(DASHBOARD_GAUGE_SELECTOR.name);
    expect(fake.count(DASHBOARD_GAUGE_SELECTOR.name)).toBe(1);

    // 收到回执(in-flight 清空),到 scrape_interval 边界后调度器自动再发一拍。
    act(() => {
      fake.emit(resultReceipt(first.execId, first.payload.queryId));
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_SCRAPE_INTERVAL_MILLIS);
    });

    // 第二拍来自调度器(本组件无任何 setInterval),exec 次数增加。
    expect(fake.count(DASHBOARD_GAUGE_SELECTOR.name)).toBeGreaterThanOrEqual(2);
  });

  it('DoD2:故障注入下错误态可见,恢复后自愈(下一拍成功回执清错并出图)', () => {
    const fake = createFakeClient();
    renderView(fake);

    const first = fake.last(DASHBOARD_GAUGE_SELECTOR.name);

    // 故障:错误回执 → gauge 面板呈现错误态。
    act(() => {
      fake.emit(errorReceipt(first.execId, first.payload.queryId));
    });
    expect(screen.getByTestId('panel-gauge-error')).toBeInTheDocument();
    expect(screen.getByTestId('panel-gauge-error').textContent).toContain('http');

    // 恢复:错误后调度器退避重试(到点再发一拍),其成功回执清错并切到数据态。
    act(() => {
      vi.advanceTimersByTime(DEFAULT_SCRAPE_INTERVAL_MILLIS);
    });
    const retry = fake.last(DASHBOARD_GAUGE_SELECTOR.name);
    expect(retry.execId).not.toBe(first.execId); // 确是新一拍(退避重试)
    act(() => {
      fake.emit(resultReceipt(retry.execId, retry.payload.queryId));
    });

    // 自愈:错误消失、占位消失 → 进入数据态(图表分支)。
    expect(screen.queryByTestId('panel-gauge-error')).toBeNull();
    expect(screen.queryByTestId('panel-gauge-placeholder')).toBeNull();
  });
});
