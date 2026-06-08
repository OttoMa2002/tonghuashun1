import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import type { ColumnarFrame } from '../contract';

import { toUplotData } from './toUplotData';

export interface TimeSeriesChartProps {
  /** 列式快照(契约 §6)。变化即走 setData,绝不重建实例。 */
  frame: ColumnarFrame;
  /**
   * uPlot 选项。调用方须保持引用稳定(useMemo 或模块常量,见 uplot-react skill);
   * 它仅在实例创建时消费一次,后续变更不会重新初始化。用 createLineChartOptions 构造。
   */
  options: uPlot.Options;
  className?: string;
}

/**
 * uPlot 的 React 封装:实例只创建一次,数据更新走 setData,
 * 尺寸变化走 ResizeObserver → setSize,卸载时销毁实例并断开 observer。
 * 反模式对照见 uplot-react skill。
 */
export function TimeSeriesChart({ frame, options, className }: TimeSeriesChartProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  // 创建一次:依赖数组刻意为空。frame/options 的初值在此被消费,
  // 后续 frame 变更走下方 setData effect,options 要求引用稳定故无需进依赖。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const plot = new uPlot(options, toUplotData(frame), root);
    plotRef.current = plot;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      // 只取观测宽度;高度恒用 options.height,绝不把观测高反喂画布(T16 诊断结论 2)。
      // 否则 root 外高 → 画布 → root 高的回环会让 ResizeObserver 无界增长。
      // 尺寸变化走 setSize,绝不重建(uplot-react 反例 3)。容器宽为 0 时退回选项初值。
      const { width } = entry.contentRect;
      plot.setSize({ width: width || options.width, height: options.height });
    });
    ro.observe(root);

    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, []);

  // 数据更新:只走 setData,复用既有实例。
  useEffect(() => {
    plotRef.current?.setData(toUplotData(frame));
  }, [frame]);

  // root 用固定 CSS height(非 minHeight),从源头掐断「外高反喂画布」的回环:
  // 容器高恒等于 options.height,ResizeObserver 观测到的高度不再随画布增长(T16)。
  return <div ref={rootRef} className={className} style={{ height: options.height }} />;
}
