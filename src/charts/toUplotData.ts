import type uPlot from 'uplot';

import type { ColumnarFrame } from '../contract';

// ColumnarFrame(契约 §6)→ uPlot AlignedData 的纯转换。不做任何数据加工
// (不降采样/过滤/排序,见 src/charts/CLAUDE.md 规则 3)。
//
// 间隙哨兵裁决(T10 首验,见 nan-gap.test.ts 实证):
//   uPlot 的间隙判定用 `=== null`(findGaps / linear builder),NaN 不等于 null,
//   会被当作有效值送进 lineTo;canvas 忽略非有限坐标,结果是跨间隙直连——NaN 不产生间隙。
//   契约 §6 期望的「Float64Array + NaN + 关 spanGaps → 间隙」由此被证伪。
//   故启用契约 §8-3 预授权的降级路径:含 NaN 的序列转为 (number|null)[] 普通数组,NaN→null。
//   Float64Array 存不了 null(强制为 0,画成到 0 的连线),普通数组是唯一可表达 null 的载体。
// 结论须经人工回写 data-contract.md §6/§8-3(charts CLAUDE.md 规则 5)。

/**
 * 单序列值列适配。无 NaN 时原样返回 Float64Array(零拷贝、维持 Transferable 收益);
 * 含 NaN 时转 (number|null)[],NaN→null(uPlot 唯一识别的间隙哨兵)。
 */
export function toGappyColumn(values: Float64Array): Float64Array | (number | null)[] {
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) {
      return toNullable(values);
    }
  }
  return values;
}

function toNullable(values: Float64Array): (number | null)[] {
  const out = new Array<number | null>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = Number.isNaN(v) ? null : v;
  }
  return out;
}

/** 列式帧 → uPlot 对位数据:`[ts, ...各序列值]`。ts 为毫秒,保持 Float64Array 原样(无 NaN)。 */
export function toUplotData(frame: ColumnarFrame): uPlot.AlignedData {
  return [frame.ts, ...frame.series.map((s) => toGappyColumn(s.values))];
}
