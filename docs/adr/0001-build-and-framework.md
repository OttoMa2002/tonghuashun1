# ADR-0001:构建与框架选 Vite + React + TypeScript strict,否决 Next.js

状态:Accepted

## 背景

本项目是纯前端 MVP,无 SSR / 路由复杂度 / 后端诉求。AI 无人值守产出代码,选型第一标准不是「最适合产品」,而是「最适合门禁环路」:工具链反馈快、行为确定、AI 训练语料密度高(语料密度直接决定生成错误率,也决定人审成本)。

## 备选与否决理由

- **Next.js**:团队最熟。否决:本项目用不到其全部增值能力(SSR、路由约定、API routes),却要承担更慢的构建与更多的框架约定。门禁环路每天跑数十次,构建时间是乘数成本。且面试追问「为什么用 Next」没有正面答案。
- **Vue + Vite**:构建速度同样优秀。否决:非主栈。无人值守模式下人的角色是审查者,审查者必须比生成者更懂这门技术,主栈外选型直接削弱审查能力。
- **Vite + React + TS strict**:采纳。

## 决议

Vite + React 18 + TypeScript strict。配套:Vitest(同工具链,启动快)、TanStack Virtual(虚拟滚动,成熟不自研)、pnpm。

## 后果

- 全量门禁(typecheck + lint + test + build)预算 60s 内可达成
- TS strict 成为自检环路里成本最低的一道门禁,类型错误在 PostToolUse 即暴露
- 放弃 Next 的 image 优化、文件路由等能力:本项目无此诉求,零损失
