# 数据契约(草案)

> 定位:本文是任务 T01 的**输入材料**,经人工审定后成为跨模块唯一事实源。
> 审定后,`src/contract/` 类型定义与本文一一对应,本文修改须经人工(ADR-0008 同级约束)。
> 标注「待审定」的条目是已知悬而未决项,T01 必须逐条裁决。

## 1. 数据模型

- **Metric**:`name: string` + `type: 'counter' | 'gauge'` + `labels: Record<string, string>`
- **Sample**:`[timestamp, value]`,timestamp 为 Unix 毫秒整数,value 为 number
- **Series 身份**:`name` + labels 按 key 字典序规范化后的字符串(series key),mock 与 worker 必须使用同一规范化函数(放 src/contract/,两侧 import,防止各写一份导致漂移)

待审定:timestamp 用毫秒(JS 生态自然)而非 Prometheus 原生的秒。差异已知且接受,但需 T01 确认并在类型命名中显式(`tsMillis`)。

## 2. query_range 语义

参数:

- `selector`:metric name + label 等值匹配(仅支持 `=`,不做正则与 PromQL 解析,ADR-0003)
- `start` / `end`:毫秒时间戳,要求 `start < end`
- `step`:毫秒;省略 step 即 **raw 模式**

stepped 模式评估规则:

- 评估时刻为 `start + k*step`,`k = 0..floor((end-start)/step)`
- 每个评估时刻取「该时刻之前最近的样本」,lookback 窗口 5 分钟(待审定),窗口内无样本则该点为空
- 这是对 Prometheus staleness 语义的简化模仿,不实现 staleness marker

raw 模式:返回 `[start, end]` 区间内全部原始样本,不做评估对齐,仅 million-points 页允许使用(ADR-0004)。

响应(matrix):

```ts
type MatrixResponse = {
  status: 'success';
  data: { result: Array<{ metric: { name: string; labels: Record<string, string> };
                          values: Array<[number, number]> }> };
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

## 5. Worker 消息协议

信封:`{ id: string; type: string; payload: ... }`,id 由发送方生成、回执原样携带。

主线程 → Worker:

- `query.exec`:`{ queryId, selector, start, end, step?, downsample?: { targetPoints: number } }`
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

不变量:ts 严格递增;所有 values 与 ts 等长;缺点以 `NaN` 表示。`ts` 与各 `values` 的 buffer 经 Transferable 移交,移交后 Worker 侧不得再访问。

待审定:NaN 作为间隙表示依赖 uPlot 对 typed array + NaN 的间隙处理行为,T10 首个验证项;若不成立,降级方案为 charts 适配层将 NaN 转 null 普通数组(有一次拷贝成本,届时凭基准决定)。

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

## 8. T01 审定清单

1. timestamp 毫秒 vs 秒(§1)
2. lookback 窗口取值(§2,当前 5 分钟)
3. NaN 间隙表示的 uPlot 兼容性处理路径(§6)
4. 性能预算数字逐项过目(§7)
