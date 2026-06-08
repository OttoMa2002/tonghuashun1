// 栅格 rate 管线单测(T15 DoD)。覆盖:每点 = trailing 窗口 counterRate(/秒)、含重置处理、
// 窗口内 <2 样本 → NaN(间隙)、栅格 ts 严格递增且与各 values 等长(§6 不变量)。

import { describe, expect, it } from 'vitest';

import type { MatrixResponse } from '../contract';

import { counterRate } from './rate';
import { computeRateFrame } from './rate-pipeline';

/** 单 counter series 的 matrix(底层样本,ts 升序)。 */
function counterMatrix(values: Array<[number, number]>, labels: Record<string, string> = { job: 'api' }): MatrixResponse {
  return { status: 'success', data: { result: [{ metric: { name: 'reqs', labels }, values }] } };
}

describe('computeRateFrame', () => {
  it('栅格 ts = start+k*step,严格递增,values 与 ts 等长(§6 不变量)', () => {
    const m = counterMatrix([
      [0, 0],
      [15_000, 10],
      [30_000, 20],
      [45_000, 30],
      [60_000, 40],
    ]);
    const frame = computeRateFrame(m, { startMillis: 30_000, endMillis: 60_000, stepMillis: 15_000, windowMillis: 30_000 });

    expect(Array.from(frame.ts)).toEqual([30_000, 45_000, 60_000]);
    for (let i = 1; i < frame.ts.length; i++) {
      expect(frame.ts[i]).toBeGreaterThan(frame.ts[i - 1]);
    }
    expect(frame.series).toHaveLength(1);
    expect(frame.series[0].values.length).toBe(frame.ts.length);
    expect(frame.series[0].key).toBe('reqs{job=api}');
  });

  it('每点 = trailing 窗口 counterRate,单位 /秒', () => {
    // 每 15s 增 10 → 30s 窗口含 3 点、增量 20、时长 30s → rate = 20/30 ≈ 0.6667 /秒。
    const samples: Array<[number, number]> = [
      [0, 0],
      [15_000, 10],
      [30_000, 20],
      [45_000, 30],
      [60_000, 40],
    ];
    const m = counterMatrix(samples);
    const window = 30_000;
    const frame = computeRateFrame(m, { startMillis: 30_000, endMillis: 60_000, stepMillis: 15_000, windowMillis: window });

    // 逐点对照:窗口 [t-window, t] 内样本喂 counterRate,与管线输出一致。
    for (let k = 0; k < frame.ts.length; k++) {
      const t = frame.ts[k];
      const win = samples.filter(([ts]) => ts >= t - window && ts <= t);
      const expected = counterRate(
        Float64Array.from(win.map(([ts]) => ts)),
        Float64Array.from(win.map(([, v]) => v)),
      );
      expect(frame.series[0].values[k]).toBeCloseTo(expected, 10);
    }
    // 锚定一个手算值:t=60000 窗口 [30000,60000] → 增量 20 / 30s。
    expect(frame.series[0].values[frame.ts.length - 1]).toBeCloseTo(20 / 30, 10);
  });

  it('含 counter 重置:窗口跨重置点,rate 走 counterRate 重置分支(非负斜率)', () => {
    // 60000 处回落(30→5)= 重置,增量按新值计;窗口 [30000,60000] 含 20,30,5:增量 = (30-20)+5 = 15,时长 30s。
    const samples: Array<[number, number]> = [
      [0, 0],
      [15_000, 10],
      [30_000, 20],
      [45_000, 30],
      [60_000, 5],
    ];
    const m = counterMatrix(samples);
    const window = 30_000;
    const frame = computeRateFrame(m, { startMillis: 60_000, endMillis: 60_000, stepMillis: 15_000, windowMillis: window });

    const win = samples.filter(([ts]) => ts >= 60_000 - window && ts <= 60_000);
    const expected = counterRate(Float64Array.from(win.map(([ts]) => ts)), Float64Array.from(win.map(([, v]) => v)));
    expect(frame.series[0].values[0]).toBeCloseTo(expected, 10);
    // 重置分支保证非负:15/30 = 0.5 > 0(若用首尾斜率 (5-20)/30 会算出负值,反例 2)。
    expect(frame.series[0].values[0]).toBeCloseTo(15 / 30, 10);
    expect(frame.series[0].values[0]).toBeGreaterThan(0);
  });

  it('窗口内样本 < 2 → 该点 NaN(间隙)', () => {
    // window(10s)< step(15s):对齐到样本的栅格点,窗口内只含该点自身 1 个样本 → NaN。
    const m = counterMatrix([
      [0, 0],
      [15_000, 10],
      [30_000, 20],
      [45_000, 30],
      [60_000, 40],
    ]);
    const frame = computeRateFrame(m, { startMillis: 30_000, endMillis: 60_000, stepMillis: 15_000, windowMillis: 10_000 });

    for (const v of frame.series[0].values) {
      expect(Number.isNaN(v)).toBe(true);
    }
  });

  it('多 series:各自独立按栅格求 rate,series 顺序与 key 保留', () => {
    const m: MatrixResponse = {
      status: 'success',
      data: {
        result: [
          { metric: { name: 'reqs', labels: { job: 'a' } }, values: [[0, 0], [15_000, 10], [30_000, 20]] },
          { metric: { name: 'reqs', labels: { job: 'b' } }, values: [[0, 0], [15_000, 30], [30_000, 60]] },
        ],
      },
    };
    const frame = computeRateFrame(m, { startMillis: 30_000, endMillis: 30_000, stepMillis: 15_000, windowMillis: 30_000 });

    expect(frame.series.map((s) => s.key)).toEqual(['reqs{job=a}', 'reqs{job=b}']);
    // a:增量 20/30s;b:增量 60/30s。
    expect(frame.series[0].values[0]).toBeCloseTo(20 / 30, 10);
    expect(frame.series[1].values[0]).toBeCloseTo(60 / 30, 10);
  });
});
