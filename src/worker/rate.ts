// counter rate 派生计算(T07)。契约以 docs/data-contract.md §3(指标语义)为准,
// rate 只允许在 Worker 内计算(CLAUDE.md 硬约束 3、src/worker/CLAUDE.md 规则 5)。
//
// 契约 §3 公式(单窗口聚合,不实现 Prometheus 端点外推):
//   rate(window) = 窗口内相邻样本增量之和 / 窗口实际时长(秒)
//   增量 = curr >= prev ? curr - prev : curr   // 值回落 = counter 重置,增量按新值计
//
// 设计取舍:契约消息协议(messages.ts)未携带 rate 窗口参数,故本模块只交付契约定义的
// 「单窗口 → 标量」原语,不发明 grid 上的 rate 序列(反例 4:契约外行为没有消费方)。
// 窗口 = 调用方传入的样本片段;消费方如何切窗是其职责。
//
// 输入不变量(违反即 bug,不在下游修补,src/worker/CLAUDE.md 规则 7):
//   ts 严格递增、values 与 ts 等长。乱序/不等长是契约违例(§4)→ 抛错,绝不静默重排或合并。

/** rate 输入违例:ts 与 values 不等长,或 ts 非严格递增(§4 乱序属显式故障,检测而非默认有序)。 */
export class RateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateInputError';
  }
}

/**
 * 计算单个 counter 窗口的 rate(§3)。
 *
 * 返回每秒增量速率。窗口不足以定义速率时返回 NaN:
 *  - 空窗口(n=0)或单点窗口(n=1):无相邻样本对,无法求增量;且时长为 0,速率未定义 → NaN
 *  - 窗口时长为 0(所有样本同一时刻,理论上被严格递增检查拦截,留兜底):除零 → NaN
 *
 * 重置处理:某点值低于前点即视为重置,该步增量按新值计(curr),而非负增量。
 * 这使跨重置点的累计增量为正,避免「首尾两点斜率」在重置时算出负速率(反例 2)。
 *
 * @param ts     样本时刻(tsMillis),严格递增
 * @param values counter 取值,与 ts 等长
 */
export function counterRate(ts: Float64Array, values: Float64Array): number {
  const n = ts.length;
  if (values.length !== n) {
    throw new RateInputError(`ts/values 长度不一致:ts=${n} values=${values.length}(§6 等长不变量)`);
  }

  // 乱序检测(§4):严格递增是输入不变量,检测到回退即违例,不默认有序(反例 3)。
  for (let i = 1; i < n; i++) {
    if (!(ts[i] > ts[i - 1])) {
      throw new RateInputError(
        `ts 非严格递增:ts[${i}]=${ts[i]} <= ts[${i - 1}]=${ts[i - 1]}(§4 乱序须上游处置)`,
      );
    }
  }

  // 单点/空窗口:无相邻对、时长为 0 → 速率未定义。
  if (n < 2) {
    return NaN;
  }

  const durationSec = (ts[n - 1] - ts[0]) / 1000;
  if (!(durationSec > 0)) {
    return NaN; // 严格递增检查后理论不可达;留兜底避免除零产出 ±Infinity。
  }

  let deltaSum = 0;
  for (let i = 1; i < n; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    // curr >= prev:正常累加增量;curr < prev:重置,增量按新值计(§3)。
    deltaSum += curr >= prev ? curr - prev : curr;
  }

  return deltaSum / durationSec;
}
