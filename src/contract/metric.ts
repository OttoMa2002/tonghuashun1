// 数据契约 §1:数据模型。与 docs/data-contract.md §1 一一对应,修改须经人工(ADR-0008)。

/** 指标类型。counter 单调不减(重置点除外);gauge 直读。 */
export type MetricType = 'counter' | 'gauge';

/** 标签集:键值均为字符串。 */
export type LabelSet = Record<string, string>;

/** 指标标识:name + 类型 + 标签。 */
export interface Metric {
  name: string;
  type: MetricType;
  labels: LabelSet;
}

/**
 * 样本:[tsMillis, value]。
 * tsMillis 为 Unix 毫秒整数(审定 §8-1);value 为 number,缺点以 NaN 表示(§6)。
 */
export type Sample = readonly [tsMillis: number, value: number];

/**
 * Series 身份规范化(§1):name + labels 按 key 字典序拼接为稳定字符串。
 * mock 与 worker 必须共用本函数,禁止各写一份(防止规范化漂移)。
 */
export function seriesKey(name: string, labels: LabelSet): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
}
