import { describe, it, expect } from 'vitest';

import type { MatrixSeries, QueryRangeResponse } from '../contract';

import { generateSeries, type CounterSpec, type GaugeSpec, type GenGrid, type GeneratedSeries } from './generator';
import { queryRange, type MockDataset } from './query';

/** 断言成功响应并返回 result(同时让下游访问获得类型收窄)。 */
function expectSuccess(r: QueryRangeResponse): MatrixSeries[] {
  expect(r.status).toBe('success');
  if (r.status !== 'success') {
    throw new Error('期望 success 响应');
  }
  return r.data.result;
}

// 手工数据集:精确控制样本疏密以验证评估对齐 / lookback / raw 边界。
const sparse: GeneratedSeries = {
  metric: { name: 'm', type: 'gauge', labels: { host: 'a' } },
  // 60s 到 600s 之间留一段 > 5min 的空洞,用于 lookback 过期用例。
  samples: [
    [0, 10],
    [60_000, 20],
    [600_000, 30],
  ],
};
const sparseDataset: MockDataset = [sparse];

describe('queryRange — stepped 评估对齐(§2 / prom-query-semantics)', () => {
  it('在 start+k*step 栅格上取「该时刻之前最近样本」', () => {
    const [series] = expectSuccess(
      queryRange(sparseDataset, { selector: { name: 'm' }, startMillis: 0, endMillis: 120_000, stepMillis: 30_000 }),
    );
    expect(series.values).toEqual([
      [0, 10], // 最近样本 [0,10]
      [30_000, 10], // 仍取 [0,10]
      [60_000, 20], // 最近样本 [60k,20]
      [90_000, 20], // 仍取 [60k,20]
      [120_000, 20],
    ]);
  });

  it('评估时刻早于首样本 → 空点省略(matrix 不补点)', () => {
    const [series] = expectSuccess(
      queryRange(sparseDataset, { selector: { name: 'm' }, startMillis: -60_000, endMillis: 0, stepMillis: 30_000 }),
    );
    // t=-60k,-30k 早于首样本 [0,10] → 省略;t=0 命中。
    expect(series.values).toEqual([[0, 10]]);
  });

  it('lookback 边界:恰好 300_000ms 含,刚超出则该点为空', () => {
    // 60k 之后下一个样本在 600k。eval 在 360k 时差值恰为 LOOKBACK_MILLIS。
    const atEdge = expectSuccess(
      queryRange(sparseDataset, { selector: { name: 'm' }, startMillis: 360_000, endMillis: 360_000 + 1, stepMillis: 30_000 }),
    )[0];
    expect(atEdge.values).toEqual([[360_000, 20]]); // 360k-60k === 300k,含

    const past = expectSuccess(
      queryRange(sparseDataset, { selector: { name: 'm' }, startMillis: 360_001, endMillis: 360_001 + 1, stepMillis: 30_000 }),
    )[0];
    expect(past.values).toEqual([]); // 360_001-60_000 = 300_001 > lookback → 空
  });

  it('两评估时刻间有多个样本:只采到最近的一个(非下标抽稀)', () => {
    const dense: GeneratedSeries = {
      metric: { name: 'd', type: 'gauge', labels: {} },
      samples: [
        [0, 1],
        [15_000, 2],
        [30_000, 3],
        [45_000, 4],
        [60_000, 5],
      ],
    };
    const [series] = expectSuccess(
      queryRange([dense], { selector: { name: 'd' }, startMillis: 0, endMillis: 60_000, stepMillis: 60_000 }),
    );
    // step=60k → 只评估 t=0 与 t=60k,中间 15k/30k/45k 不被采。
    expect(series.values).toEqual([
      [0, 1],
      [60_000, 5],
    ]);
  });
});

describe('queryRange — step 边界用例(DoD)', () => {
  it('窗口不整除 step:点数 = floor((end-start)/step)+1,末点不超 end', () => {
    const dataset: MockDataset = [
      { metric: { name: 'm', type: 'gauge', labels: { host: 'a' } }, samples: [[0, 7]] },
    ];
    const [series] = expectSuccess(
      queryRange(dataset, { selector: { name: 'm' }, startMillis: 0, endMillis: 100, stepMillis: 30 }),
    );
    // 评估时刻 0,30,60,90(共 4 点),均落在最近样本 [0,7] 的 lookback 内。
    expect(series.values.map(([t]) => t)).toEqual([0, 30, 60, 90]);
    expect(series.values[series.values.length - 1][0]).toBeLessThanOrEqual(100);
  });

  it('start > end → bad_request(契约要求 start < end)', () => {
    const r = queryRange(sparseDataset, { selector: { name: 'm' }, startMillis: 100, endMillis: 50, stepMillis: 10 });
    expect(r).toEqual({ status: 'error', errorType: 'bad_request', message: expect.any(String) });
  });

  it('start === end → bad_request(契约要求严格小于)', () => {
    const r = queryRange(sparseDataset, { selector: { name: 'm' }, startMillis: 50, endMillis: 50, stepMillis: 10 });
    expect(r.status).toBe('error');
  });

  it('stepMillis <= 0 → bad_request', () => {
    const r = queryRange(sparseDataset, { selector: { name: 'm' }, startMillis: 0, endMillis: 100, stepMillis: 0 });
    expect(r.status).toBe('error');
  });

  it('空选择器(匹配不到任何序列)→ 成功 + 空 result', () => {
    const byName = expectSuccess(
      queryRange(sparseDataset, { selector: { name: 'does_not_exist' }, startMillis: 0, endMillis: 100, stepMillis: 10 }),
    );
    expect(byName).toEqual([]);

    const byLabel = expectSuccess(
      queryRange(sparseDataset, { selector: { name: 'm', labels: { host: 'zzz' } }, startMillis: 0, endMillis: 100, stepMillis: 10 }),
    );
    expect(byLabel).toEqual([]);
  });
});

