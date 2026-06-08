/// <reference lib="webworker" />
// Worker 入口(T05)。契约 §5 / src/worker/CLAUDE.md:只用 self,禁 DOM/window/document;
// 出口只有 ColumnarFrame,大数组经 Transferable 移交。本文件是薄胶水,逻辑全在 handler/transform。
//
// 数据源:进程内 mock(MVP,无 HTTP 服务)。此处构建的 dataset 仅为接线占位,
// 具体指标/时窗由后续页面任务(T11/T12)按需配置或替换 source,不属本任务契约。

import { createFaultInjector } from '../mock/fault';
import { generateSeries } from '../mock/generator';
import type { MockDataset } from '../mock/query';

import type { MainToWorkerMessage } from '../contract';

import { createQueryHandler } from './handler';
import { buildMillionDataset } from './million-dataset';
import { createMockMetricTypeResolver, createMockSource } from './source';

// tsconfig 同时含 DOM 与 WebWorker lib,self 的全局类型有歧义;经 unknown 显式窄化为 Worker 作用域。
const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** 接线占位数据集:一条 counter + 一条 gauge,固定种子可复现(占位,非契约)。 */
function buildPlaceholderDataset(): MockDataset {
  const grid = { startMillis: 0, endMillis: 3_600_000, stepMillis: 15_000 };
  const counter = generateSeries(
    { name: 'http_requests_total', type: 'counter', labelSets: [{ job: 'api' }], stepIncrement: [0, 10] },
    grid,
    1,
  );
  const gauge = generateSeries(
    { name: 'process_memory_bytes', type: 'gauge', labelSets: [{ job: 'api' }], valueRange: [0, 1] },
    grid,
    2,
  );
  // million-points 演示(T12):追加一条百万点 gauge 序列,供 raw 整窗查询取回(ADR-0004)。
  return [...counter, ...gauge, ...buildMillionDataset()];
}

const dataset = buildPlaceholderDataset();
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
