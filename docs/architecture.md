# 架构与 AI 工程方案

> 本文档是项目顶层设计,同时是 AI Coding 工程方案(Harness)的说明书。
> 业务代码是本方案的证明载体,不是目的本身。
> 配套文档:`docs/data-contract.md`(数据契约)、`docs/adr/`(决策记录)、`plan.md`(任务清单)。

## 1. 问题定义

题目给出的平台特征,逐条映射为工程约束,再映射为本方案的应对。没有应对的特征不允许出现在设计里,防止空泛。

| 平台特征 | 工程约束 | 本方案应对 |
|---|---|---|
| 数据量大 / 百万级渲染 | 主线程不可承担数据加工;渲染层必须按量级选型 | 列式存储 + Web Worker 数据加工 + uPlot(见 ADR-0002) |
| 实时数据变化 / 轮询更新 | 轮询节奏需有依据,不能拍脑袋 | 借用 Prometheus scrape interval 语义的轮询调度器(§5.3) |
| 图表渲染密集 | 高频数据更新不可触发图表重建 | uPlot 实例复用 + setData 增量更新,由 `src/charts/CLAUDE.md` 与 `uplot-react` skill 承接(§6.1、§6.2) |
| 接口响应不稳定 | 失败、超时、乱序是常态而非异常 | mock 层故障注入 + 调度器退避/去重/暂停(§5.3) |
| 页面交互复杂 | 状态与渲染解耦 | 列式 store 单向数据流,图表只消费快照 |
| 长期维护 + AI 大量生成代码 | AI 产出必须可约束、可验证、可追溯 | Harness:分层上下文 + 门禁 + 自检闭环(§6) |

## 2. 范围与降级边界(MVP)

考察重点是 AI 上下文组织与工程方案,不是代码生成效果。据此划定:

**必做**
- uPlot 主线:dashboard(stepped 查询)+ million-points 页(raw 查询,回应「百万级渲染」)
- 轮询调度器(scrape interval 对齐、失败退避、in-flight 去重、页面不可见暂停)
- Web Worker 数据层(matrix→列式转换、LTTB 降采样、counter rate 计算)
- mock 层(Prometheus query_range 语义 + 故障注入)

**设计保留,不实现**
- ECharts 复杂图(热力图/直方图):仅保留 ADR-0002 中的接入设计

**明确不做**
- 真实后端、部署、UI 美化、完整 PromQL 解析

## 3. 技术栈

| 选型 | 一句话理由 | 详见 |
|---|---|---|
| Vite + React + TS(strict) | 工具链反馈秒级,门禁环路才跑得动;React 语料密度最高,AI 生成错误率最低 | ADR-0001 |
| uPlot | 专为百万级时序点设计;语料少的风险由 `uplot-react` skill 对冲 | ADR-0002 |
| Vitest + ESLint + tsc --noEmit | 全部进入门禁环路,要求单次全量 < 60s | ADR-0006 |
| TanStack Virtual | 大表格虚拟滚动,成熟方案不自研 | ADR-0001 |
| pnpm | 锁定依赖,配合依赖准入门禁 | ADR-0005 |

选型第一标准不是「最适合产品」,而是「最适合无人值守环路」:反馈快、确定性强、AI 训练语料常见。这是本方案的核心取舍立场。

## 4. 模块划分

```
src/
  mock/        模拟 Prometheus:时序生成器、query_range 实现、故障注入
  worker/      查询执行与数据加工:fetch、matrix 解析→列式转换、增量合并、LTTB、rate() 派生计算
  data/        主线程:轮询调度器(仅节奏与退避决策)、列式 store、查询 hooks
  charts/      uPlot React 封装(实例复用 + setData 增量更新)
  components/  虚拟滚动表格、面板容器
  pages/       dashboard(stepped)、million-points(raw)
```

依赖方向单向:`pages → components/charts → data → worker → mock`。反向引用由 ESLint 规则禁止。

## 5. 数据架构

### 5.1 数据模型

