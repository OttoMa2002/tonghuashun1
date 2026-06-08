// Transferable 移交语义单测(T05 DoD):移交后源 buffer 不可用(§6)。
// collectTransferables 收集 ts + 各 values 的 buffer;经 structuredClone 的 transfer 选项
// 模拟 postMessage 的真实 detach 行为,断言源 buffer 被 detach(byteLength 归零)。

import { describe, expect, it } from 'vitest';

import type { ColumnarFrame } from '../contract';

import { collectTransferables } from './transferables';

function makeFrame(): ColumnarFrame {
  return {
    ts: Float64Array.from([0, 10, 20]),
    series: [
      { key: 'a', name: 'a', labels: {}, values: Float64Array.from([1, 2, 3]) },
      { key: 'b', name: 'b', labels: {}, values: Float64Array.from([4, 5, 6]) },
    ],
  };
}

describe('collectTransferables', () => {
  it('收集 ts + 每个 series.values 的 buffer', () => {
    const frame = makeFrame();
    const buffers = collectTransferables(frame);
    expect(buffers).toHaveLength(3);
    expect(buffers[0]).toBe(frame.ts.buffer);
    expect(buffers[1]).toBe(frame.series[0].values.buffer);
    expect(buffers[2]).toBe(frame.series[1].values.buffer);
  });

  it('移交后源 buffer 被 detach,Worker 侧不可再访问(§6 转移语义)', () => {
    const frame = makeFrame();
    const buffers = collectTransferables(frame);

    // 移交前可正常访问。
    expect(frame.ts.byteLength).toBeGreaterThan(0);

    // structuredClone 的 transfer 选项执行与 postMessage 一致的所有权转移(detach)。
    const cloned = structuredClone(frame, { transfer: buffers });

    // 接收侧拿到完整数据。
    expect(Array.from(cloned.ts)).toEqual([0, 10, 20]);
    expect(Array.from(cloned.series[0].values)).toEqual([1, 2, 3]);

    // 源 buffer 已 detach:byteLength 归零,不可再用。
    expect(frame.ts.byteLength).toBe(0);
    expect(frame.series[0].values.byteLength).toBe(0);
    expect(frame.series[1].values.byteLength).toBe(0);
  });
});
