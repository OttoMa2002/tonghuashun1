// 数据获取 seam(T05)。契约 §5 / CLAUDE.md 硬约束 4:fetch 只在 Worker 内发起,
// MatrixResponse 不得离开 Worker。本 seam 是 Worker 内「取数」的唯一入口。
//
// MVP 现状:数据源是进程内 mock(无 HTTP 服务,ADR-0003 模拟的是 query API 一侧),
// 故 createMockSource 直接调用 mock 层(依赖方向 worker → mock,architecture.md §4)。
// 真实部署时,此处即 `fetch('/api/query_range', { signal })` —— 调用点不变,只换实现。

import type { FaultInjector } from '../mock/fault';
import { seriesMatchesSelector, type MockDataset } from '../mock/query';

import type { MetricType, QueryExecPayload, QueryRangeParams, QueryRangeResponse, Selector } from '../contract';

/**
 * 取数函数:给定查询指令(+ 取消信号)返回 MatrixResponse / ErrorResponse。
 * 注入式以便测试替身与后续任务(T08/T09)替换实现;Worker 入口绑定默认 mock 实现。
 */
export type QuerySource = (payload: QueryExecPayload, signal: AbortSignal) => Promise<QueryRangeResponse>;

/** QueryExecPayload → mock 的 QueryRangeParams(只取查询语义字段,不含降采样/queryId)。 */
function toQueryRangeParams(payload: QueryExecPayload): QueryRangeParams {
  return {
    selector: payload.selector,
    startMillis: payload.startMillis,
    endMillis: payload.endMillis,
    stepMillis: payload.stepMillis,
  };
}

/**
 * 进程内 mock 取数实现。FaultInjector 已封装 dataset + 故障注入,错误一律以
 * ErrorResponse 回执(绝不抛出);本 source 因此也不抛错,signal 仅用于上层判定取消。
 */
export function createMockSource(injector: FaultInjector): QuerySource {
  return (payload) => injector.query(toQueryRangeParams(payload));
}

/**
 * Metric-type 解析 seam(ADR-0010):返回 selector 命中的各序列声明类型。
 *
 * 为什么需要独立 seam:range 查询的 MatrixResponse(契约 §2)刻意不携带 type(忠实 Prometheus
 * range query 线格式),而 rate 校验「命中非 counter → bad_request」需要类型元数据。类型是独立于
 * range 数据的元信息(对照 Prometheus 的 /api/v1/metadata),故以独立 seam 暴露,不污染 MatrixResponse。
 * 求值仍只发生在 Worker(CLAUDE.md 硬约束 3);MVP 由进程内 dataset 直读,真实部署即换为 metadata 取数。
 */
export type MetricTypeResolver = (selector: Selector) => MetricType[];

/** 进程内 mock 的 metric-type 解析:复用 mock 的选择器匹配语义,读取声明类型(GeneratedSeries.metric.type)。 */
export function createMockMetricTypeResolver(dataset: MockDataset): MetricTypeResolver {
  return (selector) =>
    dataset.filter((series) => seriesMatchesSelector(series, selector)).map((series) => series.metric.type);
}
