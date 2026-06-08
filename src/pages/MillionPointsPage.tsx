// million-points raw 演示页(T12)。ADR-0004:raw 是受控例外,只在本页使用。
// 契约 §7 性能预算的标的:raw 1M 点 Worker 转换 ≤500ms、首帧渲染 ≤1000ms、主线程长任务 ≤50ms。
//
// 职责边界(CLAUDE.md 硬约束 3/4):本页不做任何数据加工——只下发 raw 查询指令、
// 消费 Worker 回执的列式帧、把耗时显示出来。fetch/解析/列式化全在 Worker(architecture.md §4)。
// 自显的渲染耗时是 T14 MCP 断言对象。

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { createLineChartOptions, TimeSeriesChart } from '../charts';
import {
  createColumnarStore,
  createWorkerClient,
  DataLayerProvider,
  useMetricQuery,
} from '../data';
import type { DataLayer, MetricQuerySpec } from '../data';
import { PERF_BUDGET } from '../contract';
import {
  MILLION_END_MILLIS,
  MILLION_POINT_COUNT,
  MILLION_SELECTOR,
  MILLION_START_MILLIS,
} from '../worker/million-dataset';

/**
 * raw 查询规格(模块常量,引用稳定)。刻意 **不带** stepMillis(raw 模式)、
 * **不带** downsample(无 LTTB)——这正是 DoD「数据路径为 raw」的断言对象。
 */
export const RAW_SPEC: MetricQuerySpec = {
  selector: MILLION_SELECTOR,
  startMillis: MILLION_START_MILLIS,
  endMillis: MILLION_END_MILLIS,
};

const CHART_WIDTH = 1200;
const CHART_HEIGHT = 440;

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : `${ms.toFixed(1)} ms`;
}

function fmtCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('en-US');
}

interface MetricRowProps {
  testId: string;
  label: string;
  value: string;
  budget?: string;
  overBudget?: boolean;
}

function MetricRow({ testId, label, value, budget, overBudget }: MetricRowProps): ReactElement {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
      <span style={{ width: 220, color: '#475569' }}>{label}</span>
      <span data-testid={testId} style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
        {value}
      </span>
      {budget !== undefined && (
        <span style={{ color: overBudget ? '#dc2626' : '#16a34a' }}>
          预算 {budget}
          {overBudget ? ' ✗ 超预算' : ''}
        </span>
      )}
    </div>
  );
}

/**
 * 演示页内层(可独立测试:注入假 DataLayer 即可断言查询指令与耗时面板)。
 * 自身只读 useMetricQuery 三态 + meta,渲染图表与耗时面板。
 */
