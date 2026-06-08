// useMetricQuery(T08)。职责:发 query.exec 指令、收回执、暴露 loading/error/data 三态。
// data 来自 ColumnarStore(useSyncExternalStore 订阅),store 是主线程唯一快照源。
// 本 hook 不做任何数据加工:只搬运 Worker 回执里的列式帧(硬约束 3)。

import { useEffect, useId, useReducer, useSyncExternalStore } from 'react';

import type { ColumnarFrame, QueryErrorPayload, QueryResultPayload, Selector } from '../contract';

import { useDataLayer } from './context';

/** 查询规格:契约 query.exec 去掉 queryId(由 hook 生成并稳定持有)。 */
export interface MetricQuerySpec {
  selector: Selector;
  startMillis: number;
  endMillis: number;
  /** 省略 = raw 模式(§2)。 */
  stepMillis?: number;
  /** 渲染级降采样目标点数(LTTB 在 Worker 内执行)。 */
  downsample?: { targetPoints: number };
}

/** Worker 回执 meta(契约 §5):rawPointCount / elapsedMs（转换在 Worker 完成的耗时证据）。 */
type ResultMeta = QueryResultPayload['meta'];

export interface MetricQueryState {
  loading: boolean;
  error: QueryErrorPayload | null;
  data: ColumnarFrame | null;
  /** 最近一次成功回执的 meta；loading/error 时为 null。供 million-points 页展示 Worker 转换耗时。 */
  meta: ResultMeta | null;
}

type Phase = { loading: boolean; error: QueryErrorPayload | null; meta: ResultMeta | null };
type PhaseAction =
  | { kind: 'load' }
  | { kind: 'success'; meta: ResultMeta }
  | { kind: 'error'; error: QueryErrorPayload };

function phaseReducer(_prev: Phase, action: PhaseAction): Phase {
  switch (action.kind) {
    case 'load':
      return { loading: true, error: null, meta: null };
    case 'success':
      return { loading: false, error: null, meta: action.meta };
    case 'error':
      return { loading: false, error: action.error, meta: null };
  }
}

/**
 * 发起一次区间查询并跟踪三态。spec 变化即重发(以序列化 specKey 为依赖)。
 * 结果帧写入 store[queryId];data 经 useSyncExternalStore 读回,使图表/表格可共享同一快照。
 */
export function useMetricQuery(spec: MetricQuerySpec): MetricQueryState {
  const { client, store } = useDataLayer();
  const queryId = useId();
  const [phase, dispatch] = useReducer(phaseReducer, { loading: true, error: null, meta: null });

  // spec 是对象,引用不稳定;以序列化值作为 effect 依赖,避免每次渲染重发。
  const specKey = JSON.stringify(spec);

  useEffect(() => {
    let active = true;
    dispatch({ kind: 'load' });
    const execId = client.exec({ queryId, ...spec });

    const unsubscribe = client.subscribe((receipt) => {
      // 只认本次 exec 的回执(envelope id 匹配),忽略陈旧/他人结果。
      if (!active || receipt.id !== execId) {
        return;
      }
      if (receipt.type === 'query.result') {
        store.set(queryId, receipt.payload.frame);
        dispatch({ kind: 'success', meta: receipt.payload.meta });
      } else {
        dispatch({ kind: 'error', error: receipt.payload });
      }
    });

    return () => {
      active = false;
      client.cancel(queryId);
      unsubscribe();
    };
    // specKey 涵盖 spec 全字段;client/store/queryId 在生命周期内稳定。
  }, [client, store, queryId, specKey]);

  const data = useSyncExternalStore(store.subscribe, () => store.get(queryId) ?? null);

  return { loading: phase.loading, error: phase.error, data, meta: phase.meta };
}
