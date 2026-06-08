// Transferable 移交(T05)。契约 §6 / src/worker/CLAUDE.md 规则 4:
// ts 与各 values 的 buffer 必须经 Transferable 移交,移交后本侧不得再访问该 buffer。
// 本模块只负责「收集待移交 buffer 列表」,实际移交由 postMessage 完成(detach 是运行时行为)。

import type { ColumnarFrame } from '../contract';

/**
 * 收集一个 ColumnarFrame 中所有需移交的 ArrayBuffer:ts 一个 + 每个 series.values 一个。
 * 交给 postMessage 的 transfer 列表后,这些 buffer 会被 detach,Worker 侧不得再访问(§6)。
 *
 * 各 typed array 由 `new Float64Array(n)` 构建,其 buffer 必为 ArrayBuffer(非 SharedArrayBuffer);
 * `.buffer` 的静态类型是 ArrayBufferLike,此处断言为 ArrayBuffer 以匹配 Transferable(非 any 压制)。
 */
export function collectTransferables(frame: ColumnarFrame): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [frame.ts.buffer as ArrayBuffer];
  for (const s of frame.series) {
    buffers.push(s.values.buffer as ArrayBuffer);
  }
  return buffers;
}
