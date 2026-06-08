import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import type {
  ColumnarFrame,
  QueryExecPayload,
  QueryReceipt,
  QueryResultMessage,
} from '../contract';
import { DataLayerProvider, createColumnarStore } from '../data';
import type { QueryClient } from '../data';
import {
  MILLION_END_MILLIS,
  MILLION_SELECTOR,
  MILLION_START_MILLIS,
} from '../worker/million-dataset';

import { MillionPointsView } from './MillionPointsPage';

// 本页测试聚焦查询指令与耗时面板,不验证 uPlot 渲染(那是 T10/T14 的事)。
// jsdom 无法真实渲染 canvas/ResizeObserver,故 mock 掉,使出结果后图表挂载不崩。
vi.mock('uplot', () => ({
  default: class {
    setData = vi.fn();
    setSize = vi.fn();
    destroy = vi.fn();
  },
}));
vi.mock('uplot/dist/uPlot.min.css', () => ({}));

beforeEach(() => {
  class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
});

/** 假 client:记录 exec 指令并允许手动投递回执(镜像 useMetricQuery.test 的替身)。 */
function createFakeClient() {
  const listeners = new Set<(receipt: QueryReceipt) => void>();
  let seq = 0;
  let lastExecId = '';
  let lastPayload: QueryExecPayload | null = null;

  const client: QueryClient = {
    exec(payload) {
      lastPayload = payload;
      lastExecId = `exec-${seq++}`;
      return lastExecId;
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
    emit(receipt: QueryReceipt): void {
      for (const listener of listeners) {
        listener(receipt);
      }
    },
    get execId(): string {
      return lastExecId;
    },
    get payload(): QueryExecPayload | null {
      return lastPayload;
    },
  };
}

function frame(length: number): ColumnarFrame {
  const ts = Float64Array.from({ length }, (_v, i) => MILLION_START_MILLIS + i);
  return { ts, series: [{ key: 'demo', name: 'demo_raw_signal', labels: { source: 'million' }, values: ts.slice() }] };
}

function resultReceipt(id: string, rawPointCount: number, elapsedMs: number): QueryResultMessage {
  return {
    id,
    type: 'query.result',
    payload: {
      queryId: 'qid',
      frame: frame(rawPointCount),
      meta: { rawPointCount, elapsedMs },
    },
  };
}

function renderView(fake: ReturnType<typeof createFakeClient>) {
  return render(
    <DataLayerProvider value={{ client: fake.client, store: createColumnarStore() }}>
      <MillionPointsView />
    </DataLayerProvider>,
  );
}

describe('MillionPointsView', () => {
  it('DoD1:下发的查询指令是 raw —— 无 stepMillis、无 downsample,选择器命中演示序列', () => {
    const fake = createFakeClient();
    renderView(fake);

    const payload = fake.payload;
    expect(payload).not.toBeNull();
    // raw 模式:既无 step 也无 LTTB 降采样(ADR-0004 受控例外)。
    expect(payload?.stepMillis).toBeUndefined();
    expect(payload?.downsample).toBeUndefined();
    // 整窗 raw:start/end 覆盖百万点序列。
    expect(payload?.selector).toEqual(MILLION_SELECTOR);
    expect(payload?.startMillis).toBe(MILLION_START_MILLIS);
    expect(payload?.endMillis).toBe(MILLION_END_MILLIS);
    // 页面也显式标注查询模式为 raw。
    expect(screen.getByTestId('query-mode').textContent).toContain('raw');
  });

  it('DoD2:页面自显渲染耗时面板(含渲染耗时槽位,作为 T14 断言对象)', () => {
    const fake = createFakeClient();
    renderView(fake);

    // 面板与各耗时槽位在挂载即存在(未出结果时显示占位)。
    expect(screen.getByTestId('metrics-panel')).toBeInTheDocument();
    expect(screen.getByTestId('render-elapsed')).toBeInTheDocument();
    expect(screen.getByTestId('worker-elapsed')).toBeInTheDocument();
    expect(screen.getByTestId('main-longtask')).toBeInTheDocument();
  });

  it('DoD3:出结果后展示 Worker 转换耗时与原始点数(转换在 Worker 完成的证据)', () => {
    const fake = createFakeClient();
    renderView(fake);

    act(() => {
      fake.emit(resultReceipt(fake.execId, 5, 123.4));
    });

    // meta.elapsedMs 来自 Worker 回执 —— 主线程未做转换,仅显示其耗时。
    expect(screen.getByTestId('worker-elapsed').textContent).toContain('123.4');
    expect(screen.getByTestId('raw-point-count').textContent).toBe('5');
  });
});
