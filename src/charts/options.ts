import type uPlot from 'uplot';

// uPlot 选项构造器。契约 §6 消费方注记的两条强制规则在此落地:
//   1. ts 单位是毫秒;uPlot 默认按秒解释 x。这里用自定义 formatter 把数值当 ms 解释,
//      禁止对 ts 数组做 ÷1000 换算(逐元素换算属主线程数据加工 + 产生拷贝)。
//   2. 间隙须显示:序列一律 spanGaps:false。配合 toUplotData 的 NaN→null,null 处断线成间隙。

/** 把毫秒时间戳格式化为 HH:MM:SS(本地时区),不做 ÷1000。 */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface SeriesStyle {
  label: string;
  stroke: string;
}

export interface LineChartConfig {
  width: number;
  height: number;
  series: SeriesStyle[];
}

/**
 * 构造一条折线图的 uPlot 选项。消费方应对返回值保持引用稳定
 * (useMemo 或模块常量),它仅在实例创建时被消费一次(uplot-react skill)。
 */
export function createLineChartOptions(config: LineChartConfig): uPlot.Options {
  return {
    width: config.width,
    height: config.height,
    series: [
      // x 轴:鼠标悬停时以 ms formatter 显示时间。
      { value: (_self, rawValue) => fmtClock(rawValue) },
      ...config.series.map((s) => ({
        label: s.label,
        stroke: s.stroke,
        // 契约 §6:NaN→null 后须关 spanGaps,否则跨空点连线、间隙不可见。
        spanGaps: false,
      })),
    ],
    axes: [
      // x 轴刻度:把 splits(ms 数值)当毫秒格式化,禁止 ÷1000。
      { values: (_self, splits) => splits.map((ms) => fmtClock(ms)) },
      {},
    ],
    cursor: { drag: { x: true, y: false } },
  };
}
