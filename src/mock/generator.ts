// 时序生成器(T02)。语义以 docs/data-contract.md §1、§3 为准:
//  - counter 单调不减(§3),gauge 在配置区间内(§3)
//  - timestamp 为 Unix 毫秒整数(§1)
// src/mock/CLAUDE.md:只依赖 src/contract;确定性走可种子化 PRNG;不提供旁路输出格式。
// 本层是纯数据生成层,故障注入(T04)将包裹本层而不改其输出。

import type { LabelSet, Metric, Sample } from '../contract';
import { seriesKey } from '../contract';

import { createPrng, hashSeed } from './prng';

/** 生成时间栅格:[startMillis, endMillis] 内以 stepMillis 等距取点(§1 单位为 ms)。 */
export interface GenGrid {
  startMillis: number;
  endMillis: number;
  /** 取点间隔(ms),须 > 0。 */
  stepMillis: number;
}

/** counter 生成参数:从 startValue 起,每步加一个 [min,max] 内的非负增量,保证单调不减(§3)。 */
export interface CounterSpec {
  name: string;
  type: 'counter';
  /** 每个 labelSet 生成一条独立序列。 */
  labelSets: LabelSet[];
  /** 初始值,默认 0。 */
  startValue?: number;
  /** 每步增量区间 [min,max],要求 0 <= min <= max(min<0 会破坏单调)。 */
  stepIncrement: readonly [number, number];
}

/** gauge 生成参数:每点在 [min,max] 内独立取值(§3 直读,须落在配置区间)。 */
export interface GaugeSpec {
  name: string;
  type: 'gauge';
  labelSets: LabelSet[];
  /** 取值区间 [min,max],要求 min <= max。 */
  valueRange: readonly [number, number];
}

export type MetricSpec = CounterSpec | GaugeSpec;

/** 生成的单条序列:契约 Metric 元信息 + 栅格上的样本序列。 */
export interface GeneratedSeries {
  metric: Metric;
  /** 时间升序、tsMillis 唯一(栅格直出)。 */
  samples: Sample[];
}

/** 返回栅格评估时刻:startMillis + k*stepMillis,k=0..floor((end-start)/step)。 */
function gridTimestamps(grid: GenGrid): number[] {
  const { startMillis, endMillis, stepMillis } = grid;
  if (!Number.isInteger(startMillis) || !Number.isInteger(endMillis) || !Number.isInteger(stepMillis)) {
    throw new RangeError('GenGrid 的时间参数必须为整数毫秒(§1)');
  }
  if (stepMillis <= 0) {
    throw new RangeError('GenGrid.stepMillis 必须 > 0');
  }
  if (startMillis > endMillis) {
    throw new RangeError('GenGrid 要求 startMillis <= endMillis');
  }
  const count = Math.floor((endMillis - startMillis) / stepMillis) + 1;
  const out = new Array<number>(count);
  for (let k = 0; k < count; k++) {
    out[k] = startMillis + k * stepMillis;
  }
  return out;
}

function generateCounter(spec: CounterSpec, grid: GenGrid, seed: number): GeneratedSeries[] {
  const [incMin, incMax] = spec.stepIncrement;
  if (!(incMin >= 0)) {
    throw new RangeError('counter 增量下界须 >= 0,否则破坏单调不减(§3)');
  }
  if (incMin > incMax) {
    throw new RangeError('counter stepIncrement 要求 min <= max');
  }
  const start = spec.startValue ?? 0;
  const ts = gridTimestamps(grid);

  return spec.labelSets.map((labels) => {
    const key = seriesKey(spec.name, labels);
    const prng = createPrng(hashSeed(seed, key));
    let value = start;
    const samples: Sample[] = ts.map((t, i) => {
      // 首点取初始值,其后逐步累加非负增量 → 单调不减。
      if (i > 0) {
        value += incMin + prng.next() * (incMax - incMin);
      }
      return [t, value] as const;
    });
    return { metric: { name: spec.name, type: 'counter', labels }, samples };
  });
}

function generateGauge(spec: GaugeSpec, grid: GenGrid, seed: number): GeneratedSeries[] {
  const [min, max] = spec.valueRange;
  if (min > max) {
    throw new RangeError('gauge valueRange 要求 min <= max');
  }
  const span = max - min;
  const ts = gridTimestamps(grid);

  return spec.labelSets.map((labels) => {
    const key = seriesKey(spec.name, labels);
    const prng = createPrng(hashSeed(seed, key));
    const samples: Sample[] = ts.map((t) => [t, min + prng.next() * span] as const);
    return { metric: { name: spec.name, type: 'gauge', labels }, samples };
  });
}

/**
 * 按 spec 在栅格上生成序列。每个 labelSet 一条序列,顺序与输入一致。
 * 确定性:每序列的随机流由 hashSeed(seed, seriesKey) 派生,
 * 故同 seed 两次调用逐点相等,且与 labelSets 顺序无关。
 */
export function generateSeries(spec: MetricSpec, grid: GenGrid, seed: number): GeneratedSeries[] {
  return spec.type === 'counter'
    ? generateCounter(spec, grid, seed)
    : generateGauge(spec, grid, seed);
}