采用 Prometheus 数据模型:`metric name + labels + timestamp + value` 的时序结构,指标类型实现 counter 与 gauge。完整契约见 `docs/data-contract.md`,它是 mock/worker/data 三个模块的唯一事实源。

取舍说明:相比自造 mock 格式多一点实现成本,换来真实世界的数据契约、轮询策略的设计依据、以及面试可验证的领域语义(ADR-0003)。

### 5.2 概念边界(防误用)

前端轮询不是 Prometheus pull 模型的实现,而是其消费侧类比:mock 层模拟的是 query API(Grafana 所面对的那一侧),不是 scrape 协议。本方案**借用**两个概念:
- `scrape_interval` → 轮询频率上界:数据源 15s 才产生新点,更快的轮询是纯浪费
- `query_range` 的 `step` → 服务端降采样旋钮

### 5.3 轮询调度器

职责分界:调度器位于主线程,只负责节奏与退避**决策**,经消息协议向 Worker 下发查询指令;fetch 与响应解析在 Worker 内完成,主线程不接触原始 matrix。消息协议(查询指令、结果、错误回执)定义于 `docs/data-contract.md`。

- 节奏对齐 scrape_interval,不允许任意 setInterval
- in-flight 去重:上一查询指令未收到 Worker 回执,不发起下一次
- 失败指数退避,恢复后重置
- `document.visibilityState` 隐藏时暂停,可见时立即补一次
- 故障注入(超时 / 5xx / 慢响应 / 乱序时间戳)在 mock 层可配置,调度器行为有对应单测

### 5.4 两级降采样

1. 查询级:`step` 参数,6 小时数据按 step=30s 仅返回 720 点
2. 渲染级:Worker 内 LTTB,按图表像素宽度压缩

raw 查询(不降采样)是受控例外,仅 million-points 页使用,用于回应题目的百万级渲染要求(ADR-0004)。

### 5.5 列式存储

Prometheus matrix 响应按 series 组织 `[ts, value]` 元组;uPlot 要求列式数据(对齐时间戳数组 + 各序列值数组)。转换在 Worker 完成,大数组经 Transferable 移交主线程,store 只持有列式快照。原则:传输格式 ≠ 渲染格式,转换不占主线程。

## 6. Harness 设计

设计原则:**每个组件必须能回答「它防住了哪类无人值守事故」**,答不上来的组件删除。

### 6.1 上下文分层

| 文件 | 内容 | 防住的事故 |
|---|---|---|
| `CLAUDE.md`(根,≤60 行) | 技术栈一句话、常用命令、硬约束、docs 索引 | 根文件膨胀导致每个任务都背负全量上下文 |
| `src/worker/CLAUDE.md` | 禁 DOM、消息必须走契约类型、大数组必须 Transferable | Worker 内误用 DOM API;协议漂移;结构化克隆吃掉性能 |
| `src/charts/CLAUDE.md` | 实例复用、列式喂数、ResizeObserver 规则 | 数据一变就销毁重建 uPlot 实例 |
| `src/mock/CLAUDE.md` | query_range 语义约束、故障注入开关规范 | 按「大概的 Prometheus 印象」生成似是而非的实现 |

子级 CLAUDE.md 仅在 AI 触碰对应目录时加载:改 mock 的任务不被 uPlot 细节污染。细节一律外置 docs,按需引用,根文件 60 行上限是治理承诺,超限即重构。

### 6.2 Skills(3 个)

| Skill | 内容 | 理由 |
|---|---|---|
| `uplot-react` | React 生命周期内的实例复用、setData 增量更新、列式喂数、resize 处理 | uPlot 语料稀少,是全项目 AI 出错率最高区域,需要针对性范式注入 |
| `prom-query-semantics` | query_range 参数语义、matrix 结构、rate 公式、乱序样本处理 | 防止似是而非的 Prometheus 实现 |
| `task-protocol` | 从 plan.md 领任务、DoD、commit 格式(带任务 ID)、状态更新时机 | 无人值守的流程纪律必须被编码,不能靠对话叮嘱 |

不做 LTTB skill:算法语料充足,执行位置约束(只在 Worker)已由硬规则覆盖。Skill 数量克制是有意取舍:3 个真实命中的 skill 优于 8 个装饰性的。

