// counter rate 单测(T07 DoD):重置场景、单点窗口、乱序输入各有用例。
// 另覆盖契约 §3 基线(单调 counter 增量求和 / 时长)与长度不一致违例。

import { describe, expect, it } from 'vitest';

import { RateInputError, counterRate } from './rate';

describe('counterRate', () => {
  it('单调 counter:增量之和 / 窗口时长(§3 基线)', () => {
    // 0,10,30,60 累计增量 60,跨 3000ms = 3s → 20/s。
    const ts = Float64Array.of(0, 1000, 2000, 3000);
    const values = Float64Array.of(0, 10, 30, 60);
    expect(counterRate(ts, values)).toBeCloseTo(20, 10);
  });

  it('重置场景:值回落按新值计增量,不产负速率(DoD)', () => {
    // 增量:10-0=10, (重置)5, 15-5=10 → 和=25;时长 3s → 25/3。
    const ts = Float64Array.of(0, 1000, 2000, 3000);
    const values = Float64Array.of(0, 10, 5, 15);
    const r = counterRate(ts, values);
    expect(r).toBeCloseTo(25 / 3, 10);
    expect(r).toBeGreaterThan(0); // 跨重置点不得算出负速率(反例 2)
  });

  it('重置场景:相等值视为正常(增量 0,非重置)', () => {
    // 增量:10-0=10, 10-10=0, 20-10=10 → 和=20;时长 3s。
    const ts = Float64Array.of(0, 1000, 2000, 3000);
    const values = Float64Array.of(0, 10, 10, 20);
    expect(counterRate(ts, values)).toBeCloseTo(20 / 3, 10);
  });

  it('单点窗口:无相邻样本对 → NaN(DoD)', () => {
    const ts = Float64Array.of(5000);
    const values = Float64Array.of(42);
    expect(Number.isNaN(counterRate(ts, values))).toBe(true);
  });

  it('空窗口:NaN', () => {
    expect(Number.isNaN(counterRate(new Float64Array(0), new Float64Array(0)))).toBe(true);
  });

  it('乱序输入:ts 非严格递增 → 抛 RateInputError(DoD)', () => {
    const ts = Float64Array.of(0, 2000, 1000, 3000); // 第三点回退
    const values = Float64Array.of(0, 10, 20, 30);
    expect(() => counterRate(ts, values)).toThrow(RateInputError);
  });

  it('乱序输入:ts 含相等时刻 → 抛 RateInputError(非严格递增)', () => {
    const ts = Float64Array.of(0, 1000, 1000, 2000);
    const values = Float64Array.of(0, 10, 20, 30);
    expect(() => counterRate(ts, values)).toThrow(RateInputError);
  });

  it('长度不一致 → 抛 RateInputError', () => {
    const ts = Float64Array.of(0, 1000, 2000);
    const values = Float64Array.of(0, 10);
    expect(() => counterRate(ts, values)).toThrow(RateInputError);
  });
});
