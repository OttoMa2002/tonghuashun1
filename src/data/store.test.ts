import { describe, it, expect, vi } from 'vitest';

import type { ColumnarFrame, MatrixResponse } from '../contract';

import type { ColumnarStore } from './store';
import { createColumnarStore } from './store';

function frame(ts: number[]): ColumnarFrame {
  return {
    ts: Float64Array.from(ts),
    series: [{ key: 'up', name: 'up', labels: {}, values: Float64Array.from(ts.map(() => 1)) }],
  };
}

describe('createColumnarStore', () => {
  it('set/get 往返同一引用', () => {
    const store = createColumnarStore();
    const f = frame([1, 2, 3]);
    store.set('q', f);
    expect(store.get('q')).toBe(f);
    expect(store.get('missing')).toBeUndefined();
  });

  it('set 与 delete 通知订阅者,退订后不再通知', () => {
    const store = createColumnarStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set('q', frame([1]));
    expect(listener).toHaveBeenCalledTimes(1);

    store.delete('q');
    expect(listener).toHaveBeenCalledTimes(2);

    // 删除不存在的 key 不触发通知。
    store.delete('q');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.set('q', frame([2]));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('职责测试:store 只接受列式快照,matrix 类型必须被编译期拒绝(DoD)', () => {
    // 仅编译期断言:matrix 是传输格式,不得进入主线程 store(architecture.md §5.5)。
    // 该函数永不执行,存在意义是让 tsc 校验下面这行——若 set 接受了 matrix,@ts-expect-error 会反过来报错。
    function _typeGuard(store: ColumnarStore, matrix: MatrixResponse): void {
      // @ts-expect-error DoD 职责断言:store.set 第二参仅接受 ColumnarFrame,matrix 结构必须类型报错
      store.set('q', matrix);
    }
    expect(typeof _typeGuard).toBe('function');
  });
});
