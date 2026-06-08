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

import { createFaultInjector } from '../mock/fault';
import { generateSeries } from '../mock/generator';

import { createQueryHandler } from './handler';
import { createMockMetricTypeResolver, createMockSource, type MetricTypeResolver, type QuerySource } from './source';

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

function setup(source: QuerySource, now?: () => number, resolveSeriesTypes?: MetricTypeResolver) {
  const posts: Array<{ message: WorkerToMainMessage; transfer: ArrayBuffer[] }> = [];
  const handler = createQueryHandler({
    source,
    resolveSeriesTypes,
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

describe('createQueryHandler — rate 查询路径(T15 / ADR-0010)', () => {
  function rateExec(overrides: Partial<QueryExecMessage['payload']> = {}): QueryExecMessage {
    return {
      id: 'env-r',
      type: 'query.exec',
      payload: {
        queryId: 'qr',
        selector: { name: 'reqs' },
        startMillis: 30_000,
        endMillis: 60_000,
        stepMillis: 15_000,
        rate: { windowMillis: 30_000 },
        ...overrides,
      },
    };
  }

  it('rate 无 stepMillis → bad_request(回执 kind=http,沿用既定 bad_request→http 映射),不取数', async () => {
    const source = vi.fn<QuerySource>(() => Promise.resolve(success));
    const resolver: MetricTypeResolver = () => ['counter'];
    const { handler, posts } = setup(source, undefined, resolver);

    await handler.handle(rateExec({ stepMillis: undefined }));

    expect(posts).toHaveLength(1);
    if (posts[0].message.type !== 'query.error') throw new Error('unreachable');
    expect(posts[0].message.payload.kind).toBe('http');
    expect(posts[0].message.payload.message).toContain('stepMillis');
    expect(source).not.toHaveBeenCalled(); // 校验先行,未取数
  });

  it('rate 命中非 counter(gauge)→ bad_request(kind=http),不取数', async () => {
    const source = vi.fn<QuerySource>(() => Promise.resolve(success));
    const resolver: MetricTypeResolver = () => ['gauge'];
    const { handler, posts } = setup(source, undefined, resolver);

    await handler.handle(rateExec());

    expect(posts).toHaveLength(1);
    if (posts[0].message.type !== 'query.error') throw new Error('unreachable');
    expect(posts[0].message.payload.kind).toBe('http');
    expect(posts[0].message.payload.message).toContain('counter');
    expect(source).not.toHaveBeenCalled();
  });

  it('rate 命中混合(counter + gauge)→ bad_request(任一非 counter 即拒)', async () => {
    const resolver: MetricTypeResolver = () => ['counter', 'gauge'];
    const { handler, posts } = setup(() => Promise.resolve(success), undefined, resolver);
    await handler.handle(rateExec());
    if (posts[0].message.type !== 'query.error') throw new Error('unreachable');
    expect(posts[0].message.payload.kind).toBe('http');
  });

  it('rate 底层取数走 [start-window, end] 的 raw 模式(无 step、无 rate 字段下发 source)', async () => {
    const source = vi.fn<QuerySource>(() => Promise.resolve(success));
    const resolver: MetricTypeResolver = () => ['counter'];
    const { handler } = setup(source, undefined, resolver);

    await handler.handle(rateExec());

    expect(source).toHaveBeenCalledTimes(1);
    const underlying = source.mock.calls[0][0];
    expect(underlying.startMillis).toBe(30_000 - 30_000); // start - window
    expect(underlying.endMillis).toBe(60_000);
    expect(underlying.stepMillis).toBeUndefined(); // raw 底层取数
    expect(underlying.rate).toBeUndefined();
  });

  it('集成:generateSeries + queryRange 端到端产出 rate frame(每点 = trailing counterRate)', async () => {
    // counter:每 15s 固定增 10([10,10] 增量,prng 不影响),栅格 0..120000 → 值 0,10,...,80。
    const dataset = generateSeries(
      { name: 'reqs', type: 'counter', labelSets: [{ job: 'api' }], stepIncrement: [10, 10] },
      { startMillis: 0, endMillis: 120_000, stepMillis: 15_000 },
      7,
    );
    const source = createMockSource(createFaultInjector(dataset));
    const resolver = createMockMetricTypeResolver(dataset);
    const { handler, posts } = setup(source, undefined, resolver);

    await handler.handle(
      rateExec({
        queryId: 'qe',
        selector: { name: 'reqs', labels: { job: 'api' } },
        startMillis: 60_000,
        endMillis: 120_000,
        stepMillis: 30_000,
        rate: { windowMillis: 60_000 },
      }),
    );

    expect(posts).toHaveLength(1);
    const msg = posts[0].message;
    expect(msg.type).toBe('query.result');
    if (msg.type !== 'query.result') throw new Error('unreachable');
    const { frame } = msg.payload;
    // 栅格点 60000,90000,120000;每窗 5 样本、增量 40、时长 60s → rate = 40/60。
    expect(Array.from(frame.ts)).toEqual([60_000, 90_000, 120_000]);
    expect(frame.series).toHaveLength(1);
    expect(frame.series[0].key).toBe('reqs{job=api}');
    for (const v of frame.series[0].values) {
      expect(v).toBeCloseTo(40 / 60, 9);
    }
    // 大数组经 Transferable 移交:ts buffer + 1 series values buffer。
    expect(posts[0].transfer).toHaveLength(2);
    expect(posts[0].transfer[0]).toBe(frame.ts.buffer);
  });

  it('集成:selector 命中空 → 成功空 rate frame(无命中即无非 counter,不报错)', async () => {
    const dataset = generateSeries(
      { name: 'reqs', type: 'counter', labelSets: [{ job: 'api' }], stepIncrement: [10, 10] },
      { startMillis: 0, endMillis: 120_000, stepMillis: 15_000 },
      7,
    );
    const source = createMockSource(createFaultInjector(dataset));
    const resolver = createMockMetricTypeResolver(dataset);
    const { handler, posts } = setup(source, undefined, resolver);

    await handler.handle(rateExec({ selector: { name: 'nonexistent' } }));

    expect(posts).toHaveLength(1);
    if (posts[0].message.type !== 'query.result') throw new Error('unreachable');
    expect(posts[0].message.payload.frame.series).toHaveLength(0);
  });
});
