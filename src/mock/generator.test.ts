import { describe, it, expect } from 'vitest';

import { seriesKey } from '../contract';

import { generateSeries, type CounterSpec, type GaugeSpec, type GenGrid } from './generator';

const GRID: GenGrid = { startMillis: 1_000_000, endMillis: 1_000_000 + 9 * 15_000, stepMillis: 15_000 };

const counterSpec: CounterSpec = {
  name: 'http_requests_total',
  type: 'counter',
  labelSets: [
    { method: 'GET', code: '200' },
    { method: 'POST', code: '500' },
  ],
  startValue: 0,
  stepIncrement: [0, 10],
};

const gaugeSpec: GaugeSpec = {
  name: 'cpu_usage',
  type: 'gauge',
  labelSets: [{ host: 'a' }, { host: 'b' }],
  valueRange: [0.1, 0.9],
};

describe('generateSeries — 确定性(DoD)', () => {
  it('counter:同种子两次生成逐点相等', () => {
    expect(generateSeries(counterSpec, GRID, 123)).toEqual(generateSeries(counterSpec, GRID, 123));
  });

  it('gauge:同种子两次生成逐点相等', () => {
    expect(generateSeries(gaugeSpec, GRID, 123)).toEqual(generateSeries(gaugeSpec, GRID, 123));
  });

  it('不同种子结果不同', () => {
    const a = generateSeries(gaugeSpec, GRID, 1);
    const b = generateSeries(gaugeSpec, GRID, 2);
    expect(a).not.toEqual(b);
  });

  it('随机流与 labelSets 顺序无关(每序列由 seriesKey 派生子种子)', () => {
    const reordered: GaugeSpec = { ...gaugeSpec, labelSets: [{ host: 'b' }, { host: 'a' }] };
    const base = generateSeries(gaugeSpec, GRID, 9);
    const swapped = generateSeries(reordered, GRID, 9);
    // host=a 这条序列在两次调用中应逐点相等,尽管它在 labelSets 中的位置不同。
    const aFromBase = base.find((s) => s.metric.labels.host === 'a');
    const aFromSwapped = swapped.find((s) => s.metric.labels.host === 'a');
    expect(aFromSwapped).toEqual(aFromBase);
  });
});

describe('generateSeries — counter 单调不减(DoD)', () => {
  it('每条序列逐点非递减', () => {
    for (const series of generateSeries(counterSpec, GRID, 77)) {
      for (let i = 1; i < series.samples.length; i++) {
        expect(series.samples[i][1]).toBeGreaterThanOrEqual(series.samples[i - 1][1]);
      }
    }
  });

  it('首点等于 startValue', () => {
    const spec: CounterSpec = { ...counterSpec, startValue: 500 };
    for (const series of generateSeries(spec, GRID, 77)) {
      expect(series.samples[0][1]).toBe(500);
    }
  });

  it('增量下界为负则抛错(防破坏单调)', () => {
    const bad: CounterSpec = { ...counterSpec, stepIncrement: [-1, 5] };
    expect(() => generateSeries(bad, GRID, 1)).toThrow();
  });
});

describe('generateSeries — gauge 落在配置区间(DoD)', () => {
  it('每点都在 [min,max] 内', () => {
    const [min, max] = gaugeSpec.valueRange;
    for (const series of generateSeries(gaugeSpec, GRID, 55)) {
      for (const [, v] of series.samples) {
        expect(v).toBeGreaterThanOrEqual(min);
        expect(v).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe('generateSeries — 结构与栅格', () => {
  it('每个 labelSet 对应一条序列,顺序一致,metric 元信息正确', () => {
    const out = generateSeries(counterSpec, GRID, 1);
    expect(out).toHaveLength(counterSpec.labelSets.length);
    out.forEach((s, i) => {
      expect(s.metric.name).toBe(counterSpec.name);
      expect(s.metric.type).toBe('counter');
      expect(seriesKey(s.metric.name, s.metric.labels)).toBe(
        seriesKey(counterSpec.name, counterSpec.labelSets[i]),
      );
    });
  });

  it('栅格点数 = floor((end-start)/step)+1,时间戳为整数 ms 且严格递增', () => {
    const out = generateSeries(gaugeSpec, GRID, 1);
    const expected = Math.floor((GRID.endMillis - GRID.startMillis) / GRID.stepMillis) + 1;
    for (const s of out) {
      expect(s.samples).toHaveLength(expected);
      for (let i = 0; i < s.samples.length; i++) {
        expect(Number.isInteger(s.samples[i][0])).toBe(true);
        expect(s.samples[i][0]).toBe(GRID.startMillis + i * GRID.stepMillis);
      }
    }
  });

  it('窗口不整除 step:末点不超过 endMillis', () => {
    const grid: GenGrid = { startMillis: 0, endMillis: 100, stepMillis: 30 };
    const [series] = generateSeries({ ...gaugeSpec, labelSets: [{ host: 'a' }] }, grid, 1);
    const last = series.samples[series.samples.length - 1][0];
    expect(last).toBeLessThanOrEqual(grid.endMillis);
    expect(series.samples).toHaveLength(4); // t=0,30,60,90
  });

  it('非法栅格抛错(step<=0)', () => {
    expect(() => generateSeries(gaugeSpec, { ...GRID, stepMillis: 0 }, 1)).toThrow();
  });
});
