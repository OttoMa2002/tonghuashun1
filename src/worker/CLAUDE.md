# src/worker/ 规则

本目录是数据加工的唯一场所。契约以 docs/data-contract.md §5、§6 为准,类型从 src/contract/ import,禁止本地重定义。

1. 禁止访问 DOM、window、document。Worker 全局只用 self
2. fetch 只允许在本目录发起;MatrixResponse 不得离开 Worker,出去的只有 ColumnarFrame
3. 一切消息走信封格式(id 原样回带),每个 query.exec 必有且只有一个回执(result 或 error)
4. 大数组(ts、各 values 的 buffer)必须经 Transferable 移交;移交后本侧不得再访问该 buffer
5. matrix 解析、LTTB、rate 计算只发生在这里;新增派生计算先查契约,契约没有就先提请人工改契约
6. 禁止吞错:任何失败路径都要发 query.error 并带 kind,沉默失败会让调度器的退避逻辑失明
7. ts 严格递增、values 与 ts 等长是输出不变量,违反即 bug,不许在下游修补
