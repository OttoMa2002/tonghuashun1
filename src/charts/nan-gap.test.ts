import { describe, it, expect } from 'vitest';
import uPlot from 'uplot';

// T10 首验(charts/CLAUDE.md 规则 5、契约 §6/§8-3):
// 实测 uPlot 的间隙哨兵到底是 null 还是 NaN。
//
// 结论(本测试断言固化):
//   - `null`(普通数组)→ uPlot 判定为间隙(findGaps / linear builder 用 `=== null`)。
//   - `NaN`(typed 或普通数组)→ 不产生间隙。NaN `!= null` 成立,被当作有效值送进 lineTo,
//     canvas 忽略非有限坐标,相邻有效点直连跨越——视觉上无间隙。
//   - Float64Array 存不了 null(强制为 0)。
//   ⇒ 契约 §6 期望的「Float64Array + NaN + 关 spanGaps → 间隙」被证伪;
//     启用 §8-3 预授权降级:含 NaN 序列转 (number|null)[],NaN→null(见 toUplotData)。
//   ⇒ 此结论须经人工回写 data-contract.md §6/§8-3。

/** 安装 jsdom 缺失的 canvas / Path2D / bbox 桩,使 uPlot 能真正跑一次绘制。 */
async function withCanvasStubs<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (prop === 'canvas') return { width: 600, height: 400, style: {} };
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'fillStyle' || prop === 'strokeStyle') return '#000';
      if (prop === 'lineWidth' || prop === 'globalAlpha') return 1;
      if (prop === 'font') return '10px';
      return () => {};
    },
    set() {
      return true;
    },
  });
  const canvasProto = globalThis.HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const elemProto = globalThis.Element.prototype as unknown as { getBoundingClientRect: unknown };
  const g = globalThis as unknown as { Path2D?: unknown };

  const origGetContext = canvasProto.getContext;
  const origRect = elemProto.getBoundingClientRect;
  const origPath2D = g.Path2D;

  canvasProto.getContext = () => ctx;
  elemProto.getBoundingClientRect = () => ({
    width: 600,
    height: 400,
    top: 0,
    left: 0,
    right: 600,
    bottom: 400,
    x: 0,
    y: 0,
  });
  class FakePath2D {
    moveTo(): void {}
    lineTo(): void {}
    arc(): void {}
    rect(): void {}
    closePath(): void {}
    addPath(): void {}
  }
  g.Path2D = FakePath2D;

  try {
    return await fn();
  } finally {
    canvasProto.getContext = origGetContext;
    elemProto.getBoundingClientRect = origRect;
    g.Path2D = origPath2D;
  }
}

/** 用真实 linear 构建器渲染一次三点序列,返回它判定出的间隙数(像素区间数组长度)。 */
async function gapCount(ydata: ReadonlyArray<number | null> | Float64Array): Promise<number> {
  return withCanvasStubs(async () => {
    let gaps: ReadonlyArray<unknown> = [];
    const realLinear = uPlot.paths.linear!();
    const opts: uPlot.Options = {
      width: 600,
      height: 400,
      series: [
        {},
        {
          stroke: 'red',
          spanGaps: false,
          paths: (u, si, i0, i1) => {
            const res = realLinear(u, si, i0, i1);
            gaps = res?.gaps ?? [];
            return res;
          },
        },
      ],
    };
    const data = [[1, 2, 3], ydata] as unknown as uPlot.AlignedData;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const plot = new uPlot(opts, data, root);
    // 初始绘制经 microtask 提交,刷两拍让 linear builder 真正执行。
    await Promise.resolve();
    await Promise.resolve();
    plot.destroy();
    return gaps.length;
  });
}

describe('T10 首验:uPlot 间隙哨兵是 null 而非 NaN', () => {
  it('null(普通数组)→ 产生间隙', async () => {
    expect(await gapCount([10, null, 30])).toBeGreaterThan(0);
  });

  it('NaN(Float64Array)→ 不产生间隙', async () => {
    expect(await gapCount(Float64Array.from([10, NaN, 30]))).toBe(0);
  });

  it('NaN(普通数组)→ 同样不产生间隙', async () => {
    expect(await gapCount([10, NaN, 30])).toBe(0);
  });

  it('Float64Array 无法承载 null:null 被强制为 0', () => {
    expect(Float64Array.from([10, null as unknown as number, 30])[1]).toBe(0);
  });
});
