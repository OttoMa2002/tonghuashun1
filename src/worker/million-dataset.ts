// million-points 演示数据集(T12)。ADR-0004:raw 是受控例外,仅本演示页使用。
//
// 本模块是「无副作用」叶子:只导出常量与一个纯构造函数,不触碰 self/postMessage,
// 故可同时被 Worker 入口(构建数据集)与 pages 演示页(取查询窗口)安全 import——
// 后者只引常量,主线程不会执行 buildMillionDataset。依赖方向 worker → mock(architecture.md §4)。
//
// 设计:单条 gauge 序列,在固定 1s 栅格上产 1,000,000 点;raw 查询整窗取回即百万点。
// 选 gauge 是为视觉:密集噪声带能直观证明百万点确被渲染(对照 counter 的单调直线)。

import { generateSeries } from '../mock/generator';
import type { GeneratedSeries } from '../mock/generator';

import type { Selector } from '../contract';

/** 演示序列身份:name + labels(seriesKey 规范化由消费侧负责)。 */
export const MILLION_SERIES_NAME = 'demo_raw_signal';
export const MILLION_LABELS = { source: 'million' } as const;

/** 百万点级:1,000,000 点 × 1s 栅格(契约 §7 raw 1M 预算的标的)。 */
export const MILLION_POINT_COUNT = 1_000_000;
export const MILLION_STEP_MILLIS = 1_000;

/** 固定锚点(2023-11-14T22:13:20Z),不依赖 Date.now,使数据集与查询窗口确定可复现。 */
export const MILLION_START_MILLIS = 1_700_000_000_000;
/** 末点时刻:start + (count-1)*step。raw 查询取 [start,end] 闭区间即整条序列(query.ts evaluateRaw)。 */
export const MILLION_END_MILLIS = MILLION_START_MILLIS + (MILLION_POINT_COUNT - 1) * MILLION_STEP_MILLIS;

/** 演示页 raw 查询选择器:按 name + 唯一 label 命中本序列。 */
export const MILLION_SELECTOR: Selector = {
  name: MILLION_SERIES_NAME,
  labels: { ...MILLION_LABELS },
};

/**
 * 构造百万点数据集(纯函数,Worker 入口在启动时调用一次)。
 * 种子固定 → 同一会话内逐点可复现(src/mock/CLAUDE.md 规则 3)。
 */
export function buildMillionDataset(seed = 42): GeneratedSeries[] {
  return generateSeries(
    {
      name: MILLION_SERIES_NAME,
      type: 'gauge',
      labelSets: [{ ...MILLION_LABELS }],
      valueRange: [0, 100],
    },
    { startMillis: MILLION_START_MILLIS, endMillis: MILLION_END_MILLIS, stepMillis: MILLION_STEP_MILLIS },
    seed,
  );
}
