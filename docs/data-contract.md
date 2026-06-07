# 数据契约

> 定位:本文经人工审定(T01),是 mock/worker/data/charts 的跨模块唯一事实源。
> `src/contract/` 类型定义与本文一一对应,本文修改须经人工(ADR-0008 同级约束)。
> §8 记录 T01 审定结论;原「待审定」项已逐条裁决并就地落定。

## 1. 数据模型

- **Metric**:`name: string` + `type: 'counter' | 'gauge'` + `labels: Record<string, string>`
- **Sample**:`[timestamp, value]`,timestamp 为 Unix 毫秒整数,value 为 number
- **Series 身份**:`name` + labels 按 key 字典序规范化后的字符串(series key),mock 与 worker 必须使用同一规范化函数(放 src/contract/,两侧 import,防止各写一份导致漂移)

**时间单位(审定·§8-1)**:timestamp 一律用**毫秒**(整数 Unix ms),区别于 Prometheus 原生的秒。差异已知且接受,在类型命名中显式标注 `tsMillis`。选 ms 的理由:JS 生态(`Date.now`、`setInterval`、scrape_interval/step 计算)全链路天然 ms,选秒会让主线程所有时间运算背一层换算。uPlot 默认按"秒"解释 x 值,其消费侧解释规则见 §6 消费方注记(charts 层以 formatter 解释,**禁止**对数组做 ÷1000 换算)。

## 2. query_range 语义

参数:

- `selector`:metric name + label 等值匹配(仅支持 `=`,不做正则与 PromQL 解析,ADR-0003)
- `startMillis` / `endMillis`:毫秒时间戳,要求 `startMillis < endMillis`
- `stepMillis`:毫秒;省略即 **raw 模式**

stepped 模式评估规则:

- 评估时刻为 `startMillis + k*stepMillis`,`k = 0..floor((endMillis-startMillis)/stepMillis)`
- 每个评估时刻取「该时刻之前最近的样本」,lookback 窗口 **5 分钟(300 000 ms,审定·§8-2)**,窗口内无样本则该点为空。取值出处:对齐 Prometheus 默认 lookback-delta(`--query.lookback-delta`,默认 5m);远大于默认 scrape_interval(15s,§7),可桥接单次漏采/稀疏点造成的瞬时空洞
- 这是对 Prometheus staleness 语义的简化模仿,不实现 staleness marker

raw 模式:返回 `[startMillis, endMillis]` 区间内全部原始样本,不做评估对齐,仅 million-points 页允许使用(ADR-0004)。

响应(matrix);`values` 元组为 `[tsMillis, value]`:

```ts
type MatrixResponse = {
  status: 'success';
  data: { result: Array<{ metric: { name: string; labels: Record<string, string> };
                          values: Array<[number, number]> }> };  // [tsMillis, value]
};
type ErrorResponse = { status: 'error'; errorType: 'timeout' | 'internal' | 'bad_request'; message: string };
```

## 3. 指标语义

- **gauge**:直读绘制
- **counter**:单调不减;值回落即视为重置。`rate(window)` 计算:窗口内相邻样本增量求和(重置处增量按新值计),除以窗口实际时长。不实现 Prometheus 的端点外推,简化已知且标注(面试可讲)

rate 只允许在 Worker 内计算(CLAUDE.md 硬约束 3)。

## 4. 故障模式(mock 可注入)

| 模式 | 行为 | 默认参数 |
|---|---|---|
| `timeout` | 不返回,直至超过客户端超时 | 客户端超时 10s |
| `http_5xx` | 返回 ErrorResponse(internal) | - |
| `slow` | 延迟后正常返回 | 3000ms |
| `out_of_order` | values 内随机交换相邻样本对 | 交换率 5% |

配置按 series key 或全局开关,默认全关。全关时行为必须与无故障实现逐字节一致(T04 回归测试断言)。

**乱序样本的解析侧处置(审定·§8-缺口/a)**:`out_of_order` 故障会产出时间戳乱序的 `values`,而 §6 ColumnarFrame 要求 `ts` 严格递增。裁决:**Worker 解析侧按 `tsMillis` 升序排序后再列式化**,使乱序对下游透明——与该故障"不返回错误、仅扰乱顺序"的语义一致(对照 prom-query-semantics 反例 3)。不在 charts 等下游补救;排序是 Worker 的解析义务,非数据加工旁路。mock 在评估时刻栅格上产点,同一 series 的 `tsMillis` 本就唯一,故排序后 §6 的"严格递增"自然成立;若解析侧仍遇到相等 ts,属契约违例,按 §5「禁止吞错」发 `query.error(kind:'parse')`,不静默合并。T05 转换单测断言乱序输入排序后输出严格递增。

## 5. Worker 消息协议

