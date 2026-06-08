// 主线程列式快照 store(T08)。architecture.md §5.5:store 只持有列式快照,转换在 Worker 完成。
// 硬约束 3:本文件不做任何数据加工——只存 ColumnarFrame、按 key 取用、变更通知订阅者。
// 接口刻意只接受 ColumnarFrame(契约 §6),matrix 等传输格式被类型系统拒绝(DoD 职责测试)。

import type { ColumnarFrame } from '../contract';

/**
 * 列式快照 store。键由消费方约定(通常为 queryId)。
 * 仅存储与通知,无解析/降采样/rate——那些只允许在 Worker 内发生(CLAUDE.md 硬约束 3)。
 */
export interface ColumnarStore {
  /** 写入/覆盖某 key 的列式快照。只接受 ColumnarFrame。 */
  set(key: string, frame: ColumnarFrame): void;
  /** 读取快照;无则 undefined。返回引用在下次 set 前保持稳定(供 useSyncExternalStore)。 */
  get(key: string): ColumnarFrame | undefined;
  /** 删除某 key 的快照。 */
  delete(key: string): void;
  /** 订阅任意写入/删除;返回退订函数。 */
  subscribe(listener: () => void): () => void;
}

export function createColumnarStore(): ColumnarStore {
  const frames = new Map<string, ColumnarFrame>();
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    set(key, frame) {
      frames.set(key, frame);
      emit();
    },
    get(key) {
      return frames.get(key);
    },
    delete(key) {
      if (frames.delete(key)) {
        emit();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
