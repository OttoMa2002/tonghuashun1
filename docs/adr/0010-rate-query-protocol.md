# ADR-0010:查询协议扩展 rate 请求,栅格 rate 序列语义

状态:Accepted(来自 T11 阻塞:counter rate 面板在原协议内无合法交付路径)

## 背景

T11 要求 counter rate 面板,但 T07 只产出"单窗口→标量"的 counterRate 原语,
消息协议 §5 无 rate 请求字段,管线从不调用它。消费方无法在契约内请求 rate。
T11 正确 blocked。

## 备选与否决理由

- **改 T11 范围、撤掉 rate**:否决。rate 是性能平台核心指标(QPS/错误率/延迟率),
  撤掉弱化主题;且使 T07 的 counterRate 沦为死代码。
- **主线程算 rate**:否决,违反硬约束 3。
- **扩展协议 + Worker 内落地**:采纳。

## 决议

query.exec 增 `rate?: { windowMillis }`。语义锚定 Prometheus `rate(v[window])`
在 range query 栅格上的求值,非自行发明:

- rate 仅对 counter 序列有效;请求 rate 的 selector 命中非 counter → bad_request
- rate 要求 stepped 模式(须带 stepMillis);无 step → bad_request
- 每个栅格点 t = start + k*step,rate(t) = counterRate(trailing 窗口 [t-windowMillis, t]),
  单位 /秒,含 counter 重置处理(复用 T07 counterRate)
- 窗口内样本 < 2 → 该点 NaN(间隙)
- Worker 为求值在内部按 [start-windowMillis, end] 取底层样本;此内部有界回看
  不属于"raw 仅 million-points 页"约束(ADR-0004)管辖的页面级查询意图,
  窗口有界、量级小,二者正交

## 后果

- counterRate 接入管线,不再死代码
- 演示了契约扩展的治理流程:执行侧发现缺口 → blocked → 人工开 ADR 立法 → 落地
- raw 页面级约束与 rate 内部回看的边界被显式厘清,避免 T15 再次 blocked