describe('queryRange — selector 等值匹配(§2,仅 =)', () => {
  const multi: MockDataset = [
    { metric: { name: 'http', type: 'counter', labels: { method: 'GET', code: '200' } }, samples: [[0, 1]] },
    { metric: { name: 'http', type: 'counter', labels: { method: 'POST', code: '500' } }, samples: [[0, 2]] },
    { metric: { name: 'other', type: 'gauge', labels: { method: 'GET' } }, samples: [[0, 3]] },
  ];

  it('仅 name:命中同名全部序列', () => {
    const res = expectSuccess(queryRange(multi, { selector: { name: 'http' }, startMillis: 0, endMillis: 1, stepMillis: 1 }));
    expect(res).toHaveLength(2);
  });

  it('name + 部分 label:全部 label 等值才命中', () => {
    const res = expectSuccess(
      queryRange(multi, { selector: { name: 'http', labels: { method: 'GET' } }, startMillis: 0, endMillis: 1, stepMillis: 1 }),
    );
    expect(res).toHaveLength(1);
    expect(res[0].metric.labels).toEqual({ method: 'GET', code: '200' });
  });
});

describe('queryRange — raw 模式(省略 step,ADR-0004)', () => {
  const dataset: MockDataset = [
    { metric: { name: 'm', type: 'gauge', labels: {} }, samples: [[0, 1], [10, 2], [20, 3], [30, 4]] },
  ];

  it('返回 [start,end] 闭区间内全部原始样本,不做评估对齐', () => {
    const [series] = expectSuccess(queryRange(dataset, { selector: { name: 'm' }, startMillis: 10, endMillis: 20 }));
    expect(series.values).toEqual([
      [10, 2],
      [20, 3],
    ]);
  });

  it('边界为闭区间:start 与 end 上的样本均含', () => {
    const [series] = expectSuccess(queryRange(dataset, { selector: { name: 'm' }, startMillis: 0, endMillis: 30 }));
    expect(series.values).toHaveLength(4);
  });

  it('raw 不受 lookback 影响,稀疏样本原样返回', () => {
    const [series] = expectSuccess(queryRange(sparseDataset, { selector: { name: 'm' }, startMillis: 0, endMillis: 600_000 }));
    expect(series.values).toEqual([
      [0, 10],
      [60_000, 20],
      [600_000, 30],
    ]);
  });
});

describe('queryRange — 与 generateSeries 集成 + 结构契约(DoD)', () => {
  const grid: GenGrid = { startMillis: 0, endMillis: 9 * 15_000, stepMillis: 15_000 };
  const counterSpec: CounterSpec = {
    name: 'requests_total',
    type: 'counter',
    labelSets: [{ method: 'GET' }],
    startValue: 0,
    stepIncrement: [1, 1], // 固定 +1,使断言确定
  };
  const gaugeSpec: GaugeSpec = {
    name: 'cpu',
    type: 'gauge',
    labelSets: [{ host: 'a' }],
    valueRange: [0, 1],
  };
  const dataset: MockDataset = [
    ...generateSeries(counterSpec, grid, 42),
    ...generateSeries(gaugeSpec, grid, 42),
  ];

  it('返回结构与 src/contract MatrixResponse 一致(无私有变体)', () => {
    const res = queryRange(dataset, { selector: { name: 'cpu' }, startMillis: 0, endMillis: 60_000, stepMillis: 30_000 });
    expect(res.status).toBe('success');
    const result = expectSuccess(res);
    expect(result).toHaveLength(1);
    const series = result[0];
    expect(Object.keys(series.metric).sort()).toEqual(['labels', 'name']); // 无 type 等多余字段
    for (const v of series.values) {
      expect(v).toHaveLength(2);
      expect(typeof v[0]).toBe('number');
      expect(typeof v[1]).toBe('number');
    }
  });

  it('stepped 在 15s 基础分辨率上按 step 重采样(counter 单调)', () => {
    const [series] = expectSuccess(
      queryRange(dataset, { selector: { name: 'requests_total' }, startMillis: 0, endMillis: 9 * 15_000, stepMillis: 30_000 }),
    );
    // step=30s 在 15s 数据上评估 t=0,30k,60k,...;counter 取最近样本,值应非递减。
    for (let i = 1; i < series.values.length; i++) {
      expect(series.values[i][1]).toBeGreaterThanOrEqual(series.values[i - 1][1]);
    }
    expect(series.values[0]).toEqual([0, 0]); // 首点 = startValue
  });

  it('lookback 远大于基础分辨率:稀疏单次漏采可被桥接(同一样本被相邻评估点重复采到)', () => {
    const [series] = expectSuccess(
      queryRange(dataset, { selector: { name: 'cpu' }, startMillis: 0, endMillis: 15_000, stepMillis: 5_000 }),
    );
    // t=0,5k,10k 都早于或等于唯一近邻样本边界:0/5k/10k 的最近样本都是 t=0 的值。
    expect(series.values[0][1]).toBe(series.values[1][1]);
    expect(series.values[1][1]).toBe(series.values[2][1]);
  });
});
