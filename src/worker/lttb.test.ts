// LTTB 单测(T06 DoD):输出点数 = 目标点数;首末点保留;单调时间戳保持。
// 另覆盖边界:target>=n 不上采样、target=2 仅首末、长度不一致/非法 target 抛错、
// NaN 缺点不污染选择且仍单调(§6 哨兵兜底)、下标严格递增。

import { describe, expect, it } from 'vitest';

import { LttbInputError, lttb, lttbIndices } from './lttb';

function ramp(n: number): { xs: Float64Array; ys: Float64Array } {
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = i * 1000; // 严格递增 tsMillis
    ys[i] = Math.sin(i / 7) * 50 + i * 0.1; // 带峰谷的趋势
  }
  return { xs, ys };
}

function isStrictlyIncreasing(xs: Float64Array): boolean {
  for (let i = 1; i < xs.length; i++) {
    if (!(xs[i] > xs[i - 1])) {
      return false;
    }
  }
  return true;
}

describe('lttb', () => {
  it('输出点数等于目标点数(DoD)', () => {
    const { xs, ys } = ramp(1000);
    const out = lttb(xs, ys, 100);
    expect(out.xs.length).toBe(100);
    expect(out.ys.length).toBe(100);
  });

  it('首末点保留(DoD)', () => {
    const { xs, ys } = ramp(1000);
    const out = lttb(xs, ys, 50);
    expect(out.xs[0]).toBe(xs[0]);
    expect(out.ys[0]).toBe(ys[0]);
    expect(out.xs[out.xs.length - 1]).toBe(xs[xs.length - 1]);
    expect(out.ys[out.ys.length - 1]).toBe(ys[ys.length - 1]);
  });

  it('单调时间戳保持(DoD):输出 xs 严格递增', () => {
    const { xs, ys } = ramp(5000);
    const out = lttb(xs, ys, 200);
    expect(isStrictlyIncreasing(out.xs)).toBe(true);
  });

  it('targetPoints >= 输入长度:不上采样,全量返回', () => {
    const { xs, ys } = ramp(10);
    const out = lttb(xs, ys, 20);
    expect(out.xs.length).toBe(10);
    expect(Array.from(out.xs)).toEqual(Array.from(xs));
    expect(Array.from(out.ys)).toEqual(Array.from(ys));
  });

  it('target === 2:仅首末两锚点', () => {
    const { xs, ys } = ramp(1000);
    const out = lttb(xs, ys, 2);
    expect(out.xs.length).toBe(2);
    expect(out.xs[0]).toBe(xs[0]);
    expect(out.xs[1]).toBe(xs[xs.length - 1]);
  });

  it('xs/ys 长度不一致 → 抛 LttbInputError', () => {
    expect(() => lttb(new Float64Array(5), new Float64Array(4), 3)).toThrow(LttbInputError);
  });

  it('targetPoints < 2 或非整数 → 抛 LttbInputError(需保留首末两锚点)', () => {
    const { xs, ys } = ramp(100);
    expect(() => lttb(xs, ys, 1)).toThrow(LttbInputError);
    expect(() => lttb(xs, ys, 0)).toThrow(LttbInputError);
    expect(() => lttb(xs, ys, 2.5)).toThrow(LttbInputError);
  });

  it('NaN 缺点(§6 哨兵)不破坏单调性,且不被优先选为锚点', () => {
    const { xs, ys } = ramp(1000);
    // 注入若干 NaN 缺点。
    for (let i = 100; i < 200; i++) {
      ys[i] = NaN;
    }
    const out = lttb(xs, ys, 80);
    expect(out.xs.length).toBe(80);
    expect(isStrictlyIncreasing(out.xs)).toBe(true);
    // 首末点是有限值,锚点未被 NaN 污染。
    expect(Number.isFinite(out.ys[0])).toBe(true);
    expect(Number.isFinite(out.ys[out.ys.length - 1])).toBe(true);
  });

  it('lttbIndices 返回严格递增下标,含首末下标', () => {
    const { xs, ys } = ramp(2000);
    const idx = lttbIndices(xs, ys, 100);
    expect(idx.length).toBe(100);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(1999);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }
  });

  it('保留视觉极值:尖峰所在下标会被选中', () => {
    const n = 1000;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = i;
      ys[i] = 1;
    }
    ys[500] = 1000; // 单一尖峰
    const idx = Array.from(lttbIndices(xs, ys, 50));
    expect(idx).toContain(500);
  });
});
