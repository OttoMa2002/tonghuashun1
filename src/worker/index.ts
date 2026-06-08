/// <reference lib="webworker" />
// Worker 入口(T05)。契约 §5 / src/worker/CLAUDE.md:只用 self,禁 DOM/window/document;
// 出口只有 ColumnarFrame,大数组经 Transferable 移交。本文件是薄胶水,逻辑全在 handler/transform。
//
// 数据源:进程内 mock(MVP,无 HTTP 服务)。dataset 由各页面任务配置的演示数据集组合而成:
// dashboard(T11)的 counter+gauge,million-points(T12)的百万点 raw 序列,均为无副作用叶子模块。

import { createFaultInjector } from '../mock/fault';
import type { MockDataset } from '../mock/query';

import type { MainToWorkerMessage } from '../contract';

import { buildDashboardDataset } from './dashboard-dataset';
import { createQueryHandler } from './handler';
import { buildMillionDataset } from './million-dataset';
import { createMockMetricTypeResolver, createMockSource } from './source';

// tsconfig 同时含 DOM 与 WebWorker lib,self 的全局类型有歧义;经 unknown 显式窄化为 Worker 作用域。
const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** 进程内演示数据集:dashboard 的 counter+gauge(T11)+ million-points 百万点序列(T12)。 */
function buildDataset(): MockDataset {
  return [...buildDashboardDataset(), ...buildMillionDataset()];
}

const dataset = buildDataset();
const injector = createFaultInjector(dataset);
const source = createMockSource(injector);
// rate 校验需 metric-type:range 数据不带 type,故从同一 dataset 派生 type 解析(ADR-0010)。
const resolveSeriesTypes = createMockMetricTypeResolver(dataset);
const handler = createQueryHandler({
  source,
  resolveSeriesTypes,
  post: (message, transfer) => ctx.postMessage(message, transfer),
});

ctx.onmessage = (event: MessageEvent<MainToWorkerMessage>): void => {
  void handler.handle(event.data);
};
