---
name: prom-query-semantics
description: Prometheus query_range 语义的实现要点。凡创建、修改 src/mock/ 的查询实现或 src/worker/ 的 rate 计算时必读。涵盖评估对齐、matrix 结构、counter rate 与重置处理,以及按模糊印象实现 Prometheus 的高频错误。
---

# query_range 语义实现要点

权威定义在 docs/data-contract.md §2-§3,本 skill 只补充实现要点与错误模式。
**契约与印象冲突时,契约赢**;觉得契约错了,提请人工改契约。

## 评估对齐(stepped 模式)

stepped 查询不是「把原始样本切片返回」,是**在评估时刻栅格上采样**:

```
评估时刻: start, start+step, start+2*step, ..., ≤ end
每个时刻: 取该时刻之前(含)最近的样本值;lookback 窗口内无样本 → 该点为空
```

推论(也是单测用例):

- 返回点数由 start/end/step 决定,与原始样本密度无关
- 两个评估时刻之间有 10 个原始样本 → 只有最近的 1 个被采到,这不是 bug 是语义
- 原始样本稀疏时,同一样本可被相邻多个评估时刻重复采到

## counter rate(Worker 侧)

```
rate = 窗口内增量之和 / 窗口实际时长(秒)
增量 = curr >= prev ? curr - prev : curr   // 值回落 = 重置,增量按新值计
```

不实现 Prometheus 的端点外推(契约已声明简化)。

## 反例对照

**反例 1:把 stepped 实现成数组切片 + 等距抽稀**

```ts
samples.filter((_, i) => i % k === 0) // ✗
```

为什么错:抽稀以样本下标为基准,评估对齐以时间为基准。样本一旦不均匀
(故障注入、重置),两者结果立刻分叉,且抽稀无法表达「空点」。

**反例 2:rate 实现成首尾两点斜率**

```ts
(last.v - first.v) / windowSec // ✗
```

为什么错:窗口内发生 counter 重置时,last < first 会算出负 rate;
逐对增量求和 + 重置分支才能正确跨越重置点。

**反例 3:假设输入样本有序**

为什么错:乱序时间戳是显式故障模式(契约 §4)。Worker 解析侧必须检测乱序并
按契约处理(排序或报错,以契约审定结果为准),不许默认有序。

**反例 4:发明契约外的「贴心」行为**

典型:支持 label 正则匹配、自动补全缺失 step、返回额外 metadata 字段。
为什么错:契约外行为没有消费方,却会被下游悄悄依赖,日后删除即破坏。
mock 的价值在于忠实,不在于强大。
