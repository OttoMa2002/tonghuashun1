// src/data 公共出口:列式 store、查询 client、数据层上下文与 useMetricQuery(T08)。
// architecture.md §4 依赖方向:data 仅被 charts/components/pages 消费,自身依赖 worker/mock/contract。

export type { ColumnarStore } from './store';
export { createColumnarStore } from './store';

export type { QueryClient, ReceiptListener } from './queryClient';
export { createWorkerClient } from './queryClient';

export type { DataLayer } from './context';
export { DataLayerProvider, useDataLayer } from './context';

export type { MetricQuerySpec, MetricQueryState } from './useMetricQuery';
export { useMetricQuery } from './useMetricQuery';

export type { Poller, PollerOptions, VisibilitySource } from './poller';
export { createPoller, documentVisibility } from './poller';
