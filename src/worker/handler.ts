// 消息分发(T05)。契约 §5 / src/worker/CLAUDE.md 规则 3、6:
//  - 一切消息走信封格式(id 原样回带),每个 query.exec 必有且只有一个回执(result 或 error)
//  - 禁止吞错:任何失败路径都发 query.error 并带 kind,沉默失败会让调度器退避逻辑失明
//
// 流程:query.exec → source 取数 → matrix→列式 → query.result(大数组 Transferable 移交);
//       query.cancel → abort 对应 in-flight,取数返回后若已取消则发 query.error(kind:'aborted')。

import type {
  ColumnarFrame,
  Envelope,
  MainToWorkerMessage,
  QueryErrorKind,
  QueryExecMessage,
  QueryExecPayload,
  WorkerToMainMessage,
} from '../contract';

import { FrameParseError, countRawPoints, matrixToColumnar } from './transform';
import { collectTransferables } from './transferables';
import { computeRateFrame } from './rate-pipeline';
import type { MetricTypeResolver, QuerySource } from './source';

/** post 回调:Worker 入口绑定到 self.postMessage(message, transfer)。 */
export type PostReceipt = (message: WorkerToMainMessage, transfer: ArrayBuffer[]) => void;

export interface QueryHandlerDeps {
  source: QuerySource;
  post: PostReceipt;
  /**
   * metric-type 解析(ADR-0010):rate 校验「命中非 counter → bad_request」所需。
   * range 数据(MatrixResponse,§2)不携带 type,类型是独立元信息,故经独立 seam 注入。
   * 省略时 rate 的非 counter 校验视作无命中(不阻断);Worker 接线(index.ts)必接入,rate 单测显式注入。
   */
  resolveSeriesTypes?: MetricTypeResolver;
  /** 计时源,默认 performance.now;测试可注入以断言 elapsedMs。 */
  now?: () => number;
}

export interface QueryHandler {
  /** 分发一条主线程消息。query.exec 异步取数,返回的 Promise 仅供测试 await。 */
  handle(message: MainToWorkerMessage): Promise<void>;
}

/** mock ErrorResponse.errorType → 回执 QueryErrorKind(§5)。bad_request/internal 归 http。 */
function errorKindOf(errorType: 'timeout' | 'internal' | 'bad_request'): QueryErrorKind {
  return errorType === 'timeout' ? 'timeout' : 'http';
}

