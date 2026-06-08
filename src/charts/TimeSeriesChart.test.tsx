import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

import type { ColumnarFrame } from '../contract';

import { TimeSeriesChart } from './TimeSeriesChart';
import { createLineChartOptions } from './options';

// uPlot 实例化依赖 canvas/Path2D,jsdom 无法真实渲染;此处 mock 掉,
// 只断言封装的生命周期调用次数(构造一次、setData/setSize/destroy 时机)。
const spies = vi.hoisted(() => ({
  ctor: vi.fn(),
  setData: vi.fn(),
  setSize: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('uplot', () => ({
  default: class {
    constructor(opts: unknown, data: unknown, root: HTMLElement) {
      spies.ctor(opts, data, root);
    }
    setData = spies.setData;
    setSize = spies.setSize;
    destroy = spies.destroy;
  },
}));

vi.mock('uplot/dist/uPlot.min.css', () => ({}));

// jsdom 无 ResizeObserver:用可手动触发回调的桩替代。
type ROEntryLike = { contentRect: { width: number; height: number } };
const observers: Array<{ cb: (entries: ROEntryLike[]) => void; disconnect: ReturnType<typeof vi.fn> }> =
  [];

beforeEach(() => {
  spies.ctor.mockClear();
  spies.setData.mockClear();
  spies.setSize.mockClear();
  spies.destroy.mockClear();
  observers.length = 0;
  class MockResizeObserver {
    cb: (entries: ROEntryLike[]) => void;
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
    constructor(cb: (entries: ROEntryLike[]) => void) {
      this.cb = cb;
      observers.push({ cb, disconnect: this.disconnect });
    }
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
});

const OPTIONS = createLineChartOptions({
  width: 600,
  height: 300,
  series: [{ label: 'up', stroke: 'red' }],
});

function frame(n: number): ColumnarFrame {
  const ts = Float64Array.from({ length: n }, (_v, i) => i * 1000);
  return { ts, series: [{ key: 'up', name: 'up', labels: {}, values: ts.slice() }] };
}

describe('TimeSeriesChart 生命周期', () => {
  it('frame 变化 N 次,uPlot 构造函数只调用一次(走 setData)', () => {
    const { rerender } = render(<TimeSeriesChart frame={frame(3)} options={OPTIONS} />);
    rerender(<TimeSeriesChart frame={frame(4)} options={OPTIONS} />);
    rerender(<TimeSeriesChart frame={frame(5)} options={OPTIONS} />);

    expect(spies.ctor).toHaveBeenCalledTimes(1);
    // 挂载 setData 1 次 + 两次 frame 变更各 1 次 = 3。
    expect(spies.setData).toHaveBeenCalledTimes(3);
  });

  it('同一 frame 重渲染不触发额外 setData', () => {
    const f = frame(3);
    const { rerender } = render(<TimeSeriesChart frame={f} options={OPTIONS} />);
    rerender(<TimeSeriesChart frame={f} options={OPTIONS} />);

    expect(spies.ctor).toHaveBeenCalledTimes(1);
    expect(spies.setData).toHaveBeenCalledTimes(1); // frame 引用未变
  });

  it('resize 触发 setSize 而非重建实例,width 跟随容器、height 恒用选项', () => {
    render(<TimeSeriesChart frame={frame(3)} options={OPTIONS} />);
    expect(observers.length).toBe(1);

    act(() => {
      observers[0].cb([{ contentRect: { width: 800, height: 400 } }]);
    });

    // width 跟随容器(800);height 不取观测值(400),恒用 options.height(300)。
    expect(spies.setSize).toHaveBeenCalledWith({ width: 800, height: 300 });
    expect(spies.ctor).toHaveBeenCalledTimes(1); // 未重建
    expect(spies.destroy).not.toHaveBeenCalled();
  });

  it('观测高递增时 setSize 的 height 恒等于 options.height(不随观测高增长)', () => {
    render(<TimeSeriesChart frame={frame(3)} options={OPTIONS} />);

    // 模拟 ResizeObserver 无界增长场景:contentRect.height 逐次递增。
    const observedHeights = [300, 360, 600, 1200];
    act(() => {
      for (const h of observedHeights) {
        observers[0].cb([{ contentRect: { width: 800, height: h } }]);
      }
    });

    // 每次 setSize 的 height 实参都必须是 options.height(300),width 跟随容器(800)。
    for (const call of spies.setSize.mock.calls) {
      expect(call[0]).toEqual({ width: 800, height: 300 });
    }
    expect(spies.setSize).toHaveBeenCalledTimes(observedHeights.length);
    expect(spies.ctor).toHaveBeenCalledTimes(1); // 全程未重建
    expect(spies.destroy).not.toHaveBeenCalled();
  });

  it('容器宽为 0 时 setSize 宽退回选项初值,高恒用选项', () => {
    render(<TimeSeriesChart frame={frame(3)} options={OPTIONS} />);
    act(() => {
      observers[0].cb([{ contentRect: { width: 0, height: 0 } }]);
    });
    expect(spies.setSize).toHaveBeenCalledWith({ width: 600, height: 300 });
  });

  it('T17:绘制耗时回调同步括住 new uPlot —— 挂载即报 init,frame 变更报 update', () => {
    const measured: Array<{ phase: 'init' | 'update'; durationMs: number }> = [];
    const onDrawMeasured = vi.fn((t: { phase: 'init' | 'update'; durationMs: number }) => {
      measured.push(t);
    });

    const { rerender } = render(
      <TimeSeriesChart frame={frame(3)} options={OPTIONS} onDrawMeasured={onDrawMeasured} />,
    );

    // 同步边界佐证:render 返回(effect 已 flush,未经任何 rAF)时 init 已上报,
    // 且发生在 ctor 调用之后 —— 证明 performance.now() 括住的是真实同步绘制点,而非 rAF 代理。
    expect(spies.ctor).toHaveBeenCalledTimes(1);
    const initTimings = measured.filter((t) => t.phase === 'init');
    expect(initTimings).toHaveLength(1);
    expect(Number.isFinite(initTimings[0].durationMs)).toBe(true);
    expect(initTimings[0].durationMs).toBeGreaterThanOrEqual(0);

    // frame 变更:走 setData 重绘,上报 update(实例不重建)。
    rerender(<TimeSeriesChart frame={frame(4)} options={OPTIONS} onDrawMeasured={onDrawMeasured} />);
    expect(spies.ctor).toHaveBeenCalledTimes(1);
    const updateTimings = measured.filter((t) => t.phase === 'update');
    // 挂载 setData(1)+ 一次 frame 变更(1)= 2 次 update 上报。
    expect(updateTimings).toHaveLength(2);
    expect(Number.isFinite(updateTimings[0].durationMs)).toBe(true);
  });

  it('卸载销毁实例并断开 ResizeObserver,无残留', () => {
    const { unmount } = render(<TimeSeriesChart frame={frame(3)} options={OPTIONS} />);
    const ro = observers[0];

    unmount();

    expect(spies.destroy).toHaveBeenCalledTimes(1);
    expect(ro.disconnect).toHaveBeenCalledTimes(1);
  });
});
