# 高性能数据分析平台 MVP

> **这是一道 AI Coding 笔试,考察的是 Harness 工程方案——即如何组织上下文、设
> 门禁、建自检闭环,让 AI 在无人值守下大量生成代码而仍可约束、可验证、可追溯。
> 业务代码(时序图表平台)是这套方案的证明载体,不是目的本身(题目原文如此)。**

读这个 repo 时,请把它当成「一套 AI 工程方案 + 它产出的代码」两层来看。下面是
导航,不是教程。

## 从哪看起

按这个顺序读,能从「为什么」一路看到「怎么落地、是否真的落地了」:

1. **[docs/architecture.md](docs/architecture.md)** —— 架构与 Harness 设计的总
   说明书。先看 §1(平台特征→工程约束→应对的逐条映射)与 §6(Harness 设计:
   上下文分层、skills、hooks 门禁、MCP 验证、自检闭环)。这是全局入口。
2. **[docs/adr/](docs/adr/)** —— 决策轨迹,10 条。每条 ADR 都含「被否决的备选
   及否决理由」,看的是取舍过程而非结论。例如 [ADR-0002](docs/adr/0002-charting-uplot.md)
   记录了为何选 uPlot 而否决 ECharts / Canvas 自研。
3. **[plan.md](plan.md)** —— 任务拆解(T00–T17),每张卡片含依赖、引用文档段
   落、范围与 DoD。看 AI 实际是按什么粒度领取与验收的。
4. **commit 历史** —— 执行轨迹,一任务一 commit(详见下节读法)。
5. **[docs/evidence/](docs/evidence/)** —— 留证:hook 触发记录、runner 空跑输
   出、million-points 渲染截图与耗时。门禁与验证「真的发生过」的物证。

唯一事实源是 **[docs/data-contract.md](docs/data-contract.md)**(数据模型、
query_range 语义、Worker 消息协议、性能预算);跨模块契约只写在这里,其它文件
只放指针。

## commit 历史的读法:立法者与执法者分层可辨

历史里有两类 commit,刻意做成视觉可区分:

- **立法 commit(人工)** —— 改动 harness 或契约:`docs:`、`harness:`、
  `contract:`、`docs(ADR-xxxx):` 等前缀。这是「立规矩」的人在动手,例如
  `contract: 扩展 rate 查询协议(ADR-0010)`、`harness: runner 补
  bypassPermissions 权限模式`。
- **任务 commit(AI)** —— 带任务 ID:`T05: worker 消息协议骨架…`、
  `T16: 修复图表 ResizeObserver 无界增长`。这是「执法者」在既定规矩下生成代码。

沿着 `git log --oneline` 扫一遍,立法与执法在历史中天然分层:契约/harness 的改
动由人推进,落地实现由 AI 按任务卡片完成。这种可视化区分本身就是方案的一部
分——谁定规则、谁执行规则,在版本历史里一目了然。

## Harness 物理构成

方案不是 PPT,它由这些实际文件承载:

| 组成 | 位置 | 是什么 |
|---|---|---|
| 根 CLAUDE.md | [CLAUDE.md](CLAUDE.md) | 项目宪法:技术栈、命令、9 条硬约束、文档索引。≤60 行,只放指针不放副本 |
| 子级 CLAUDE.md | [src/worker/](src/worker/)、[src/charts/](src/charts/)、[src/mock/](src/mock/) 各一份 | 目录级规则,仅在 AI 触碰对应目录时加载(改 mock 不被 uPlot 细节污染) |
| hooks 门禁 | [.claude/hooks/](.claude/hooks/) | `pre-tool-use.sh`(拦危险命令/未批依赖/harness 写操作)、`post-tool-use.sh`(改文件即跑 tsc+lint 非阻断回灌)、`stop.sh`(Stop 全量门禁,红灯 block) |
| skills | [.claude/skills/](.claude/skills/) | 3 个:`uplot-react`、`prom-query-semantics`、`task-protocol`,按需注入领域范式与流程纪律 |
| runner | [.claude/runner.sh](.claude/runner.sh) | 无人值守领取器(见下节) |
| settings | [.claude/settings.json](.claude/settings.json) | hook 注册与权限配置 |
| docs | [docs/](docs/) | architecture / data-contract / adr / evidence,细节外置,CLAUDE.md 只索引 |
| 任务清单 | [plan.md](plan.md) | 任务拆解与状态;AI 只许改状态列,DoD 与范围只许人改 |

门禁布局与硬约束细节见 architecture.md §6 与根 CLAUDE.md;为何 harness 自身只
读、红灯唯一出路是修代码,见 [ADR-0008](docs/adr/0008-harness-immutability.md)。

## 复现无人值守运行

```bash
bash .claude/runner.sh
```

循环从 plan.md 领取「状态 todo 且依赖全部 done」的任务(ID 升序取第一),逐个调
`claude -p` 执行,输出 tee 到 `logs/`,无可领任务时报告并退出。先看一眼将要领什
么用 `bash .claude/runner.sh --dry-run`。

## 技术栈

Vite + React 18 + TypeScript(strict)+ uPlot + TanStack Virtual + Vitest + pnpm。
常用命令见 [CLAUDE.md](CLAUDE.md);完成的唯一定义是 DoD 全满足且 `pnpm gate` 绿灯。