### 6.3 Hooks 门禁

| Hook | 行为 | 防住的事故 |
|---|---|---|
| `PreToolUse(Bash)` | 拦截危险命令(rm -rf、push --force);拦截未批准依赖安装,提示走 ADR 流程 | 半夜 AI 自作主张引入新图表库「解决」uPlot 难题 |
| `PreToolUse(Edit\|Write\|Bash)` | 拦截对 harness 路径的写操作:CLAUDE.md、.claude/、package.json、tsconfig、ESLint 配置;测试文件禁删 | 门禁压力下 AI 修改裁判而非修复代码(ADR-0008) |
| `PostToolUse(Edit\|Write)` | 对改动文件跑 tsc + ESLint,结果以**非阻断反馈**回灌 | 错误堆积到收尾才暴露,彼时修改意图已不在上下文中 |
| `Stop` | 全量门禁:typecheck + vitest + build;红灯则 block 停止,失败输出回灌继续修 | AI 在测试未过状态下报告「已完成」 |

门禁布局取舍(ADR-0006):PostToolUse 不阻断,因为中间态报错是重构过程的合法状态,强制即时修复会造成修复抖动;硬门禁集中在 Stop,以「绿灯才算完成」为唯一硬保证。Stop 全量门禁增加每任务 20-40s 收尾成本,无人值守场景下时间不稀缺,可信的完成状态才稀缺。

### 6.4 MCP:渲染验证

单测的盲区:无法验证「canvas 真的画出来了」与「百万点渲染耗时」。引入 chrome-devtools MCP 作为自检外环:启动 dev server → 打开 million-points 页 → 截图确认非空白 → 读取渲染耗时是否在预算内。

**时间盒条款(ADR-0007)**:该项验证投入上限 2 小时;超时则降级为设计文档(验证方案 + 预期指标)+ 人工验证留证(截图与耗时记录提交至 repo)。降级不影响其余门禁。

### 6.5 自检闭环

```
领任务(task-protocol)
  → 读取任务引用的 docs 段落
  → 实现
  → [内环] PostToolUse 非阻断反馈,随写随知
  → 自查任务 DoD
  → [外环] Stop 全量门禁,红灯不得停止
  → [渲染类任务] MCP 视觉/性能验证(或降级流程)
  → commit(带任务 ID)
  → 更新 plan.md 状态
```

每一环都有强制机制或留痕要求,没有一步依赖 AI 自觉。

### 6.6 证据链

- 任务拆解:plan.md,每任务含 DoD 与验证方式
- 执行轨迹:commit 历史,一任务一 commit,message 带任务 ID
- 决策轨迹:docs/adr/,每个技术取舍一条,含被否决的备选

## 7. 上下文治理原则

1. 唯一事实源:跨模块共享的契约只存在于 `data-contract.md`,CLAUDE.md 只放指针不放副本,防漂移
2. 按需加载:分层 CLAUDE.md + 任务卡片只引用相关 docs 段落
3. 容量预算:根 CLAUDE.md ≤60 行,任务描述 ≤15 行,超限重构而非追加
4. 反馈即上下文:门禁输出直接回灌,优于人工转述

## 8. ADR 索引

| 编号 | 决议 |
|---|---|
| ADR-0001 | 构建与框架:Vite + React + TS strict(否决 Next.js) |
| ADR-0002 | 图表:uPlot 单库主线;ECharts 复杂图设计保留、不实现 |
| ADR-0003 | mock 层采用 Prometheus 查询语义(否决自造格式) |
| ADR-0004 | 两级降采样(step + LTTB),raw 为受控例外 |
| ADR-0005 | 依赖准入:新增依赖须经 ADR,hook 强制拦截 |
| ADR-0006 | 门禁布局:Stop 硬门禁 + PostToolUse 非阻断反馈 |
| ADR-0007 | MCP 渲染验证设 2 小时时间盒,超时降级 |
| ADR-0008 | Harness 自身只读,门禁红灯的唯一出路是修复代码 |
