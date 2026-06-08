import { describe, it, expect } from 'vitest';

import type { ColumnarFrame } from '../contract';

import { toGappyColumn, toUplotData } from './toUplotData';

function frame(ts: number[], seriesValues: number[][]): ColumnarFrame {
  return {
    ts: Float64Array.from(ts),
    series: seriesValues.map((v, i) => ({
      key: `s${i}`,
      name: `s${i}`,
      labels: {},
      values: Float64Array.from(v),
    })),
  };
}

describe('toGappyColumn', () => {
  it('无 NaN 时原样返回同一 Float64Array(零拷贝)', () => {
    const values = Float64Array.from([1, 2, 3]);
    const out = toGappyColumn(values);
    expect(out).toBe(values); // 引用相等 = 未拷贝
  });

  it('含 NaN 时转 (number|null)[] 并把 NaN 换成 null', () => {
    const values = Float64Array.from([1, NaN, 3]);
    const out = toGappyColumn(values);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([1, null, 3]);
  });

  it('null 是唯一可表达间隙的哨兵(Float64Array 存不了 null,会变 0)', () => {
    // 反证降级路径的必要性:typed array 无法承载 null。
    const coerced = Float64Array.from([1, null as unknown as number, 3]);
    expect(coerced[1]).toBe(0);
  });
});

describe('toUplotData', () => {
  it('输出形如 [ts, ...各序列值],ts 原样透传', () => {
    const f = frame([10, 20, 30], [[1, 2, 3]]);
    const data = toUplotData(f);
    expect(data.length).toBe(2);
    expect(data[0]).toBe(f.ts); // ts 不拷贝、不换算
    expect(data[1]).toEqual(Float64Array.from([1, 2, 3]));
  });

  it('多序列各自独立适配,含 NaN 的序列降级、其余保留 typed', () => {
    const f = frame(
      [10, 20, 30],
      [
        [1, 2, 3],
        [4, NaN, 6],
      ],
    );
    const data = toUplotData(f);
    expect(data.length).toBe(3);
    expect(data[1]).toBe(f.series[0].values); // 无 NaN:零拷贝
    expect(data[2]).toEqual([4, null, 6]); // 含 NaN:降级
  });

  it('不做任何排序/过滤:输出长度与输入逐列一致', () => {
    const f = frame([30, 10, 20], [[3, 1, 2]]);
    const data = toUplotData(f);
    expect(data[0]).toEqual(Float64Array.from([30, 10, 20])); // 顺序原样,不排序
    expect((data[1] as Float64Array).length).toBe(3);
  });
});
