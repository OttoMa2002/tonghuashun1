import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

import { MetricTable } from './MetricTable';
import type { MetricTableRow } from './MetricTable';

// TanStack Virtual 通过 scrollElement.offsetHeight 量视口高度(virtual-core getRect),
// 通过 scrollTop 量滚动偏移。jsdom 不布局,二者恒为 0;此处为 scroll 容器桩入固定视口高度,
// 行高走 estimateSize 常量(不测量行元素),使虚拟化在 jsdom 下确定可测。
const ROW_HEIGHT = 32;
const VIEWPORT = 480; // 480 / 32 = 15 行可见

let originalOffsetHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  // virtual-core 的 ResizeObserver 仅用于尺寸变化后的重测量,初始测量走同步 getRect;
  // 提供 no-op 桩避免 ReferenceError 即可。
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;

  originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'metric-table-scroll' ? VIEWPORT : 0;
    },
  });
});

afterEach(() => {
  cleanup();
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  }
});

function makeRows(n: number): MetricTableRow[] {
  return Array.from({ length: n }, (_v, i) => ({
    key: `metric_${i}`,
    name: `metric_${i}`,
    labels: { instance: `node-${i}` },
    value: i,
  }));
}

function scrollTo(el: HTMLElement, top: number): void {
  act(() => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  });
}

describe('MetricTable 虚拟化', () => {
  it('万行数据下实际 DOM 行数 < 50(虚拟化生效)', () => {
    const { container } = render(<MetricTable rows={makeRows(10_000)} rowHeight={ROW_HEIGHT} height={VIEWPORT} />);

    const domRows = container.querySelectorAll('[data-testid="metric-row"]');
    // 可见 15 行 + 两侧 overscan 8 ≈ 31,远小于 50,且与 10000 无关。
    expect(domRows.length).toBeLessThan(50);
    expect(domRows.length).toBeGreaterThan(0);
  });

  it('行渲染数与视口挂钩:视口越矮渲染行越少', () => {
    const tall = render(<MetricTable rows={makeRows(10_000)} rowHeight={ROW_HEIGHT} height={VIEWPORT} />);
    const tallCount = tall.container.querySelectorAll('[data-testid="metric-row"]').length;
    cleanup();

    // 半高视口应渲染更少行(可见行数减半)。
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'metric-table-scroll' ? VIEWPORT / 2 : 0;
      },
    });
    const short = render(<MetricTable rows={makeRows(10_000)} rowHeight={ROW_HEIGHT} height={VIEWPORT / 2} />);
    const shortCount = short.container.querySelectorAll('[data-testid="metric-row"]').length;

    expect(shortCount).toBeLessThan(tallCount);
  });

  it('滚动时无整表重渲:留在视口内的行不重渲(memo 生效)', () => {
    const rows = makeRows(10_000);
    const onRowRender = vi.fn<(key: string) => void>();
    const scroll = render(
      <MetricTable rows={rows} rowHeight={ROW_HEIGHT} height={VIEWPORT} onRowRender={onRowRender} />,
    ).container.querySelector('[data-testid="metric-table-scroll"]') as HTMLElement;

    // 挂载阶段的渲染探针先清零,只观测滚动引发的渲染。
    onRowRender.mockClear();

    // 下滚 5 行:窗口整体后移 5,只有新进入的少量行应重渲。
    scrollTo(scroll, 5 * ROW_HEIGHT);

    const rerendered = new Set(onRowRender.mock.calls.map(([key]) => key));

    // 滚动确实带入了新行……
    expect(rerendered.size).toBeGreaterThan(0);
    // ……但远不是整窗(≈23 行)更不是万行重渲。
    expect(rerendered.size).toBeLessThan(12);
    // metric_10 在滚动前后都在视口内,props 全稳定 → memo 命中 → 不应重渲。
    expect(rerendered.has('metric_10')).toBe(false);
  });
});
