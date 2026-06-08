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
      const { width, height } = entry.contentRect;
      // 尺寸变化走 setSize,绝不重建(uplot-react 反例 3)。容器尺寸为 0 时退回选项初值。
      plot.setSize({ width: width || options.width, height: height || options.height });
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

  return <div ref={rootRef} className={className} />;
}
