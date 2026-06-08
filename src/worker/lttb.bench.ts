// LTTB 基准(T06 DoD):1M 点 → 2000 点,Worker 内耗时须在 docs/data-contract.md §7
// 预算内(PERF_BUDGET.lttbMillionMs = 150ms)。结果入 commit message(§7 修订须引用 bench)。
// 运行:pnpm exec vitest bench --run。bench 文件不被 `vitest run`(测试)采集,不影响门禁。

import { bench } from 'vitest';

import { lttb } from './lttb';

const N = 1_000_000;
const xs = new Float64Array(N);
const ys = new Float64Array(N);
for (let i = 0; i < N; i++) {
  xs[i] = i * 1000; // 严格递增 tsMillis
  ys[i] = Math.sin(i / 1000) * 100 + i * 0.001; // 带趋势的波形
}

bench('LTTB 1M → 2000 点', () => {
  lttb(xs, ys, 2000);
});
