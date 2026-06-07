// 数据契约 §5:Worker 消息协议。与 docs/data-contract.md §5 一一对应。

import type { ColumnarFrame } from './columnar';
import type { Selector } from './query';

/** 信封:id 由发送方生成,回执原样携带(§5)。 */
export interface Envelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  payload: TPayload;
}

// —— 主线程 → Worker ——

export interface QueryExecPayload {
  queryId: string;
  selector: Selector;
  startMillis: number;
  endMillis: number;
  /** 省略 = raw 模式。 */
  stepMillis?: number;
  /** 渲染级降采样目标点数(LTTB,仅 Worker 内执行,ADR-0004)。 */
  downsample?: { targetPoints: number };
}

export interface QueryCancelPayload {
  queryId: string;
}

export type QueryExecMessage = Envelope<'query.exec', QueryExecPayload>;
export type QueryCancelMessage = Envelope<'query.cancel', QueryCancelPayload>;
export type MainToWorkerMessage = QueryExecMessage | QueryCancelMessage;

// —— Worker → 主线程 ——

export interface QueryResultPayload {
  queryId: string;
  frame: ColumnarFrame;
  meta: {
    rawPointCount: number;
    downsampledTo?: number;
    elapsedMs: number;
  };
}

/** 回执错误种类(§5)。乱序等解析违例归 'parse'(§4)。 */
export type QueryErrorKind = 'timeout' | 'http' | 'parse' | 'aborted';

export interface QueryErrorPayload {
  queryId: string;
  kind: QueryErrorKind;
  message: string;
}

export type QueryResultMessage = Envelope<'query.result', QueryResultPayload>;
export type QueryErrorMessage = Envelope<'query.error', QueryErrorPayload>;
export type WorkerToMainMessage = QueryResultMessage | QueryErrorMessage;

/**
 * 回执 = result 或 error(§5 回执定义)。
 * 调度器 in-flight 去重以「该 queryId 未收到回执」为判定,不设单独 ack。
 */
export type QueryReceipt = QueryResultMessage | QueryErrorMessage;
