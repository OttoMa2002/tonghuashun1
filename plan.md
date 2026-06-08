# plan.md 任务清单

## 使用规则

- 按 task-protocol skill 领取任务:依赖全部 done 的任务才可领取,一次只领一个
- 任务状态:`todo / doing / done / blocked`。AI 只允许修改状态列,DoD 与范围只许人改(ADR-0008)
- 「完成」唯一定义:DoD 全满足 + `pnpm gate` 绿灯(Stop 门禁强制)。一个任务一个 commit,message 带任务 ID
- 性能预算定义在 docs/data-contract.md §性能预算,任务卡片只引用不内联
- T00、T01 为人工监督阶段,完成并锁定后才进入无人值守范围

## 总览

| ID | 任务 | 依赖 | 状态 |
|---|---|---|---|
| T00 | Harness bootstrap(人工监督) | - | done |
| T01 | data-contract.md + 契约类型(人工审定) | T00 | done |
| T02 | mock:时序生成器 | T01 | done |
| T03 | mock:query_range 实现 | T02 | done |
| T04 | mock:故障注入 | T03 | done |
| T05 | worker:消息协议骨架 + matrix→列式转换 | T01, T03 | done |
| T06 | worker:LTTB 降采样 | T05 | done |
| T07 | worker:counter rate 计算 | T05 | done |
| T08 | data:列式 store + 查询 hooks | T05 | todo |
| T09 | data:轮询调度器 | T04, T08 | todo |
| T10 | charts:uPlot React 封装 | T01, T08 | todo |
| T11 | pages:dashboard | T06, T07, T09, T10 | todo |
| T12 | pages:million-points raw 演示 | T05, T10 | todo |
| T13 | components:虚拟滚动指标表格 | T08 | todo |
| T14 | MCP 渲染验证(2h 时间盒) | T12 | todo |

## 任务卡片

### T00 Harness bootstrap(人工监督)

依赖:无
引用:architecture.md §6 全节;ADR-0005/0006/0008
范围:Vite + React + TS strict 脚手架;`pnpm gate` script;ESLint(含 import 边界规则、
vitest no-disabled-tests/no-focused-tests);.claude/ 三个 hooks 与三个 skills;
根 + 三个子级 CLAUDE.md;docs/ 骨架;headless runner 脚本(循环从 plan.md 领取
可执行任务并调用 `claude -p` 执行,无可领任务时退出)。完成后 harness 路径锁定。
DoD:
- 空脚手架上 `pnpm gate` 绿灯
- 三个 hook 各有一次人工触发验证记录(依赖拦截、harness 写拦截、Stop 红灯 block)
- runner 空跑一轮,正确报告无可领任务并退出
- 根 CLAUDE.md ≤60 行
验证:`pnpm gate`;hook 触发记录(终端输出截图)入 docs/evidence/

### T01 data-contract.md + 契约类型(人工审定)

依赖:T00
引用:architecture.md §5;ADR-0003/0004
范围:数据模型(metric/labels/sample)、query_range 参数与 matrix 结构、Worker 消息协议
(查询指令/结果/错误回执,含降采样参数)、性能预算(raw 百万点首帧、stepped 查询端到端、
Worker 转换耗时)。同步产出 src/contract/ 类型定义,doc 与类型一一对应。
DoD:
- 协议每种消息有 TS 类型且 tsc 通过
- 性能预算数值化,无「尽量快」类措辞
- 人工审定签字(commit message 注明 reviewed-by)
验证:`pnpm gate`;人工 review

### T02 mock:时序生成器

依赖:T01
引用:data-contract.md §数据模型;src/mock/CLAUDE.md
范围:counter / gauge 两类指标生成器,labels 组合可配,种子可复现。
DoD:
- 同种子两次生成结果逐点相等(确定性测试)
- counter 单调不减、gauge 在配置区间内,各有单测
- 不依赖 src/ 其他模块
验证:`pnpm gate`

### T03 mock:query_range 实现

依赖:T02
引用:data-contract.md §query_range;ADR-0003
范围:start/end/step 参数 + metric/labels 选择器,返回 matrix;step 对齐与边界取整规则
按契约;raw 模式(无 step)按契约显式区分。
DoD:
- step 边界用例(窗口不整除、start>end、空选择器)各有单测
- 返回结构与 src/contract/ 类型一致,无私有变体
验证:`pnpm gate`

### T04 mock:故障注入

依赖:T03
引用:data-contract.md §故障模式;architecture.md §5.3
范围:超时、5xx、慢响应、乱序时间戳四种故障,按概率或定向开关配置,默认全关。
DoD:
- 四种故障各有可独立开启的配置项与单测
- 故障关闭时行为与 T03 完全一致(回归测试)
验证:`pnpm gate`

### T05 worker:消息协议骨架 + matrix→列式转换