信封:`{ id: string; type: string; payload: ... }`,id 由发送方生成、回执原样携带。

主线程 → Worker:

- `query.exec`:`{ queryId, selector, startMillis, endMillis, stepMillis?, downsample?: { targetPoints: number } }`
- `query.cancel`:`{ queryId }`

Worker → 主线程:

- `query.result`:`{ queryId, frame: ColumnarFrame, meta: { rawPointCount, downsampledTo? , elapsedMs } }`
- `query.error`:`{ queryId, kind: 'timeout' | 'http' | 'parse' | 'aborted', message }`

**回执定义**:`query.result` 或 `query.error`。调度器的 in-flight 去重以「该 queryId 未收到回执」为判定,不设单独 ack 消息(协议面最小化;若实测需要接收确认,凭证据修订)。

fetch 与解析全部发生在 Worker 内;主线程不接触 MatrixResponse(architecture.md §5.3)。

## 6. 列式结构(ColumnarFrame)

```ts
type ColumnarFrame = {
  ts: Float64Array;                       // 严格递增
  series: Array<{ key: string; name: string;
                  labels: Record<string, string>;
                  values: Float64Array }>; // length === ts.length
};
```

不变量:ts 严格递增;所有 values 与 ts 等长;缺点以 `NaN` 表示。`ts` 与各 `values` 的 buffer 经 Transferable 移交,移交后 Worker 侧不得再访问。`ts` 单位为 `tsMillis`(§1)。

**消费方注记(审定·§8-1 / §8-3)** —— charts 层(T10)消费 ColumnarFrame 的两条强制规则:

- **时间单位解释**:`ts` 是毫秒。uPlot 默认按秒解释 x,charts 层须以**自定义日期格式化器**(`fmtDate` / 轴 `values` / cursor 值格式化器,把数值当 ms)解释,**禁止对 `ts` 数组做 ÷1000 换算**——对 1M 数组逐元素换算属主线程数据加工(违反 CLAUDE.md 硬约束 3),且产生拷贝、抵消 Transferable。uPlot 绘制只用裸数值,"秒"假设仅影响日期文本,可被 formatter 完全覆盖。
- **间隙表示**:`NaN` 是 typed array 中唯一可表达空点的哨兵(`Float64Array` 存不了 `null`——会被强制为 0,画成到 0 的连线)。依赖 uPlot 对 typed array + `NaN` 的间隙处理,并须关闭 `spanGaps`(否则跨空点连线)。**此假设由 T10 首个验证项实测**;结论无论真假都回写本节(经人工)。降级方案(成立性存疑时启用):charts 适配层将 `NaN` 转 `null` 普通数组——有一次主线程拷贝且丢失 Transferable 收益,故仅作降级、非默认路径,届时凭基准决定。

## 7. 性能预算

**初始预算,可凭基准证据修订**(修订须在 commit message 引用 bench 结果):

| 项 | 预算 | 消费方 |
|---|---|---|
| raw 1M 点:Worker 内 fetch + 解析 + 列式转换 | ≤ 500ms | T05 bench、T12 |
| raw 1M 点:首帧渲染(setData 到 paint) | ≤ 1000ms | T12 自显耗时、T14 断言 |
| 主线程单次长任务(转换不在主线程的证据) | ≤ 50ms | T12 |
| LTTB:1M → 2000 点(Worker 内) | ≤ 150ms | T06 bench |
| stepped 端到端(720 点 × ≤10 series,无故障) | ≤ 200ms | T11 |
| scrape_interval 默认 / 退避上限 | 15s / 2min | T09 |
| 万行表格实际 DOM 行数 | < 50 | T13 |

## 8. T01 审定结论

人工审定通过(签字见对应 commit `reviewed-by`)。原悬决项已就地落定:

| # | 议题 | 裁决 | 落地处 |
|---|---|---|---|
| 1 | timestamp 毫秒 vs 秒 | 毫秒(整数 Unix ms),命名 `tsMillis`;charts 以 formatter 解释、禁数组换算 | §1、§6 消费方注记 |
| 2 | lookback 窗口取值 | 5 分钟(300 000 ms),对齐 Prometheus 默认 lookback-delta | §2 |
| 3 | NaN 间隙表示路径 | NaN 为主哨兵(typed array 唯一可行)+ 关 `spanGaps`;成立性由 T10 首验,保留 NaN→null 降级 | §6 消费方注记 |
| 4 | 性能预算逐项 | 整表作为初始预算采纳(可凭 bench 修订);风险项为 raw 1M ≤500ms,留 T05 bench 确认 | §7 |
| 缺口 | 乱序样本解析侧处置 | (a) Worker 按 `tsMillis` 升序排序后列式化,对下游透明 | §4 |
