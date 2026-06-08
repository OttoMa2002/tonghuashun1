import { describe, it, expect } from 'vitest';

import { seriesKey } from '../contract';
import type { QueryRangeParams, QueryRangeResponse } from '../contract';

import { createFaultInjector, type FaultConfig, type Sleep } from './fault';
import type { GeneratedSeries } from './generator';
import { queryRange, type MockDataset } from './query';

/** 记录每次 sleep 的请求时长,并立即解决——避免真实等待,同时让测试断言延迟值。 */
function recordingSleep(): { sleep: Sleep; calls: number[] } {
  const calls: number[] = [];
  const sleep: Sleep = (millis) => {
    calls.push(millis);
    return Promise.resolve();
  };
  return { sleep, calls };
}

function expectSuccess(r: QueryRangeResponse): QueryRangeResponse & { status: 'success' } {
  expect(r.status).toBe('success');
  if (r.status !== 'success') {
    throw new Error('期望 success 响应');
  }
  return r;
}

// 两条序列,各 4 点(out_of_order 步长 2 的不重叠对成对可交换)。
const seriesA: GeneratedSeries = {
  metric: { name: 'm', type: 'gauge', labels: { host: 'a' } },
  samples: [[0, 10], [10, 11], [20, 12], [30, 13]],
};
const seriesB: GeneratedSeries = {
  metric: { name: 'm', type: 'gauge', labels: { host: 'b' } },
  samples: [[0, 20], [10, 21], [20, 22], [30, 23]],
};
const dataset: MockDataset = [seriesA, seriesB];

const rawParams: QueryRangeParams = { selector: { name: 'm' }, startMillis: 0, endMillis: 30 };

describe('故障注入 — 默认全关回归(§4 / CLAUDE.md 规则 4)', () => {
  it('config 省略时,query 解析值与 queryRange 逐字段一致', async () => {
    const inj = createFaultInjector(dataset);
    const variants: QueryRangeParams[] = [
      rawParams,
      { selector: { name: 'm', labels: { host: 'a' } }, startMillis: 0, endMillis: 30, stepMillis: 10 },
      { selector: { name: 'does_not_exist' }, startMillis: 0, endMillis: 30, stepMillis: 10 },
      { selector: { name: 'm' }, startMillis: 30, endMillis: 0, stepMillis: 10 }, // bad_request
    ];
    for (const p of variants) {
      await expect(inj.query(p)).resolves.toEqual(queryRange(dataset, p));
    }
  });

  it('四种故障概率均为 0 时同样与 queryRange 一致(且不触发 sleep)', async () => {
    const { sleep, calls } = recordingSleep();
    const config: FaultConfig = {
      timeout: { probability: 0 },
      http5xx: { probability: 0 },
      slow: { probability: 0 },
      outOfOrder: { probability: 0 },
    };
    const inj = createFaultInjector(dataset, config, { sleep });
    await expect(inj.query(rawParams)).resolves.toEqual(queryRange(dataset, rawParams));
    expect(calls).toEqual([]);
  });
});

describe('故障注入 — timeout(§4,可独立开启)', () => {
  it('probability 1:延迟 afterMillis 后回执 timeout 错误', async () => {
    const { sleep, calls } = recordingSleep();
    const inj = createFaultInjector(dataset, { timeout: { probability: 1, afterMillis: 10_000 } }, { sleep });
    const r = await inj.query(rawParams);
    expect(r).toEqual({ status: 'error', errorType: 'timeout', message: expect.any(String) });
    expect(calls).toEqual([10_000]);
  });

  it('afterMillis 省略时延迟取 CLIENT_TIMEOUT_MILLIS(10s)', async () => {
    const { sleep, calls } = recordingSleep();
    const inj = createFaultInjector(dataset, { timeout: { probability: 1 } }, { sleep });
    await inj.query(rawParams);
    expect(calls).toEqual([10_000]);
  });
});

describe('故障注入 — http_5xx(§4,可独立开启)', () => {
  it('probability 1:返回 internal 错误,不延迟', async () => {
    const { sleep, calls } = recordingSleep();
    const inj = createFaultInjector(dataset, { http5xx: { probability: 1 } }, { sleep });
    const r = await inj.query(rawParams);
    expect(r).toEqual({ status: 'error', errorType: 'internal', message: expect.any(String) });
    expect(calls).toEqual([]);
  });
});

