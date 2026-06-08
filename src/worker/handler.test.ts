// 消息分发单测(T05 DoD：协议消息全走 contract 类型；每 exec 必有且只有一个回执)。
// 覆盖:exec→result(含 Transferable 列表与 meta)、ErrorResponse→kind 映射、
// 列式化违例→parse、cancel 在取数返回后→aborted。

import { describe, expect, it, vi } from 'vitest';

import type {
  MainToWorkerMessage,
  QueryExecMessage,
  QueryRangeResponse,
  WorkerToMainMessage,
} from '../contract';

import { createQueryHandler } from './handler';
import type { QuerySource } from './source';

function exec(overrides: Partial<QueryExecMessage['payload']> = {}): QueryExecMessage {
  return {
    id: 'env-1',
    type: 'query.exec',
    payload: { queryId: 'q1', selector: { name: 'm' }, startMillis: 0, endMillis: 100, ...overrides },
  };
}

function cancel(queryId: string): MainToWorkerMessage {
  return { id: 'env-c', type: 'query.cancel', payload: { queryId } };
}

const success: QueryRangeResponse = {
  status: 'success',
  data: { result: [{ metric: { name: 'm', labels: { job: 'x' } }, values: [[0, 1], [50, 2], [100, 3]] }] },
};

function setup(source: QuerySource, now?: () => number) {
  const posts: Array<{ message: WorkerToMainMessage; transfer: ArrayBuffer[] }> = [];
  const handler = createQueryHandler({
    source,
    post: (message, transfer) => posts.push({ message, transfer }),
    now,
  });
  return { handler, posts };
}

describe('createQueryHandler', () => {
  it('query.exec 成功 → 单条 query.result,id 原样回带,frame/meta 正确,transfer 携带 buffer', async () => {
    let t = 0;
    const { handler, posts } = setup(
      () => Promise.resolve(success),
      () => (t += 10), // 两次调用相差 10ms → elapsedMs=10
    );

    await handler.handle(exec());

    expect(posts).toHaveLength(1);
    const { message, transfer } = posts[0];
    expect(message.type).toBe('query.result');
    expect(message.id).toBe('env-1');
    if (message.type !== 'query.result') throw new Error('unreachable');
    expect(message.payload.queryId).toBe('q1');
    expect(Array.from(message.payload.frame.ts)).toEqual([0, 50, 100]);
    expect(Array.from(message.payload.frame.series[0].values)).toEqual([1, 2, 3]);
    expect(message.payload.meta.rawPointCount).toBe(3);
    expect(message.payload.meta.elapsedMs).toBe(10);
    // transfer = ts buffer + 1 series values buffer。
    expect(transfer).toHaveLength(2);
    expect(transfer[0]).toBe(message.payload.frame.ts.buffer);
  });

  it('ErrorResponse(timeout) → query.error kind=timeout', async () => {
    const { handler, posts } = setup(() =>
      Promise.resolve({ status: 'error', errorType: 'timeout', message: 'boom' } satisfies QueryRangeResponse),
    );
    await handler.handle(exec());
    expect(posts).toHaveLength(1);
    expect(posts[0].message.type).toBe('query.error');
    if (posts[0].message.type !== 'query.error') throw new Error('unreachable');
    expect(posts[0].message.payload.kind).toBe('timeout');
    expect(posts[0].message.payload.message).toBe('boom');
  });

  it('ErrorResponse(internal / bad_request) → query.error kind=http', async () => {
    for (const errorType of ['internal', 'bad_request'] as const) {
      const { handler, posts } = setup(() => Promise.resolve({ status: 'error', errorType, message: 'x' }));
      await handler.handle(exec());
      if (posts[0].message.type !== 'query.error') throw new Error('unreachable');
      expect(posts[0].message.payload.kind).toBe('http');
    }
  });

  it('列式化违例(同 series 重复 ts)→ query.error kind=parse,不吞错', async () => {
    const dup: QueryRangeResponse = {
      status: 'success',
      data: { result: [{ metric: { name: 'm', labels: {} }, values: [[0, 1], [0, 2]] }] },
    };
    const { handler, posts } = setup(() => Promise.resolve(dup));
    await handler.handle(exec());
    expect(posts).toHaveLength(1);
    if (posts[0].message.type !== 'query.error') throw new Error('unreachable');
    expect(posts[0].message.payload.kind).toBe('parse');
  });

  it('取数返回前 cancel → 不发 result,改发 query.error kind=aborted(每查询仍只一个回执)', async () => {
    let resolve!: (r: QueryRangeResponse) => void;
    const pending = new Promise<QueryRangeResponse>((r) => {
      resolve = r;
    });
    const { handler, posts } = setup(() => pending);

    const done = handler.handle(exec({ queryId: 'q9' }));
    // 取数尚未返回时取消。
    await handler.handle(cancel('q9'));
    resolve(success);
    await done;

    expect(posts).toHaveLength(1);
    if (posts[0].message.type !== 'query.error') throw new Error('unreachable');
    expect(posts[0].message.payload.kind).toBe('aborted');
    expect(posts[0].message.payload.queryId).toBe('q9');
  });

  it('cancel 未知 queryId → 无副作用(不发任何回执)', async () => {
    const source = vi.fn<QuerySource>(() => Promise.resolve(success));
    const { handler, posts } = setup(source);
    await handler.handle(cancel('nope'));
    expect(posts).toHaveLength(0);
    expect(source).not.toHaveBeenCalled();
  });
});
