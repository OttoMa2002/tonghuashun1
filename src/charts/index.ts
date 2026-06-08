// src/charts 公共出口:uPlot 封装。消费 ColumnarFrame(契约 §6),只渲染、不加工。

export { TimeSeriesChart } from './TimeSeriesChart';
export type { TimeSeriesChartProps, ChartDrawTiming } from './TimeSeriesChart';

export { createLineChartOptions } from './options';
export type { LineChartConfig, SeriesStyle } from './options';

export { toUplotData, toGappyColumn } from './toUplotData';