/** 未预期异常 → 回执 kind:FrameParseError→parse,AbortError→aborted,其余按 http(取数失败)。 */
function kindOfThrown(err: unknown): QueryErrorKind {
  if (err instanceof FrameParseError) {
    return 'parse';
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'aborted';
  }
  return 'http';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createQueryHandler(deps: QueryHandlerDeps): QueryHandler {
  const now = deps.now ?? (() => performance.now());
  /** in-flight 取消控制:queryId → AbortController(§5 in-flight 去重以未收回执为判定)。 */
  const inFlight = new Map<string, AbortController>();

  function emitError(id: string, queryId: string, kind: QueryErrorKind, message: string): void {
    const envelope: Envelope<'query.error', { queryId: string; kind: QueryErrorKind; message: string }> = {
      id,
      type: 'query.error',
      payload: { queryId, kind, message },
    };
    deps.post(envelope, []);
  }

  /**
   * 发 query.result:把列式帧 + meta 装信封,大数组经 Transferable 移交(§5、§6)。
   * meta.rawPointCount 取底层 matrix 的样本总数(rate 路径即 [start-window, end] 区间内的底层样本)。
   */
  function emitResult(
    id: string,
    queryId: string,
    frame: ColumnarFrame,
    rawPointCount: number,
    elapsedMs: number,
  ): void {
    const resultEnvelope: WorkerToMainMessage = {
      id,
      type: 'query.result',
      payload: { queryId, frame, meta: { rawPointCount, elapsedMs } },
    };
    deps.post(resultEnvelope, collectTransferables(frame));
  }

  async function handleExec(message: QueryExecMessage): Promise<void> {
    const { id } = message;
    const payload: QueryExecPayload = message.payload;
    const { queryId } = payload;
    const controller = new AbortController();
    inFlight.set(queryId, controller);
    const startedAt = now();

    try {
      if (payload.rate) {
        await handleRateExec(id, payload, controller, startedAt);
        return;
      }

      const response = await deps.source(payload, controller.signal);

      // 取数返回后若已被 cancel:不发 result,改发 aborted(每查询仍只一个回执)。
      if (controller.signal.aborted) {
        emitError(id, queryId, 'aborted', `queryId=${queryId} 已取消`);
        return;
      }

      if (response.status === 'error') {
        emitError(id, queryId, errorKindOf(response.errorType), response.message);
        return;
      }

      const frame = matrixToColumnar(response);
      emitResult(id, queryId, frame, countRawPoints(response), now() - startedAt);
    } catch (err) {
      emitError(id, queryId, kindOfThrown(err), messageOf(err));
    } finally {
      inFlight.delete(queryId);
    }
  }

  /**
   * rate 查询路径(ADR-0010、§3 栅格 rate)。校验 → 取 [start-window, end] 底层样本 → 栅格逐点 counterRate。
   *
   * 校验(均为 bad_request;§5 query.error kind 无 bad_request,沿用 errorKindOf 既定映射 bad_request→'http',
   * 与 handler 对 mock bad_request 的处置一致):
   *  - 无 stepMillis:rate 须 stepped(§5、ADR-0010)
   *  - 命中非 counter:rate 仅对 counter 有效(ADR-0010);类型经 resolveSeriesTypes 解析(range 数据不带 type)
   * 求值在 computeRateFrame(本目录),底层取数仍走 source(fetch 只在 Worker,硬约束 4)。
   */
  async function handleRateExec(
    id: string,
    payload: QueryExecPayload,
    controller: AbortController,
    startedAt: number,
  ): Promise<void> {
    const { queryId } = payload;
    const rate = payload.rate;
    if (!rate) {
      return; // 调用方已保证 payload.rate 存在;此分支仅为窄化类型。
    }

    if (payload.stepMillis === undefined) {
      emitError(id, queryId, errorKindOf('bad_request'), 'rate 请求须同时带 stepMillis(§5、ADR-0010)');
      return;
    }

    const types = deps.resolveSeriesTypes?.(payload.selector) ?? [];
    if (types.some((type) => type !== 'counter')) {
      emitError(id, queryId, errorKindOf('bad_request'), 'rate 仅对 counter 序列有效,selector 命中非 counter(ADR-0010)');
      return;
    }

    // 底层取数:raw 模式([start-window, end] 内全部样本);内部有界回看,与「raw 仅 million-points 页」正交(ADR-0010)。
    const underlyingParams: QueryExecPayload = {
      ...payload,
      startMillis: payload.startMillis - rate.windowMillis,
      stepMillis: undefined,
      rate: undefined,
      downsample: undefined,
    };
    const response = await deps.source(underlyingParams, controller.signal);

    if (controller.signal.aborted) {
      emitError(id, queryId, 'aborted', `queryId=${queryId} 已取消`);
      return;
    }
    if (response.status === 'error') {
      emitError(id, queryId, errorKindOf(response.errorType), response.message);
      return;
    }

    const frame = computeRateFrame(response, {
      startMillis: payload.startMillis,
      endMillis: payload.endMillis,
      stepMillis: payload.stepMillis,
      windowMillis: rate.windowMillis,
    });
    emitResult(id, queryId, frame, countRawPoints(response), now() - startedAt);
  }

  function handleCancel(queryId: string): void {
    const controller = inFlight.get(queryId);
    if (controller) {
      controller.abort();
    }
    // 未在 in-flight:已收回执或从未发起,按 §5「未收回执」语义无需动作,不发额外消息。
  }

  return {
    handle(message: MainToWorkerMessage): Promise<void> {
      if (message.type === 'query.exec') {
        return handleExec(message);
      }
      handleCancel(message.payload.queryId);
      return Promise.resolve();
    },
  };
}
