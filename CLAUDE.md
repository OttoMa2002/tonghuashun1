# 高性能数据分析平台 MVP

本文件是项目宪法:只放硬约束与索引,细节一律见 docs/,不要把文档内容复制进来。

## 技术栈

Vite + React 18 + TypeScript(strict)+ uPlot + TanStack Virtual + Vitest + pnpm

## 常用命令

- `pnpm dev` 开发服务器
- `pnpm typecheck` tsc --noEmit
- `pnpm lint` ESLint
- `pnpm test` Vitest
- `pnpm gate` typecheck + lint + test + build(Stop 门禁执行的就是它)

## 硬约束(违反即返工,不接受例外协商)

1. TypeScript strict;禁 `any` 与 `@ts-ignore`,确需压制必须用 `@ts-expect-error` 并注释原因
2. 时序数据一律列式结构(对齐时间戳数组 + 各序列值数组),结构定义见 docs/data-contract.md
3. matrix 解析、降采样、rate 计算只允许发生在 src/worker/ 内,主线程不做数据加工
4. fetch 只在 Worker 内发起;主线程调度器只下发查询指令,消息协议见 docs/data-contract.md
5. uPlot 实例必须复用,数据更新走 setData;禁止因数据变更销毁重建实例
6. 新增任何依赖必须先有 ADR(docs/adr/),未批准的安装会被 hook 拦截
7. 模块依赖单向:pages → components/charts → data → worker → mock,禁止反向引用
8. 跨模块契约只写在 docs/data-contract.md,任何文件不得内联其副本
9. Harness 自身只读:CLAUDE.md、.claude/、package.json、tsconfig、ESLint 配置不得修改;
   既有测试不得删除或 skip。门禁红灯的唯一出路是修复代码,不是修改裁判

## 任务流程

从 plan.md 领取任务,按 task-protocol skill 执行。完成的唯一定义:任务卡片 DoD 全部满足且
`pnpm gate` 绿灯。一个任务一个 commit,message 带任务 ID。禁止在门禁红灯时宣称完成。

## 文档索引

- docs/architecture.md 架构与 Harness 设计(改动架构前必读 §4、§5)
- docs/data-contract.md 数据模型、query_range 语义、Worker 消息协议(唯一事实源)
- docs/adr/ 决策记录(引入依赖、推翻既有取舍前必读)
- plan.md 任务清单与状态

## 目录级规则

src/worker/、src/charts/、src/mock/ 各有自己的 CLAUDE.md,触碰对应目录时遵守其规则。
