// src/contract 公共桶:跨模块唯一类型来源,与 docs/data-contract.md 一一对应。
// 依赖链最末端的公共叶子,mock/worker/data/charts 均从此 import,禁止本地重定义。

export type { MetricType, LabelSet, Metric, Sample } from './metric';
export { seriesKey } from './metric';

export type {
  Selector,
  QueryRangeParams,
  MatrixSeries,
  MatrixResponse,
  ErrorResponse,
  QueryRangeResponse,
} from './query';

export type { ColumnarSeries, ColumnarFrame } from './columnar';

export type {
  Envelope,
  QueryExecPayload,
  QueryCancelPayload,
  QueryExecMessage,
  QueryCancelMessage,
  MainToWorkerMessage,
  QueryResultPayload,
  QueryErrorKind,
  QueryErrorPayload,
  QueryResultMessage,
  QueryErrorMessage,
  WorkerToMainMessage,
  QueryReceipt,
} from './messages';

export {
  LOOKBACK_MILLIS,
  DEFAULT_SCRAPE_INTERVAL_MILLIS,
  BACKOFF_CAP_MILLIS,
  CLIENT_TIMEOUT_MILLIS,
  PERF_BUDGET,
} from './constants';
