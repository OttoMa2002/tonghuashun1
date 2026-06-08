// transform 单测(T05 DoD):多 series 时间戳对齐、缺点补 NaN(§6)、乱序排序兜底(§4)、
// 解析违例抛错。断言输出不变量:ts 严格递增、各 values 与 ts 等长。

import { describe, expect, it } from 'vitest';

import type { MatrixResponse } from '../contract';

import { FrameParseError, countRawPoints, matrixToColumnar } from './transform';

function matrix(result: MatrixResponse['data']['result']): MatrixResponse {
  return { status: 'success', data: { result } };
}

function isStrictlyIncreasing(ts: Float64Array): boolean {
  for (let i = 1; i < ts.length; i++) {
    if (!(ts[i] > ts[i - 1])) {
      return false;
    }
  }
  return true;
}

describe('matrixToColumnar', () => {
  it('多 series 对齐到时间戳并集,缺点补 NaN(§6)', () => {
    const frame = matrixToColumnar(
      matrix([
        { metric: { name: 'a', labels: { job: 'x' } }, values: [[0, 0], [10, 1], [20, 2]] },
        { metric: { name: 'b', labels: { job: 'y' } }, values: [[10, 100], [20, 200], [30, 300]] },
      ]),
    );

    // 并集 [0,10,20,30],严格递增。
    expect(Array.from(frame.ts)).toEqual([0, 10, 20, 30]);
    expect(isStrictlyIncreasing(frame.ts)).toBe(true);

    const a = frame.series[0];
    const b = frame.series[1];
    // 每个 series 与 ts 等长。
    expect(a.values.length).toBe(frame.ts.length);
    expect(b.values.length).toBe(frame.ts.length);

    // a 在 ts=30 无样本 → NaN;b 在 ts=0 无样本 → NaN。
    expect(Array.from(a.values.slice(0, 3))).toEqual([0, 1, 2]);
    expect(Number.isNaN(a.values[3])).toBe(true);
    expect(Number.isNaN(b.values[0])).toBe(true);
    expect(Array.from(b.values.slice(1))).toEqual([100, 200, 300]);

    // series 身份用 seriesKey 规范化。
    expect(a.key).toBe('a{job=x}');
    expect(b.key).toBe('b{job=y}');
  });

  it('乱序 values 按 tsMillis 升序排序后列式化,输出严格递增(§4 out_of_order 兜底)', () => {
    const frame = matrixToColumnar(
      matrix([{ metric: { name: 'm', labels: {} }, values: [[20, 2], [0, 0], [30, 3], [10, 1]] }]),
    );

    expect(Array.from(frame.ts)).toEqual([0, 10, 20, 30]);
    expect(isStrictlyIncreasing(frame.ts)).toBe(true);
    // 值随时间戳一并重排,与 ts 对齐。
    expect(Array.from(frame.series[0].values)).toEqual([0, 1, 2, 3]);
  });

  it('同一 series 含重复 tsMillis(排序后相等)→ 抛 FrameParseError,不静默合并(§4)', () => {
    expect(() =>
      matrixToColumnar(matrix([{ metric: { name: 'm', labels: {} }, values: [[0, 1], [10, 2], [0, 9]] }])),
    ).toThrow(FrameParseError);
  });

  it('空 matrix → 空 ts、空 series', () => {
    const frame = matrixToColumnar(matrix([]));
    expect(frame.ts.length).toBe(0);
    expect(frame.series).toEqual([]);
  });

  it('单 series 透传:ts 与值一一对应', () => {
    const frame = matrixToColumnar(
      matrix([{ metric: { name: 'm', labels: { a: '1' } }, values: [[1000, 5], [2000, 6]] }]),
    );
    expect(Array.from(frame.ts)).toEqual([1000, 2000]);
    expect(Array.from(frame.series[0].values)).toEqual([5, 6]);
    expect(frame.ts).toBeInstanceOf(Float64Array);
    expect(frame.series[0].values).toBeInstanceOf(Float64Array);
  });

  it('countRawPoints 求各 series 样本数之和', () => {
    expect(
      countRawPoints(
        matrix([
          { metric: { name: 'a', labels: {} }, values: [[0, 0], [10, 1]] },
          { metric: { name: 'b', labels: {} }, values: [[0, 0], [10, 1], [20, 2]] },
        ]),
      ),
    ).toBe(5);
  });
});
