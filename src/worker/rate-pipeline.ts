// 栅格 rate 序列管线(T15)。语义以 docs/data-contract.md §3 栅格 rate、ADR-0010 为准。
// rate 求值只允许在 Worker(CLAUDE.md 硬约束 3、src/worker/CLAUDE.md 规则 5);本模块消费 T07 的
// counterRate 单窗口原语(rate.ts),在 stepped 栅格上逐点求 trailing 窗口 rate,产出 rate ColumnarFrame。
//
// ADR-0010 语义:
//  - 每个栅格点 t = start + k*step(k=0..floor((end-start)/step)):rate(t) = counterRate([t-windowMillis, t]),单位 /秒
//  - 窗口内样本 < 2 → 该点 NaN(间隙,关 spanGaps);counterRate 对 n<2 即返回 NaN
//  - 含 counter 重置处理(复用 counterRate 的重置分支,反例 2)
//
// 实现取舍:先经 matrixToColumnar 解析底层样本——复用其 §4 乱序排序、重复 ts → FrameParseError 的
// 解析义务(由 handler 转 query.error kind:'parse'),不在此另写一份排序/校验导致漂移。对齐后各 series
// 在共享时间轴上以 NaN 表缺点,逐栅格点按 [t-windowMillis, t] 取窗内非 NaN 样本喂给 counterRate。

import type { ColumnarFrame, ColumnarSeries, MatrixResponse } from '../contract';

import { counterRate } from './rate';
import { matrixToColumnar } from './transform';

/** 栅格 rate 求值参数。stepMillis/windowMillis 由 query.exec 携带(契约 §5),均 > 0 由调用方保证。 */
export interface RateGridParams {
  startMillis: number;
  endMillis: number;
  stepMillis: number;
  windowMillis: number;
}

/** 返回 ts >= target 的最左下标(下界),无则 len(二分,ts 严格递增)。 */
function lowerBound(ts: Float64Array, target: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ts[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** 返回 ts > target 的最左下标(上界),无则 len(二分,ts 严格递增)。 */
function upperBound(ts: Float64Array, target: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ts[mid] <= target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * 在 stepped 栅格上把底层样本(已取自 [start-windowMillis, end])求值为 rate ColumnarFrame(§3、ADR-0010)。
 *
 * 输出不变量(§6):frame.ts = 栅格时刻,严格递增(step>0);各 series.values 与 ts 等长;窗口不足以
 * 定义速率(<2 样本)处为 NaN。底层样本的解析违例(重复 ts)由 matrixToColumnar 抛 FrameParseError,
 * 不在此吞掉(src/worker/CLAUDE.md 规则 6)。
 */
export function computeRateFrame(underlying: MatrixResponse, params: RateGridParams): ColumnarFrame {
  const { startMillis, endMillis, stepMillis, windowMillis } = params;

  // 底层样本对齐:复用 §4 乱序排序与重复 ts 校验,得到共享时间轴 + 各 series 在轴上的取值(缺点 NaN)。
  const aligned = matrixToColumnar(underlying);
  const alignedTs = aligned.ts;

  // 栅格时刻:start + k*step,k=0..floor((end-start)/step)(与 query_range stepped 评估同栅格,§2)。
  const count = Math.floor((endMillis - startMillis) / stepMillis) + 1;
  const gridTs = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    gridTs[k] = startMillis + k * stepMillis;
  }

  const series: ColumnarSeries[] = aligned.series.map((s) => {
    const rates = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const t = gridTs[k];
      // trailing 窗口 [t-windowMillis, t] 闭区间(契约 §3 写法,不引入 Prometheus 左开端点的额外语义)。
      const from = lowerBound(alignedTs, t - windowMillis);
      const to = upperBound(alignedTs, t);
      // 取窗内该 series 的实际样本(跳过对齐补的 NaN 缺点),喂 counterRate。
      const wts: number[] = [];
      const wv: number[] = [];
      for (let j = from; j < to; j++) {
        const v = s.values[j];
        if (!Number.isNaN(v)) {
          wts.push(alignedTs[j]);
          wv.push(v);
        }
      }
      rates[k] = counterRate(Float64Array.from(wts), Float64Array.from(wv));
    }
    return { key: s.key, name: s.name, labels: s.labels, values: rates };
  });

  return { ts: gridTs, series };
}
