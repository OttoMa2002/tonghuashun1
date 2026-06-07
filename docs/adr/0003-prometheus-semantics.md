# ADR-0003:mock 数据层采用 Prometheus 查询语义,否决自造格式

状态:Accepted

## 背景

MVP 无真实后端,mock 层需要一份数据契约。契约的质量决定了轮询策略、降采样参数、数据结构设计是「有依据」还是「拍脑袋」。

## 备选与否决理由

- **自造 JSON 格式**:实现最快。否决:轮询频率、降采样粒度、指标语义全部失去外部依据,设计决策退化为任意值,且面试无从验证领域理解。
- **完整 PromQL 解析**:语义最完整。否决:解析器本身会吞掉整个项目工期,远超范围。
- **Prometheus query_range 子集**:采纳。

## 决议

mock 层实现 Prometheus HTTP API 的 query_range 子集:`start / end / step` 参数 + `metric name + labels` 选择器,返回 matrix 结构(按 series 组织的 `[timestamp, value]` 序列)。指标类型实现 counter 与 gauge,counter 在 Worker 内计算 rate 后才可绘制。故障注入(超时、5xx、慢响应、乱序时间戳)作为 mock 的可配置行为。完整契约见 `docs/data-contract.md`。

**概念边界**:前端轮询是 Prometheus 体系中消费侧(Grafana 一侧)的类比,不是 pull 模型的实现。本方案借用的是两个语义:scrape_interval 作为轮询频率上界,step 作为查询级降采样旋钮。

## 后果

- 多一层 query_range 实现成本,换来:轮询节奏有依据(对齐 scrape_interval)、两级降采样有依据(step)、故障注入有真实原型(乱序样本是真实 Prometheus 问题)
- matrix 是传输格式而非渲染格式,Worker 内转换为列式结构,主线程不接触原始 matrix(见 ADR-0004 与 architecture.md §5.5)