describe('故障注入 — slow(§4,可独立开启)', () => {
  it('probability 1:延迟 delayMillis 后返回与无故障一致的数据', async () => {
    const { sleep, calls } = recordingSleep();
    const inj = createFaultInjector(dataset, { slow: { probability: 1, delayMillis: 3000 } }, { sleep });
    const r = await inj.query(rawParams);
    expect(calls).toEqual([3000]); // 延迟发生
    expect(r).toEqual(queryRange(dataset, rawParams)); // 数据本身不变
  });

  it('delayMillis 省略时取默认 3000ms', async () => {
    const { sleep, calls } = recordingSleep();
    const inj = createFaultInjector(dataset, { slow: { probability: 1 } }, { sleep });
    await inj.query(rawParams);
    expect(calls).toEqual([3000]);
  });
});

describe('故障注入 — out_of_order(§4,可独立开启)', () => {
  it('swapRate 1:不重叠相邻对(步长 2)全部交换,产出乱序 tsMillis', async () => {
    const inj = createFaultInjector(dataset, { outOfOrder: { probability: 1, swapRate: 1 } });
    const r = expectSuccess(await inj.query(rawParams));
    // [0,1,2,3] 对 (0,1)(2,3) 交换 → 顺序 10/0/30/20。
    expect(r.data.result[0].values).toEqual([[10, 11], [0, 10], [30, 13], [20, 12]]);
    // 时间戳确实乱序(非严格递增),交给 Worker(T05)解析侧排序。
    const ts = r.data.result[0].values.map(([t]) => t);
    expect(ts).not.toEqual([...ts].sort((x, y) => x - y));
  });

  it('保持样本多重集不变(只换位置,不增删改值)', async () => {
    const inj = createFaultInjector(dataset, { outOfOrder: { probability: 1, swapRate: 1 } });
    const r = expectSuccess(await inj.query(rawParams));
    const sortBack = (vs: Array<[number, number]>) => [...vs].sort((a, b) => a[0] - b[0]);
    expect(sortBack(r.data.result[0].values)).toEqual(seriesA.samples);
  });

  it('确定性:同 seed 同查询两次注入结果逐点相等', async () => {
    const cfg: FaultConfig = { outOfOrder: { probability: 1, swapRate: 0.5 } };
    const a = expectSuccess(await createFaultInjector(dataset, cfg, { seed: 7 }).query(rawParams));
    const b = expectSuccess(await createFaultInjector(dataset, cfg, { seed: 7 }).query(rawParams));
    expect(a.data.result).toEqual(b.data.result);
  });

  it('定向 targetKeys:仅命中序列被乱序,其余原样', async () => {
    const keyA = seriesKey('m', { host: 'a' });
    const inj = createFaultInjector(dataset, {
      outOfOrder: { probability: 1, swapRate: 1 },
      targetKeys: [keyA],
    });
    const r = expectSuccess(await inj.query(rawParams));
    expect(r.data.result[0].values).toEqual([[10, 11], [0, 10], [30, 13], [20, 12]]); // host=a 被乱序
    expect(r.data.result[1].values).toEqual(seriesB.samples); // host=b 原样
  });

  it('不污染错误响应:bad_request 时不施加乱序', async () => {
    const inj = createFaultInjector(dataset, { outOfOrder: { probability: 1, swapRate: 1 } });
    const bad: QueryRangeParams = { selector: { name: 'm' }, startMillis: 30, endMillis: 0 };
    await expect(inj.query(bad)).resolves.toEqual(queryRange(dataset, bad));
  });
});

describe('故障注入 — 优先级与叠加', () => {
  it('timeout 优先于 http5xx:两者皆开时返回 timeout', async () => {
    const { sleep } = recordingSleep();
    const inj = createFaultInjector(
      dataset,
      { timeout: { probability: 1 }, http5xx: { probability: 1 } },
      { sleep },
    );
    const r = await inj.query(rawParams);
    expect(r.status === 'error' && r.errorType).toBe('timeout');
  });

  it('slow 与 out_of_order 叠加:既延迟又乱序', async () => {
    const { sleep, calls } = recordingSleep();
    const inj = createFaultInjector(
      dataset,
      { slow: { probability: 1, delayMillis: 500 }, outOfOrder: { probability: 1, swapRate: 1 } },
      { sleep },
    );
    const r = expectSuccess(await inj.query(rawParams));
    expect(calls).toEqual([500]);
    expect(r.data.result[0].values).toEqual([[10, 11], [0, 10], [30, 13], [20, 12]]);
  });
});

describe('故障注入 — setConfig(模拟故障出现/恢复,服务 T09)', () => {
  it('开启后回执故障,setConfig 关闭后恢复为无故障数据', async () => {
    const inj = createFaultInjector(dataset, { http5xx: { probability: 1 } });
    expect((await inj.query(rawParams)).status).toBe('error');
    inj.setConfig({});
    await expect(inj.query(rawParams)).resolves.toEqual(queryRange(dataset, rawParams));
  });
});
