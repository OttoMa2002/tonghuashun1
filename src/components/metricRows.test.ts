import { describe, it, expect } from 'vitest';

import type { ColumnarFrame } from '../contract';

import { columnarToMetricRows } from './metricRows';

function frame(): ColumnarFrame {
  return {
    ts: Float64Array.from([1000, 2000, 3000]),
    series: [
      { key: 'up{job="a"}', name: 'up', labels: { job: 'a' }, values: Float64Array.from([1, 1, 1]) },
      // 末尾为 NaN:当前值应回退到最后一个非 NaN(2)。
      { key: 'lat{job="b"}', name: 'lat', labels: { job: 'b' }, values: Float64Array.from([0, 2, NaN]) },
      // 全 NaN:当前值为 NaN。
      { key: 'gone', name: 'gone', labels: {}, values: Float64Array.from([NaN, NaN, NaN]) },
    ],
  };
}

describe('columnarToMetricRows', () => {
  it('每条序列投影为一行,保留 key/name/labels', () => {
    const rows = columnarToMetricRows(frame());
    expect(rows.map((r) => r.key)).toEqual(['up{job="a"}', 'lat{job="b"}', 'gone']);
    expect(rows[1].name).toBe('lat');
    expect(rows[1].labels).toEqual({ job: 'b' });
  });

  it('当前值取最后一个非 NaN 样本', () => {
    const rows = columnarToMetricRows(frame());
    expect(rows[0].value).toBe(1);
    expect(rows[1].value).toBe(2);
  });

  it('全 NaN 序列当前值为 NaN', () => {
    const rows = columnarToMetricRows(frame());
    expect(Number.isNaN(rows[2].value)).toBe(true);
  });

  it('行顺序与 frame.series 一致,不重排', () => {
    const rows = columnarToMetricRows(frame());
    expect(rows.map((r) => r.name)).toEqual(['up', 'lat', 'gone']);
  });
});
