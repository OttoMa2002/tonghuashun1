// 查询客户端(T08)。主线程只下发查询指令、接收回执,不接触 matrix(architecture.md §5.3)。
// QueryClient 是 hook 与 Worker 之间的传输抽象:exec 发 query.exec 信封并回传其 envelope id,
// 订阅者拿到的是契约回执(query.result | query.error)。真实实现包裹一个 Worker;测试注入假实现。

import type {
  QueryCancelMessage,
  QueryExecMessage,
  QueryExecPayload,
  QueryReceipt,
  WorkerToMainMessage,
} from '../contract';

/** 回执监听器:收到 result 或 error 信封即触发(§5 回执定义)。 */
export type ReceiptListener = (receipt: QueryReceipt) => void;

export interface QueryClient {
  /** 下发一次查询;返回该指令的 envelope id,回执原样携带(§5),供调用方匹配自己的结果。 */
  exec(payload: QueryExecPayload): string;
  /** 取消某 queryId 的 in-flight 查询。 */
  cancel(queryId: string): void;
  /** 订阅全部回执;返回退订函数。多个消费方共享同一 client。 */
  subscribe(listener: ReceiptListener): () => void;
}

/**
 * 用一个 Worker 实例构造 QueryClient。Worker 由页面/调度层创建并注入(data 不实例化 Worker)。
 * envelope id 用单调计数器生成,保证同一 client 内唯一;handler 原样回带(§5)。
 */
export function createWorkerClient(worker: Worker): QueryClient {
  const listeners = new Set<ReceiptListener>();
  let seq = 0;

  worker.onmessage = (event: MessageEvent<WorkerToMainMessage>): void => {
    for (const listener of listeners) {
      listener(event.data);
    }
  };

  return {
    exec(payload) {
      const id = `exec:${payload.queryId}:${seq++}`;
      const message: QueryExecMessage = { id, type: 'query.exec', payload };
      worker.postMessage(message);
      return id;
    },
    cancel(queryId) {
      const message: QueryCancelMessage = {
        id: `cancel:${queryId}:${seq++}`,
        type: 'query.cancel',
        payload: { queryId },
      };
      worker.postMessage(message);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
