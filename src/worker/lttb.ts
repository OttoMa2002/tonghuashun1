// 渲染级降采样 LTTB(T06)。ADR-0004:LTTB 只允许在 Worker 内执行(CLAUDE.md 硬约束 3),
// 主线程永远只消费已压缩的列式快照。目标点数由查询指令携带(query.exec.downsample.targetPoints,§5)。
//
// Largest-Triangle-Three-Buckets:把 n 点压到 target 点,保留视觉特征(峰谷)。
//  - 首末点必保留(§锚点);其余 target-2 点分桶,每桶选与「上一选定点 + 下一桶均值点」
//    构成最大三角形面积的点。
//  - 输入 xs 严格递增(ColumnarFrame.ts 不变量,§6),选定下标严格递增 → 输出 xs 仍严格递增。
//  - NaN 兜底(§6 缺点哨兵):面积计算遇 NaN 自然不被选(NaN 比较恒 false);整桶无有限点时
//    退化为取桶首下标,保证输出下标始终有效、单调,不静默产出 NaN 锚点。
//
// 复杂度 O(n) 单遍,无额外大数组分配(只产出 target 长度结果)。1M→2000 预算见 §7 / lttb.bench.ts。

/** xs 与 ys 长度不一致(LTTB 前置不变量,对应 ColumnarFrame values 与 ts 等长,§6)。 */
export class LttbInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LttbInputError';
  }
}

/**
 * 计算 LTTB 选定下标(严格递增,含首末下标)。
 * targetPoints >= 输入长度:不降采样,返回全体下标(无法上采样)。
 * targetPoints < 2:抛错(首末两锚点是 LTTB 下限)。
 */
export function lttbIndices(xs: Float64Array, ys: Float64Array, targetPoints: number): Uint32Array {
  const n = xs.length;
  if (ys.length !== n) {
    throw new LttbInputError(`xs/ys 长度不一致:xs=${n} ys=${ys.length}(§6 values 与 ts 等长)`);
  }
  if (!Number.isInteger(targetPoints) || targetPoints < 2) {
    throw new LttbInputError(`targetPoints 必须为 >=2 的整数,收到 ${targetPoints}(需保留首末两锚点)`);
  }

  // 不足以降采样:全量返回(不上采样,输出即输入下标)。
  if (targetPoints >= n) {
    const all = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      all[i] = i;
    }
    return all;
  }

  const sampled = new Uint32Array(targetPoints);
  let sampledIdx = 0;
  sampled[sampledIdx++] = 0; // 首点必留

  // 中间点桶宽:n-2 个候选点均分到 target-2 个桶。
  const bucketSize = (n - 2) / (targetPoints - 2);
  let a = 0; // 上一选定点下标

  for (let i = 0; i < targetPoints - 2; i++) {
    // 下一桶均值点(用于构成三角形第三顶点),NaN 不计入均值。
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    let avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
    if (avgRangeEnd > n) {
      avgRangeEnd = n;
    }
    let avgX = 0;
    let avgY = 0;
    let avgCount = 0;
    for (let j = avgRangeStart; j < avgRangeEnd; j++) {
      const y = ys[j];
      if (Number.isFinite(y)) {
        avgX += xs[j];
        avgY += y;
        avgCount++;
      }
    }
    if (avgCount > 0) {
      avgX /= avgCount;
      avgY /= avgCount;
    } else {
      // 整段无有限点:退化用 x 中点、y=0,避免 NaN 污染面积比较(后续靠桶首兜底)。
      avgX = (xs[avgRangeStart] + xs[Math.max(avgRangeStart, avgRangeEnd - 1)]) / 2;
      avgY = 0;
    }

    // 当前桶范围。
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    const pointAX = xs[a];
    const pointAY = ys[a];

    let maxArea = -1;
    let maxAreaIdx = rangeStart; // 兜底:全桶 NaN/面积无效时取桶首,保证下标有效且单调。
    for (let j = rangeStart; j < rangeEnd; j++) {
      // 三角形面积(取绝对值):a、候选点 j、下一桶均值点。NaN 参与时结果 NaN,比较恒 false → 不选。
      const area = Math.abs(
        (pointAX - avgX) * (ys[j] - pointAY) - (pointAX - xs[j]) * (avgY - pointAY),
      );
      if (area > maxArea) {
        maxArea = area;
        maxAreaIdx = j;
      }
    }

    sampled[sampledIdx++] = maxAreaIdx;
    a = maxAreaIdx;
  }

  sampled[sampledIdx++] = n - 1; // 末点必留
  return sampled;
}

/**
 * 对单序列 (xs, ys) 做 LTTB 降采样。返回新 Float64Array(长度 = min(targetPoints, n))。
 * 不变量:输出 xs 严格递增、与输出 ys 等长;首末点保留。
 */
export function lttb(
  xs: Float64Array,
  ys: Float64Array,
  targetPoints: number,
): { xs: Float64Array; ys: Float64Array } {
  const indices = lttbIndices(xs, ys, targetPoints);
  const outXs = new Float64Array(indices.length);
  const outYs = new Float64Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    outXs[i] = xs[idx];
    outYs[i] = ys[idx];
  }
  return { xs: outXs, ys: outYs };
}
