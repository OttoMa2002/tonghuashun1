// 轮询调度器(T09)。architecture.md §5.3 / data-contract.md §4、§7。
// 职责严格限定为「节奏与退避决策」:经 QueryClient 向 Worker 下发查询指令,
// 不接触 matrix、不做任何数据加工(CLAUDE.md 硬约束 3/4)。四项行为:
//  - scrape_interval 对齐:正常节奏的下一拍落在 interval 边界(now 对 interval 取模),
//    多个数据源/面板的轮询因此对齐,避免错峰空耗(§5.2:数据源 interval 才产新点)
//  - in-flight 去重:上一指令未收到 Worker 回执前,到点的拍子跳过、不发新指令(§5 回执为准)
//  - 失败指数退避:连续失败按 interval·2^n 截到 backoffCap;收到成功回执即重置回对齐节奏
//  - visibility:隐藏即暂停(清定时器、不排程),可见立即补一次(§5.3)

import { BACKOFF_CAP_MILLIS, DEFAULT_SCRAPE_INTERVAL_MILLIS } from '../contract';
import type { QueryExecPayload, QueryReceipt } from '../contract';

import type { QueryClient } from './queryClient';

/** 可见性源:抽象 document.visibilityState + visibilitychange,便于测试注入。 */
export interface VisibilitySource {
  isHidden(): boolean;
  /** 订阅可见性变化;返回退订函数。 */
  subscribe(listener: () => void): () => void;
}

/** 浏览器默认可见性源,包裹 document(调度器在主线程,允许触碰 DOM)。 */
export function documentVisibility(): VisibilitySource {
  return {
    isHidden: () => document.visibilityState === 'hidden',
    subscribe(listener) {
      document.addEventListener('visibilitychange', listener);
      return () => {
        document.removeEventListener('visibilitychange', listener);
      };
    },
  };
}

export interface PollerOptions {
  client: QueryClient;
  /**
   * 每拍构造查询指令。调用方决定 queryId 与时窗(如滚动窗口 end=now);
   * 调度器只负责何时调用它,不解释其内容。
   */
  buildPayload: () => QueryExecPayload;
  /** 轮询间隔(scrape_interval),默认 §7 的 15s。 */
  intervalMillis?: number;
  /** 退避上限,默认 §7 的 2min。 */
  backoffCapMillis?: number;
  /** 时钟源,默认 Date.now;用于对齐计算与测试注入。 */
  now?: () => number;
  /** 可见性源,默认包裹 document;测试注入假实现。 */
  visibility?: VisibilitySource;
}

export interface Poller {
  /** 启动:可见则立即首拍并排下一拍;隐藏则待可见后补拍。幂等。 */
  start(): void;
  /** 停止:清定时器、退订、取消 in-flight 查询。幂等。 */
  stop(): void;
}

/**
 * 创建轮询调度器。节奏由单一定时器驱动,任一时刻至多一个 pending 定时器:
 * 每次重排(armAligned/armBackoff)先清旧定时器,保证不重叠。
 */
export function createPoller(options: PollerOptions): Poller {
  const interval = options.intervalMillis ?? DEFAULT_SCRAPE_INTERVAL_MILLIS;
  const backoffCap = options.backoffCapMillis ?? BACKOFF_CAP_MILLIS;
  const now = options.now ?? ((): number => Date.now());
  const visibility = options.visibility ?? documentVisibility();

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeReceipt: (() => void) | null = null;
  let unsubscribeVisibility: (() => void) | null = null;

  // in-flight 去重:当前未收回执的 exec envelope id;null = 空闲(§5「未收回执」判定)。
  let inFlightExecId: string | null = null;
  let inFlightQueryId: string | null = null;
  // 连续失败次数,驱动指数退避;收到成功回执即归零。
  let failures = 0;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** 发一拍查询。已有 in-flight 则去重跳过(§5),不重排定时器(由调用方负责)。 */
  function poll(): void {
    if (inFlightExecId !== null) {
      return; // 去重:上一指令未回执
    }
    const payload = options.buildPayload();
    inFlightQueryId = payload.queryId;
    inFlightExecId = options.client.exec(payload);
  }

  /** 排正常节奏的下一拍:对齐到 interval 边界。隐藏/停止时不排程(暂停语义)。 */
  function armAligned(): void {
    clearTimer();
    if (!running || visibility.isHidden()) {
      return;
    }
    const offset = ((now() % interval) + interval) % interval;
    const delay = offset === 0 ? interval : interval - offset;
    timer = setTimeout(onTick, delay);
  }

  /** 排退避重试:interval·2^failures 截到 backoffCap,然后递增 failures。 */
  function armBackoff(): void {
    clearTimer();
    if (!running || visibility.isHidden()) {
      return;
    }
    const delay = Math.min(interval * 2 ** failures, backoffCap);
    failures += 1;
    timer = setTimeout(onTick, delay);
  }

  /** 定时器到点:in-flight 则跳过本拍(去重),否则发一拍;随后排下一拍对齐节奏。 */
  function onTick(): void {
    timer = null;
    if (!running || visibility.isHidden()) {
      return;
    }
    poll(); // in-flight 时内部去重,不会重复发
    armAligned();
  }

  function onReceipt(receipt: QueryReceipt): void {
    if (receipt.id !== inFlightExecId) {
      return; // 非本拍回执(他人查询/陈旧),忽略
    }
    inFlightExecId = null;
    inFlightQueryId = null;
    if (receipt.type === 'query.result') {
      failures = 0; // 恢复:重置退避,回到对齐节奏
      // 正常节奏的下一拍已由 onTick/start 排定,无需重排
    } else {
      armBackoff(); // 失败:取消对齐拍,改排退避重试
    }
  }

  function onVisibilityChange(): void {
    if (!running) {
      return;
    }
    if (visibility.isHidden()) {
      clearTimer(); // 暂停:停排下一拍;in-flight 回执到达时因 hidden 也不排程
      return;
    }
    // 可见:立即补一次(§5.3)。若仍有 in-flight,poll() 内去重跳过,待回执后回归节奏。
    poll();
    armAligned();
  }

  return {
    start(): void {
      if (running) {
        return;
      }
      running = true;
      failures = 0;
      inFlightExecId = null;
      inFlightQueryId = null;
      unsubscribeReceipt = options.client.subscribe(onReceipt);
      unsubscribeVisibility = visibility.subscribe(onVisibilityChange);
      if (!visibility.isHidden()) {
        poll(); // 首拍立即(可见时)
        armAligned();
      }
    },
    stop(): void {
      if (!running) {
        return;
      }
      running = false;
      clearTimer();
      if (unsubscribeReceipt) {
        unsubscribeReceipt();
        unsubscribeReceipt = null;
      }
      if (unsubscribeVisibility) {
        unsubscribeVisibility();
        unsubscribeVisibility = null;
      }
      if (inFlightExecId !== null && inFlightQueryId !== null) {
        options.client.cancel(inFlightQueryId);
      }
      inFlightExecId = null;
      inFlightQueryId = null;
    },
  };
}
