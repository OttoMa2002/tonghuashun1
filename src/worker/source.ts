// 数据获取 seam(T05)。契约 §5 / CLAUDE.md 硬约束 4:fetch 只在 Worker 内发起,
// MatrixResponse 不得离开 Worker。本 seam 是 Worker 内「取数」的唯一入口。
//
// MVP 现状:数据源是进程内 mock(无 HTTP 服务,ADR-0003 模拟的是 query API 一侧),
// 故 createMockSource 直接调用 mock 层(依赖方向 worker → mock,architecture.md §4)。
// 真实部署时,此处即 `fetch('/api/query_range', { signal })` —— 调用点不变,只换实现。

import type { FaultInjector } from '../mock/fault';

import type { QueryExecPayload, QueryRangeParams, QueryRangeResponse } from '../contract';

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
