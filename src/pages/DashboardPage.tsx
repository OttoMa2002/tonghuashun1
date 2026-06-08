// dashboard 多面板视图(T11)。architecture.md §2、§5.4;契约 §7 stepped 端到端预算。
//
// 范围:多面板 stepped 查询视图——gauge 直读 + counter rate 各一面板,轮询驱动,
// 错误态/加载态可见。职责边界(硬约束 3/4):本页不做任何数据加工,也不自起 setInterval——
// 节奏全权交给调度器(usePolledQuery → createPoller),fetch/解析/rate 全在 Worker。

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import { createLineChartOptions, TimeSeriesChart } from '../charts';
import type uPlot from 'uplot';
import {
  createColumnarStore,
  createWorkerClient,
  DataLayerProvider,
} from '../data';
import type { DataLayer } from '../data';
import {
  DASHBOARD_COUNTER_SELECTOR,
  DASHBOARD_END_MILLIS,
  DASHBOARD_GAUGE_SELECTOR,
  DASHBOARD_RATE_WINDOW_MILLIS,
  DASHBOARD_START_MILLIS,
  DASHBOARD_STEP_MILLIS,
} from '../worker/dashboard-dataset';

import { usePolledQuery } from './usePolledQuery';
import type { PolledQuerySpec, PolledQueryState } from './usePolledQuery';

const CHART_WIDTH = 880;
const CHART_HEIGHT = 280;

/**
 * gauge 直读面板规格(模块常量,引用稳定):stepped 查询、无 rate(§3 直读)。
 */
export const GAUGE_PANEL_SPEC: PolledQuerySpec = {
  selector: DASHBOARD_GAUGE_SELECTOR,
  startMillis: DASHBOARD_START_MILLIS,
  endMillis: DASHBOARD_END_MILLIS,
  stepMillis: DASHBOARD_STEP_MILLIS,
};

/**
 * counter rate 面板规格:stepped + rate 窗口。rate 在 Worker 内按栅格逐点求值(ADR-0010);
 * 带 rate 必带 stepMillis(否则 Worker 回 bad_request,契约 §5)。
 */
export const RATE_PANEL_SPEC: PolledQuerySpec = {
  selector: DASHBOARD_COUNTER_SELECTOR,
  startMillis: DASHBOARD_START_MILLIS,
  endMillis: DASHBOARD_END_MILLIS,
  stepMillis: DASHBOARD_STEP_MILLIS,
  rate: { windowMillis: DASHBOARD_RATE_WINDOW_MILLIS },
};

interface PanelProps {
  testId: string;
  title: string;
  subtitle: string;
  state: PolledQueryState;
  options: uPlot.Options;
}

/**
 * 单面板:统一呈现加载/错误/数据三态(DoD:错误态/加载态可见)。
 * 错误优先于(可能陈旧的)数据展示——故障期显式提示;成功回执清错后图表恢复(自愈)。
 */
function Panel({ testId, title, subtitle, state, options }: PanelProps): ReactElement {
  return (
    <section
      data-testid={testId}
      style={{
        padding: 16,
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        background: '#fff',
      }}
    >
      <h2 style={{ margin: '0 0 2px', fontSize: 16 }}>{title}</h2>
      <p style={{ margin: '0 0 12px', color: '#64748b', fontSize: 13 }}>{subtitle}</p>
      <div data-testid={`${testId}-body`} style={{ minHeight: CHART_HEIGHT }}>
        {state.error ? (
          <p data-testid={`${testId}-error`} role="alert" style={{ color: '#dc2626' }}>
            查询失败({state.error.kind}):{state.error.message}
          </p>
        ) : state.data ? (
          <TimeSeriesChart frame={state.data} options={options} />
        ) : (
          <p data-testid={`${testId}-placeholder`} style={{ color: '#64748b' }}>
            {state.loading ? '加载中…' : '无数据'}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * 仪表盘内层(可独立测试:注入假 DataLayer 即可断言轮询指令与三态)。
 * 两个面板各自 usePolledQuery,节奏由调度器驱动;本组件不持有任何定时器。
 */
export function DashboardView(): ReactElement {
  const gaugeState = usePolledQuery(GAUGE_PANEL_SPEC);
  const rateState = usePolledQuery(RATE_PANEL_SPEC);

  // options 引用稳定:仅在 uPlot 实例创建时消费一次(charts CLAUDE.md 规则 6)。
  const gaugeOptions = useMemo(
    () =>
      createLineChartOptions({
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        series: [{ label: 'node_cpu_percent{job="api"}', stroke: '#2563eb' }],
      }),
    [],
  );
  const rateOptions = useMemo(
    () =>
      createLineChartOptions({
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        series: [{ label: 'rate(http_requests_total{job="api"}) /s', stroke: '#16a34a' }],
      }),
    [],
  );

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: CHART_WIDTH + 48 }}>
      <h1 style={{ marginBottom: 4 }}>指标仪表盘</h1>
      <p style={{ color: '#64748b', marginTop: 0 }}>
        多面板 stepped 视图(step {DASHBOARD_STEP_MILLIS / 1000}s),轮询驱动(scrape_interval 对齐、
        失败退避、隐藏暂停);gauge 直读 + counter rate 各一面板,数据加工全在 Worker。
      </p>

      <div style={{ display: 'grid', gap: 16 }}>
        <Panel
          testId="panel-gauge"
          title="gauge 直读:node_cpu_percent"
          subtitle="stepped 查询,直读绘制(§3)"
          state={gaugeState}
          options={gaugeOptions}
        />
        <Panel
          testId="panel-rate"
          title="counter rate:rate(http_requests_total)"
          subtitle={`stepped + ${DASHBOARD_RATE_WINDOW_MILLIS / 1000}s rate 窗口,Worker 内逐栅格求值(ADR-0010)`}
          state={rateState}
          options={rateOptions}
        />
      </div>
    </main>
  );
}

/**
 * 仪表盘外层:创建 Worker + QueryClient + ColumnarStore 并经 Provider 注入
 * (镜像 MillionPointsPage 的 StrictMode 安全装配:卸载即 terminate,重挂载重建)。
 * fetch/解析只发生在该 Worker 内(硬约束 4)。
 */
export function DashboardPage(): ReactElement {
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
      <DashboardView />
    </DataLayerProvider>
  );
}
