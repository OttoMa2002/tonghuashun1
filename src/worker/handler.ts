// 消息分发(T05)。契约 §5 / src/worker/CLAUDE.md 规则 3、6:
//  - 一切消息走信封格式(id 原样回带),每个 query.exec 必有且只有一个回执(result 或 error)
//  - 禁止吞错:任何失败路径都发 query.error 并带 kind,沉默失败会让调度器退避逻辑失明
//
// 流程:query.exec → source 取数 → matrix→列式 → query.result(大数组 Transferable 移交);
//       query.cancel → abort 对应 in-flight,取数返回后若已取消则发 query.error(kind:'aborted')。

import type {
  Envelope,
  MainToWorkerMessage,
  QueryErrorKind,
  QueryExecMessage,
  QueryExecPayload,
  WorkerToMainMessage,
} from '../contract';

import { FrameParseError, countRawPoints, matrixToColumnar } from './transform';
import { collectTransferables } from './transferables';
import type { QuerySource } from './source';

/** post 回调:Worker 入口绑定到 self.postMessage(message, transfer)。 */
export type PostReceipt = (message: WorkerToMainMessage, transfer: ArrayBuffer[]) => void;

export interface QueryHandlerDeps {
  source: QuerySource;
  post: PostReceipt;
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

  async function handleExec(message: QueryExecMessage): Promise<void> {
    const { id } = message;
    const payload: QueryExecPayload = message.payload;
    const { queryId } = payload;
    const controller = new AbortController();
    inFlight.set(queryId, controller);
    const startedAt = now();

    try {
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
      const elapsedMs = now() - startedAt;
      const resultEnvelope: WorkerToMainMessage = {
        id,
        type: 'query.result',
        payload: {
          queryId,
          frame,
          meta: { rawPointCount: countRawPoints(response), elapsedMs },
        },
      };
      deps.post(resultEnvelope, collectTransferables(frame));
    } catch (err) {
      emitError(id, queryId, kindOfThrown(err), messageOf(err));
    } finally {
      inFlight.delete(queryId);
    }
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
