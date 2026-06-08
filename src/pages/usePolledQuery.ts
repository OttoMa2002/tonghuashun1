// 轮询驱动的区间查询 hook(T11)。把 T09 调度器(createPoller)与 T08 列式 store 接到一起:
// 调度器按 scrape_interval 节奏下发 query.exec,回执的列式帧写入 store,组件读回三态。
//
// 职责边界:本 hook 不做任何数据加工(硬约束 3),也不自起 setInterval——节奏全权交给调度器
// (DoD:面板数据来源全部经调度器)。fetch/解析/降采样/rate 均在 Worker(硬约束 3/4)。
// 与 useMetricQuery(一次性 exec)的区别:此 hook 持续轮询、复用同一 queryId 滚动覆盖快照。

import { useEffect, useId, useReducer, useSyncExternalStore } from 'react';

import type {
  ColumnarFrame,
  QueryErrorPayload,
  QueryExecPayload,
  QueryResultPayload,
  Selector,
} from '../contract';
import { createPoller, useDataLayer } from '../data';

/** 轮询查询规格:stepped 查询(dashboard 一律带 stepMillis),可选 rate / 降采样 / 自定节奏。 */
export interface PolledQuerySpec {
  selector: Selector;
  startMillis: number;
  endMillis: number;
  /** dashboard 为 stepped 视图,必带 step(§2)。 */
  stepMillis: number;
  /** counter rate 面板:trailing 窗口(§3、ADR-0010);Worker 内求值。 */
  rate?: { windowMillis: number };
  /** 渲染级降采样目标点数(LTTB 在 Worker 内)。 */
  downsample?: { targetPoints: number };
  /** 轮询间隔,省略用调度器默认 scrape_interval(15s,契约 §7)。 */
  intervalMillis?: number;
}

type ResultMeta = QueryResultPayload['meta'];

export interface PolledQueryState {
  loading: boolean;
  error: QueryErrorPayload | null;
  data: ColumnarFrame | null;
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
      // 成功即清错:故障恢复后自愈(DoD)。
      return { loading: false, error: null, meta: action.meta };
    case 'error':
      return { loading: false, error: action.error, meta: null };
  }
}

/**
 * 按节奏轮询一个区间查询并跟踪三态。spec 变化即重建调度器(以序列化 specKey 为依赖)。
 * 每拍结果帧写入 store[queryId](稳定 key,滚动覆盖);data 经 useSyncExternalStore 读回,
 * 使图表与其它消费方共享同一快照。错误回执置 error 态、成功回执清错,呈现故障/恢复。
 */
export function usePolledQuery(spec: PolledQuerySpec): PolledQueryState {
  const { client, store } = useDataLayer();
  const queryId = useId();
  const [phase, dispatch] = useReducer(phaseReducer, { loading: true, error: null, meta: null });

  // spec 是对象,引用不稳定;以序列化值作为 effect 依赖,避免每次渲染重建调度器。
  const specKey = JSON.stringify(spec);

  useEffect(() => {
    dispatch({ kind: 'load' });

    // 订阅回执:按 payload.queryId 认本面板的结果(queryId 跨拍稳定,envelope id 每拍变)。
    const unsubscribe = client.subscribe((receipt) => {
      if (receipt.payload.queryId !== queryId) {
        return;
      }
      if (receipt.type === 'query.result') {
        store.set(queryId, receipt.payload.frame);
        dispatch({ kind: 'success', meta: receipt.payload.meta });
      } else {
        dispatch({ kind: 'error', error: receipt.payload });
      }
    });

    // 节奏交给调度器:对齐 scrape_interval、失败退避、in-flight 去重、隐藏暂停(T09)。
    const poller = createPoller({
      client,
      buildPayload: (): QueryExecPayload => ({
        queryId,
        selector: spec.selector,
        startMillis: spec.startMillis,
        endMillis: spec.endMillis,
        stepMillis: spec.stepMillis,
        ...(spec.rate ? { rate: spec.rate } : {}),
        ...(spec.downsample ? { downsample: spec.downsample } : {}),
      }),
      intervalMillis: spec.intervalMillis,
    });
    poller.start();

    return () => {
      poller.stop();
      unsubscribe();
      store.delete(queryId);
    };
    // specKey 涵盖 spec 全字段;client/store/queryId 在生命周期内稳定。
  }, [client, store, queryId, specKey]);

  const data = useSyncExternalStore(store.subscribe, () => store.get(queryId) ?? null);

  return { loading: phase.loading, error: phase.error, data, meta: phase.meta };
}
