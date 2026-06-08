import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import type { ColumnarFrame } from '../contract';

import { toUplotData } from './toUplotData';

/**
 * 一次同步绘制的实测耗时(T17)。`init` = 首次 new uPlot 构造绘制,
 * `update` = 后续 setData 重绘。durationMs 由 performance.now() 直接括住
 * 同步绘制调用得到,不含 rAF/effect 调度间隔,故覆盖真实主线程绘制开销。
 */
export interface ChartDrawTiming {
  phase: 'init' | 'update';
  durationMs: number;
}

export interface TimeSeriesChartProps {
  /** 列式快照(契约 §6)。变化即走 setData,绝不重建实例。 */
  frame: ColumnarFrame;
  /**
   * uPlot 选项。调用方须保持引用稳定(useMemo 或模块常量,见 uplot-react skill);
   * 它仅在实例创建时消费一次,后续变更不会重新初始化。用 createLineChartOptions 构造。
   */
  options: uPlot.Options;
  className?: string;
  /**
   * 同步绘制实测耗时回调(T17,可选)。在 new uPlot / setData 同步返回后立即触发,
   * 上报真实主线程绘制耗时。仅作测量上报,不参与数据加工。
   */
  onDrawMeasured?: (timing: ChartDrawTiming) => void;
}

/**
 * uPlot 的 React 封装:实例只创建一次,数据更新走 setData,
 * 尺寸变化走 ResizeObserver → setSize,卸载时销毁实例并断开 observer。
 * 反模式对照见 uplot-react skill。
 */
export function TimeSeriesChart({
  frame,
  options,
  className,
  onDrawMeasured,
}: TimeSeriesChartProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // 回调存 ref:最新值随 render 刷新,绘制 effect 无需把它进依赖而重建实例(规则 6 同理)。
  const onDrawMeasuredRef = useRef(onDrawMeasured);
  onDrawMeasuredRef.current = onDrawMeasured;

  // 创建一次:依赖数组刻意为空。frame/options 的初值在此被消费,
  // 后续 frame 变更走下方 setData effect,options 要求引用稳定故无需进依赖。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    // 数据形状先备好(toUplotData 为既有加工,不计入绘制窗口),
    // performance.now() 只括住同步绘制点 new uPlot —— 这才是真实首帧绘制耗时(T17)。
    const initData = toUplotData(frame);
    const drawStart = performance.now();
    const plot = new uPlot(options, initData, root);
    onDrawMeasuredRef.current?.({ phase: 'init', durationMs: performance.now() - drawStart });
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

  // 数据更新:只走 setData,复用既有实例;同样用 performance.now() 括住同步重绘。
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) {
      return;
    }
    const nextData = toUplotData(frame);
    const drawStart = performance.now();
    plot.setData(nextData);
    onDrawMeasuredRef.current?.({ phase: 'update', durationMs: performance.now() - drawStart });
  }, [frame]);

  // root 用固定 CSS height(非 minHeight),从源头掐断「外高反喂画布」的回环:
  // 容器高恒等于 options.height,ResizeObserver 观测到的高度不再随画布增长(T16)。
  return <div ref={rootRef} className={className} style={{ height: options.height }} />;
}
