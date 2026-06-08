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

  it('resize 触发 setSize 而非重建实例', () => {
    render(<TimeSeriesChart frame={frame(3)} options={OPTIONS} />);
    expect(observers.length).toBe(1);

    act(() => {
      observers[0].cb([{ contentRect: { width: 800, height: 400 } }]);
    });

    expect(spies.setSize).toHaveBeenCalledWith({ width: 800, height: 400 });
    expect(spies.ctor).toHaveBeenCalledTimes(1); // 未重建
    expect(spies.destroy).not.toHaveBeenCalled();
  });

  it('容器尺寸为 0 时 setSize 退回选项初值', () => {
    render(<TimeSeriesChart frame={frame(3)} options={OPTIONS} />);
    act(() => {
      observers[0].cb([{ contentRect: { width: 0, height: 0 } }]);
    });
    expect(spies.setSize).toHaveBeenCalledWith({ width: 600, height: 300 });
  });

  it('卸载销毁实例并断开 ResizeObserver,无残留', () => {
    const { unmount } = render(<TimeSeriesChart frame={frame(3)} options={OPTIONS} />);
    const ro = observers[0];

    unmount();

    expect(spies.destroy).toHaveBeenCalledTimes(1);
    expect(ro.disconnect).toHaveBeenCalledTimes(1);
  });
});
