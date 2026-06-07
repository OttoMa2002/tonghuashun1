// 数据契约 §2:query_range 语义与 matrix 响应。与 docs/data-contract.md §2 一一对应。

import type { LabelSet } from './metric';

/** 选择器:metric name + label 等值匹配(仅支持 =,无正则/PromQL,ADR-0003)。 */
export interface Selector {
  name: string;
  /** 省略或空对象表示仅按 name 匹配。 */
  labels?: LabelSet;
}

/**
 * query_range 参数(§2)。要求 startMillis < endMillis。
 * stepMillis 省略即 raw 模式(返回区间内全部原始样本,仅 million-points 页,ADR-0004)。
 */
export interface QueryRangeParams {
  selector: Selector;
  startMillis: number;
  endMillis: number;
  /** 省略 = raw 模式。 */
  stepMillis?: number;
}

/** matrix 单序列:metric 元信息 + [tsMillis, value] 样本序列。 */
export interface MatrixSeries {
  metric: { name: string; labels: LabelSet };
  /** 每个元组为 [tsMillis, value]。 */
  values: Array<[number, number]>;
}

/** 成功响应(matrix)。matrix 是传输格式,不得离开 Worker(§5)。 */
export interface MatrixResponse {
  status: 'success';
  data: { result: MatrixSeries[] };
}

/** mock 侧错误响应(§2)。 */
export interface ErrorResponse {
  status: 'error';
  errorType: 'timeout' | 'internal' | 'bad_request';
  message: string;
}

export type QueryRangeResponse = MatrixResponse | ErrorResponse;