export function MillionPointsView(): ReactElement {
  const { loading, error, data, meta } = useMetricQuery(RAW_SPEC);

  // options 引用稳定:仅在 uPlot 实例创建时消费一次(uplot-react skill / charts CLAUDE.md 规则 6)。
  const options = useMemo(
    () =>
      createLineChartOptions({
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        series: [{ label: 'demo_raw_signal{source="million"}', stroke: '#2563eb' }],
      }),
    [],
  );

  // 首帧渲染耗时(setData→paint 代理):data 首次到达即记起点(render 内,先于子组件 commit/setData),
  // 双 rAF 后量到 paint 完成。含 uPlot 首次构造 + 绘制的开销。
  const renderStartRef = useRef<number | null>(null);
  if (data && renderStartRef.current === null) {
    renderStartRef.current = performance.now();
  }
  const [firstPaintMs, setFirstPaintMs] = useState<number | null>(null);

  useEffect(() => {
    const startedAt = renderStartRef.current;
    if (!data || startedAt === null || firstPaintMs !== null) {
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setFirstPaintMs(performance.now() - startedAt);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) {
        cancelAnimationFrame(raf2);
      }
    };
  }, [data, firstPaintMs]);

  // 主线程长任务观测:转换在 Worker,主线程应无 >50ms 长任务(契约 §7 运行时证据)。
  // longtask API 在浏览器可用;jsdom/旧环境无则降级为不可观测(显示 —),不影响其它断言。
  const [maxLongTaskMs, setMaxLongTaskMs] = useState<number | null>(null);
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') {
      return;
    }
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        setMaxLongTaskMs((prev) => (prev === null ? entry.duration : Math.max(prev, entry.duration)));
      }
    });
    try {
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      return;
    }
    return () => observer.disconnect();
  }, []);

  const workerMs = meta?.elapsedMs ?? null;
  const rawPoints = meta?.rawPointCount ?? null;

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: CHART_WIDTH + 48 }}>
      <h1 style={{ marginBottom: 4 }}>百万点 raw 渲染演示</h1>
      <p style={{ color: '#64748b', marginTop: 0 }}>
        raw 查询(无 step、无 LTTB,ADR-0004 受控例外)取回约 {MILLION_POINT_COUNT.toLocaleString('en-US')}{' '}
        点;解析与列式化全在 Worker,主线程只 setData。
      </p>

      <section
        data-testid="metrics-panel"
        style={{
          display: 'grid',
          gap: 8,
          padding: 16,
          margin: '16px 0',
          border: '1px solid #e2e8f0',
          borderRadius: 8,
          background: '#f8fafc',
        }}
      >
        <MetricRow testId="query-mode" label="查询模式" value="raw(无 step / 无 LTTB)" />
        <MetricRow testId="raw-point-count" label="原始点数(Worker 回执)" value={fmtCount(rawPoints)} />
        <MetricRow
          testId="worker-elapsed"
          label="Worker 转换耗时"
          value={fmtMs(workerMs)}
          budget={`≤ ${PERF_BUDGET.rawMillionTransformMs} ms`}
          overBudget={workerMs !== null && workerMs > PERF_BUDGET.rawMillionTransformMs}
        />
        <MetricRow
          testId="render-elapsed"
          label="首帧渲染(setData→paint)"
          value={fmtMs(firstPaintMs)}
          budget={`≤ ${PERF_BUDGET.rawMillionFirstPaintMs} ms`}
          overBudget={firstPaintMs !== null && firstPaintMs > PERF_BUDGET.rawMillionFirstPaintMs}
        />
        <MetricRow
          testId="main-longtask"
          label="主线程最长任务"
          value={fmtMs(maxLongTaskMs)}
          budget={`≤ ${PERF_BUDGET.mainThreadLongTaskMs} ms`}
          overBudget={maxLongTaskMs !== null && maxLongTaskMs > PERF_BUDGET.mainThreadLongTaskMs}
        />
      </section>

      <div data-testid="chart-status" style={{ minHeight: CHART_HEIGHT }}>
        {error ? (
          <p style={{ color: '#dc2626' }} role="alert">
            查询失败({error.kind}):{error.message}
          </p>
        ) : data ? (
          <TimeSeriesChart frame={data} options={options} />
        ) : (
          <p style={{ color: '#64748b' }}>{loading ? '加载百万点中…' : '无数据'}</p>
        )}
      </div>
    </main>
  );
}

/**
 * 演示页外层:创建 Worker + QueryClient + ColumnarStore 并经 Provider 注入。
 * Worker 在 effect 内创建(StrictMode 安全:卸载即 terminate,重挂载重建),
 * fetch/解析只发生在该 Worker 内(CLAUDE.md 硬约束 4)。
 */
export function MillionPointsPage(): ReactElement {
  const [layer, setLayer] = useState<DataLayer | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' });
    setLayer({ client: createWorkerClient(worker), store: createColumnarStore() });
    return () => {
      worker.terminate();
      setLayer(null);
    };
  }, []);

  if (!layer) {
    return <p style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>初始化 Worker…</p>;
  }

  return (
    <DataLayerProvider value={layer}>
      <MillionPointsView />
    </DataLayerProvider>
  );
}
