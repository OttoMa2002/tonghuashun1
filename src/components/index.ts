// src/components 公共出口:虚拟滚动指标表格(T13)。
// architecture.md §4 依赖方向:components 仅被 pages 消费,自身依赖 charts/data/contract。

export type { MetricTableRow, MetricTableProps } from './MetricTable';
export { MetricTable } from './MetricTable';

export { columnarToMetricRows } from './metricRows';
