// 列式快照 → 表格行视图模型的显示投影(T13)。
// architecture.md §4:components 消费 data/contract;本适配器把 ColumnarFrame(契约 §6)
// 投影为 MetricTable 的行。取「最后一个非 NaN 样本」作为指标当前值——这是显示层投影,
// 不是数据加工(硬约束 3 列举的 matrix 解析 / 降采样 / rate 均不在此发生)。

import type { ColumnarFrame } from '../contract';

import type { MetricTableRow } from './MetricTable';

/** 返回序列最后一个非 NaN 值;全为 NaN 或空则返回 NaN。 */
function latestValue(values: Float64Array): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (!Number.isNaN(values[i])) {
      return values[i];
    }
  }
  return NaN;
}

/**
 * 把列式帧的每条序列投影为一行(指标名 + 标签 + 当前值)。
 * 行顺序与 frame.series 一致——不重排,排序属上游职责。
 */
export function columnarToMetricRows(frame: ColumnarFrame): MetricTableRow[] {
  return frame.series.map((series) => ({
    key: series.key,
    name: series.name,
    labels: series.labels,
    value: latestValue(series.values),
  }));
}
