// 数据契约 §6:列式结构 ColumnarFrame。与 docs/data-contract.md §6 一一对应。

/**
 * 单序列的列式值数组。
 * 不变量:values.length === frame.ts.length;缺点以 NaN 表示。
 */
export interface ColumnarSeries {
  /** seriesKey() 规范化身份。 */
  key: string;
  name: string;
  labels: Record<string, string>;
  values: Float64Array;
}

/**
 * 列式帧。不变量:ts 严格递增(单位 tsMillis,§1);各 values 与 ts 等长;缺点 NaN。
 * ts 与各 values 的 buffer 经 Transferable 移交,移交后 Worker 侧不得再访问。
 * 消费方(charts)解释规则见 data-contract.md §6 消费方注记:
 * 以 formatter 把 ts 当 ms 解释,禁止数组换算;NaN 间隙须关闭 spanGaps。
 */
export interface ColumnarFrame {
  /** 严格递增,单位 tsMillis。 */
  ts: Float64Array;
  series: ColumnarSeries[];
}
