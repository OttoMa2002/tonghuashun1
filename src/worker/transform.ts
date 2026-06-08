// matrix→列式转换(T05)。契约以 docs/data-contract.md §6(列式结构)、§4(乱序处置)为准。
// src/worker/CLAUDE.md 规则 7:ts 严格递增、各 values 与 ts 等长是输出不变量。
//
// 转换职责:
//  - 多 series 对齐到同一时间轴:ts 取所有 series 时间戳的并集,升序去重(§6 严格递增)
//  - 缺点补 NaN:某 series 在某 ts 无样本 → 该位置 NaN(§6 唯一空点哨兵)
//  - 乱序兜底(§4):out_of_order 故障产出乱序 values,本层按 tsMillis 升序排序后列式化,
//    使乱序对下游透明;排序后若同一 series 仍有相等 ts,属契约违例 → 抛 FrameParseError,
//    由 handler 发 query.error(kind:'parse'),绝不静默合并(src/worker/CLAUDE.md 规则 6)

import { seriesKey } from '../contract';
import type { ColumnarFrame, ColumnarSeries, MatrixResponse, Sample } from '../contract';

/**
 * 列式化解析违例(§4):同一 series 排序后仍含相等 tsMillis。
 * handler 捕获本类型 → query.error(kind:'parse'),不静默合并。
 */
export class FrameParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameParseError';
  }
}

/** 单 series 样本按 tsMillis 升序排序;相邻相等 ts 即解析违例(§4)。返回排序后副本。 */
function sortSamplesAscending(key: string, values: ReadonlyArray<readonly [number, number]>): Sample[] {
  const sorted: Sample[] = values.map((v) => [v[0], v[1]] as const).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] === sorted[i - 1][0]) {
      throw new FrameParseError(`series ${key} 含重复 tsMillis=${sorted[i][0]}(§4,禁止静默合并)`);
    }
  }
  return sorted;
}

/**
 * 把 MatrixResponse 转为 ColumnarFrame(§6)。matrix 是传输格式,转换后不再离开 Worker;
 * 出口只有列式帧(src/worker/CLAUDE.md 规则 2)。
 *
 * 不变量(违反即 bug):ts 严格递增;每个 series.values.length === ts.length;缺点为 NaN。
 */
export function matrixToColumnar(matrix: MatrixResponse): ColumnarFrame {
  const rawSeries = matrix.data.result;

  // 1) 各 series 排序 + 违例检测,同时收集全局时间戳并集。
  const tsUnion = new Set<number>();
  const sortedPerSeries = rawSeries.map((s) => {
    const key = seriesKey(s.metric.name, s.metric.labels);
    const sorted = sortSamplesAscending(key, s.values);
    for (const [t] of sorted) {
      tsUnion.add(t);
    }
    return { key, sorted };
  });

  // 2) 共享时间轴:并集升序去重 → 严格递增(§6)。
  const ts = Float64Array.from([...tsUnion].sort((a, b) => a - b));
  const indexOfTs = new Map<number, number>();
  for (let i = 0; i < ts.length; i++) {
    indexOfTs.set(ts[i], i);
  }

  // 3) 逐 series 对齐到时间轴,缺点补 NaN(§6)。
  const series: ColumnarSeries[] = sortedPerSeries.map(({ key, sorted }, si) => {
    const metric = rawSeries[si].metric;
    const values = new Float64Array(ts.length).fill(NaN);
    for (const [t, v] of sorted) {
      const idx = indexOfTs.get(t);
      if (idx === undefined) {
        // 并集由本函数构建,理论不可达;留显式分支而非 ! 断言,避免吞掉契约外状态。
        throw new FrameParseError(`series ${key} 的 tsMillis=${t} 不在时间轴并集内`);
      }
      values[idx] = v;
    }
    return { key, name: metric.name, labels: metric.labels, values };
  });

  return { ts, series };
}

/** 帧内原始点数:各 series 样本数之和(meta.rawPointCount,§5)。 */
export function countRawPoints(matrix: MatrixResponse): number {
  let total = 0;
  for (const s of matrix.data.result) {
    total += s.values.length;
  }
  return total;
}
