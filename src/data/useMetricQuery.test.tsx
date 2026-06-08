import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

import type {
  ColumnarFrame,
  QueryErrorMessage,
  QueryExecPayload,
  QueryReceipt,
  QueryResultMessage,
} from '../contract';

import { DataLayerProvider } from './context';
import { createColumnarStore } from './store';
import type { QueryClient } from './queryClient';
import { useMetricQuery } from './useMetricQuery';
import type { MetricQuerySpec } from './useMetricQuery';

/** 假 client:记录最近一次 exec 的 envelope id,并允许测试手动向订阅者投递回执。 */
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
  const ts = Float64Array.from({ length }, (_v, i) => i);
  return { ts, series: [{ key: 'up', name: 'up', labels: {}, values: ts.slice() }] };
}

function resultReceipt(id: string, f: ColumnarFrame): QueryResultMessage {
  return {
    id,
    type: 'query.result',
    payload: { queryId: 'qid', frame: f, meta: { rawPointCount: f.ts.length, elapsedMs: 1 } },
  };
}

function errorReceipt(id: string): QueryErrorMessage {
  return { id, type: 'query.error', payload: { queryId: 'qid', kind: 'http', message: 'boom' } };
}

const SPEC: MetricQuerySpec = {
  selector: { name: 'up', labels: {} },
  startMillis: 0,
  endMillis: 1000,
  stepMillis: 100,
};

function Probe({ spec }: { spec: MetricQuerySpec }): ReactElement {
  const { loading, error, data } = useMetricQuery(spec);
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ? error.kind : 'none'}</span>
      <span data-testid="data">{data ? String(data.ts.length) : 'none'}</span>
    </div>
  );
}

function renderProbe(fake: ReturnType<typeof createFakeClient>) {
  return render(
    <DataLayerProvider value={{ client: fake.client, store: createColumnarStore() }}>
      <Probe spec={SPEC} />
    </DataLayerProvider>,
  );
}

describe('useMetricQuery 三态', () => {
  it('挂载即 loading,并下发携带 queryId 的 query.exec 指令', () => {
    const fake = createFakeClient();
    renderProbe(fake);

    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(screen.getByTestId('data').textContent).toBe('none');
    expect(fake.payload?.selector.name).toBe('up');
    expect(fake.payload?.queryId).toBeTruthy();
  });

  it('收到 query.result → loading 关闭、data 暴露列式帧', () => {
    const fake = createFakeClient();
    renderProbe(fake);

    act(() => {
      fake.emit(resultReceipt(fake.execId, frame(5)));
    });

    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(screen.getByTestId('data').textContent).toBe('5');
  });

  it('收到 query.error → loading 关闭、error 暴露回执', () => {
    const fake = createFakeClient();
    renderProbe(fake);

    act(() => {
      fake.emit(errorReceipt(fake.execId));
    });

    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe('http');
    expect(screen.getByTestId('data').textContent).toBe('none');
  });

  it('忽略 envelope id 不匹配的陈旧回执', () => {
    const fake = createFakeClient();
    renderProbe(fake);

    act(() => {
      fake.emit(resultReceipt('stale-id', frame(9)));
    });

    // 仍处于 loading,未被他人结果污染。
    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('data').textContent).toBe('none');
  });
});
