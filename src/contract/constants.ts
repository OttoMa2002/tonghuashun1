// 数据契约 §2/§4/§7:跨模块共享的语义常量与性能预算。
// 数值与 docs/data-contract.md 一一对应,修改须经人工(ADR-0008)。

/** stepped 评估 lookback 窗口(§2,审定 §8-2):对齐 Prometheus 默认 lookback-delta(5m)。 */
export const LOOKBACK_MILLIS = 300_000;

/** 默认 scrape_interval(§7):轮询频率上界,数据源 15s 才产生新点。 */
export const DEFAULT_SCRAPE_INTERVAL_MILLIS = 15_000;

/** 失败指数退避上限(§7)。 */
export const BACKOFF_CAP_MILLIS = 120_000;

/** 客户端超时(§4 timeout 故障判定基准)。 */
export const CLIENT_TIMEOUT_MILLIS = 10_000;

/**
 * 性能预算(§7,审定 §8-4)。初始值,可凭 bench 证据修订
 * (修订须在 commit message 引用 bench 结果)。
 */
export const PERF_BUDGET = {
  /** raw 1M 点:Worker 内 fetch + 解析 + 列式转换(ms)。风险项,T05 bench 盯。 */
  rawMillionTransformMs: 500,
  /** raw 1M 点:首帧渲染 setData→paint(ms)。 */
  rawMillionFirstPaintMs: 1000,
  /** 主线程单次长任务上限(ms),转换不在主线程的证据。 */
  mainThreadLongTaskMs: 50,
  /** LTTB 1M→2000 点,Worker 内(ms)。 */
  lttbMillionMs: 150,
  /** stepped 端到端,720 点 × ≤10 series,无故障(ms)。 */
  steppedEndToEndMs: 200,
  /** 万行表格实际 DOM 行数上限。 */
  virtualRowsMax: 50,
} as const;