依赖:T01, T03
引用:data-contract.md §消息协议、§列式结构;src/worker/CLAUDE.md;architecture.md §5.5
范围:Worker 入口与消息分发;fetch 在 Worker 内发起;matrix→列式转换;
大数组以 Transferable 移交。
DoD:
- 协议消息全部走 src/contract/ 类型,无 any
- 转换有单测:多 series 时间戳对齐、缺点补 NaN(按契约 §6)
- Transferable 移交后源 buffer 不可用(转移语义测试)
验证:`pnpm gate`

### T06 worker:LTTB 降采样

依赖:T05
引用:data-contract.md §降采样参数、§性能预算;ADR-0004
范围:LTTB 实现,目标点数由查询指令携带;仅在 Worker 内执行。
DoD:
- 输出点数等于目标点数;首末点保留;单调时间戳保持,各有单测
- 百万点输入的转换 + 降采样耗时在 data-contract.md 预算内(基准测试)
验证:`pnpm gate`;vitest bench 结果入 commit message

### T07 worker:counter rate 计算

依赖:T05
引用:data-contract.md §指标类型与 rate 公式
范围:counter 序列的 rate 派生计算,处理 counter 重置(值回落即重置)。
DoD:
- 重置场景、单点窗口、乱序输入各有单测
- 计算只发生在 Worker(主线程无 rate 相关代码)
验证:`pnpm gate`

### T08 data:列式 store + 查询 hooks

依赖:T05
引用:data-contract.md §列式结构;architecture.md §4(依赖方向)
范围:主线程列式快照 store;useMetricQuery hook(发查询指令、收结果、暴露
loading/error/data 三态)。
DoD:
- store 只接受列式快照,不含任何转换逻辑(职责测试:传 matrix 类型应 tsc 报错)
- hook 三态切换有组件级测试(@testing-library)
验证:`pnpm gate`

### T09 data:轮询调度器

依赖:T04, T08
引用:architecture.md §5.3;data-contract.md §故障模式
范围:scrape_interval 对齐、失败指数退避、in-flight 去重(以 Worker 回执为准)、
visibility 暂停与恢复补查。
DoD:
- fake timers 单测覆盖:对齐、退避曲线、去重、暂停恢复四场景
- 对接 T04 四种故障各有行为断言(超时退避、5xx 退避、慢响应去重生效)
验证:`pnpm gate`

### T10 charts:uPlot React 封装

依赖:T01, T08
引用:src/charts/CLAUDE.md;uplot-react skill;ADR-0002
范围:uPlot wrapper:实例创建一次、数据更新走 setData、ResizeObserver 自适应、
卸载销毁。消费列式快照。
DoD:
- 数据 props 变化 N 次,uPlot 构造函数只调用一次(spy 测试)
- resize 触发 setSize 而非重建
- 卸载后无定时器/observer 泄漏
验证:`pnpm gate`

### T11 pages:dashboard

依赖:T06, T07, T09, T10
引用:architecture.md §2、§5.4;data-contract.md §性能预算
范围:多面板 stepped 查询视图(gauge 直读 + counter rate 各至少一面板),
轮询驱动,错误态/加载态可见。
DoD:
- 面板数据来源全部经调度器,无组件内私自 setInterval(lint 规则或 review 断言)
- 故障注入开启时错误态正确呈现且恢复后自愈(组件测试)
验证:`pnpm gate`;人工开 dev server 留屏录 docs/evidence/

### T12 pages:million-points raw 演示

依赖:T05, T10
引用:ADR-0004;data-contract.md §性能预算(raw 首帧)
范围:raw 查询(百万点级)单页演示,渲染耗时面板内显示(performance.now 计)。
DoD:
- 数据路径为 raw(无 step、无 LTTB),以查询指令断言
- 页面自显渲染耗时,作为 T14 断言对象
- 主线程长任务不超预算(转换在 Worker 完成的运行时证据)
验证:`pnpm gate`;耗时截图入 docs/evidence/

### T13 components:虚拟滚动指标表格

依赖:T08
引用:architecture.md §4;TanStack Virtual 官方文档
范围:指标列表虚拟滚动表格(万行级),行渲染数与视口挂钩。
DoD:
- 万行数据下实际 DOM 行数 < 50(虚拟化生效测试)
- 滚动时无整表重渲(React Profiler 或 render 计数断言)
验证:`pnpm gate`

### T14 MCP 渲染验证(2h 时间盒)

依赖:T12
引用:ADR-0007;data-contract.md §性能预算
范围:chrome-devtools MCP 对接:打开 million-points 页、截图断言非空白、
读取渲染耗时对比预算。时间盒 2 小时。
DoD(跑通分支):
- 渲染类任务 DoD 模板增加 MCP 验证项,验证脚本入 .claude/
DoD(降级分支):
- 验证方案文档(工具、断言项、预算引用)入 docs/
- 人工验证留证(截图 + 耗时)入 docs/evidence/
验证:两分支任一完成即视为 done,commit message 注明走的分支
