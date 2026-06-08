// dashboard 演示数据集(T11)。供多面板 stepped 视图取数:一条 counter(rate 面板)+
// 一条 gauge(直读面板),architecture.md §2、§5.4。
//
// 本模块是「无副作用」叶子:只导出常量与一个纯构造函数,不触碰 self/postMessage,
// 故可同时被 Worker 入口(构建数据集)与 pages 仪表盘(取查询窗口/选择器)安全 import——
// 后者只引常量,主线程不会执行 buildDashboardDataset。依赖方向 worker → mock(architecture.md §4)。
//
// 设计:固定 1h 栅格、step=15s(对齐 scrape_interval,§5.2);counter 用于 rate 面板,
// gauge 用于直读面板。数据集在查询窗口前预滚 RATE_WINDOW_MILLIS,使首个栅格点的 trailing
// rate 窗口即有完整样本(契约 §3:窗口内 <2 样本 → NaN),避免起点出现无意义间隙。

import { generateSeries } from '../mock/generator';
import type { GeneratedSeries } from '../mock/generator';

import type { Selector } from '../contract';

/** 固定锚点(2023-11-14T22:13:20Z),不依赖 Date.now,使数据集与查询窗口确定可复现。 */
export const DASHBOARD_START_MILLIS = 1_700_000_000_000;
/** 查询窗口跨度:1 小时。 */
export const DASHBOARD_WINDOW_MILLIS = 3_600_000;
export const DASHBOARD_END_MILLIS = DASHBOARD_START_MILLIS + DASHBOARD_WINDOW_MILLIS;
/** 评估步长:15s,对齐默认 scrape_interval(§5.2、契约 §7)。1h ÷ 15s = 240 点。 */
export const DASHBOARD_STEP_MILLIS = 15_000;
/** counter rate 的 trailing 窗口:60s(§3 栅格 rate)。 */
export const DASHBOARD_RATE_WINDOW_MILLIS = 60_000;

/** 共享 label:两条序列同属一个 job,选择器以 name 区分指标。 */
const DASHBOARD_LABELS = { job: 'api' } as const;

/** counter 面板选择器:rate(http_requests_total)。仅 counter,经 rate 管线(ADR-0010)。 */
export const DASHBOARD_COUNTER_SELECTOR: Selector = {
  name: 'http_requests_total',
  labels: { ...DASHBOARD_LABELS },
};

/** gauge 面板选择器:node_cpu_percent,直读绘制(§3)。 */
export const DASHBOARD_GAUGE_SELECTOR: Selector = {
  name: 'node_cpu_percent',
  labels: { ...DASHBOARD_LABELS },
};

/**
 * 构造 dashboard 数据集(纯函数,Worker 入口在启动时调用一次)。
 * 种子固定 → 同一会话内逐点可复现(src/mock/CLAUDE.md 规则 3)。
 * 栅格自查询窗口前预滚一个 rate 窗口,使首个栅格点即有完整 trailing 窗口。
 */
export function buildDashboardDataset(seed = 7): GeneratedSeries[] {
  const grid = {
    startMillis: DASHBOARD_START_MILLIS - DASHBOARD_RATE_WINDOW_MILLIS,
    endMillis: DASHBOARD_END_MILLIS,
    stepMillis: DASHBOARD_STEP_MILLIS,
  };
  const counter = generateSeries(
    {
      name: DASHBOARD_COUNTER_SELECTOR.name,
      type: 'counter',
      labelSets: [{ ...DASHBOARD_LABELS }],
      stepIncrement: [5, 25],
    },
    grid,
    seed,
  );
  const gauge = generateSeries(
    {
      name: DASHBOARD_GAUGE_SELECTOR.name,
      type: 'gauge',
      labelSets: [{ ...DASHBOARD_LABELS }],
      valueRange: [10, 90],
    },
    grid,
    seed + 1,
  );
  return [...counter, ...gauge];
}
