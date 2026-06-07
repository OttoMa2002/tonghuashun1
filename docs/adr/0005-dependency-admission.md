# ADR-0005:依赖准入须经 ADR,hook 强制拦截未批准安装

状态:Accepted

## 背景

无人值守场景下,AI 遇到难题(典型如 uPlot API 不熟)的最短路径是引入一个它更熟悉的库绕过去。新依赖意味着:bundle 体积、供应链攻击面、长期维护负担,这些成本 AI 不承担,因此不能由 AI 单方面决定。

## 备选与否决理由

- **信任模型自律(CLAUDE.md 写一条规则即可)**:零实现成本。否决:门禁压力下,纯文本规则的约束力会输给「让测试变绿」的目标。规则必须有强制机制兜底。
- **事后 review diff**:常规团队做法。否决:与「半夜无人值守」的前提直接冲突,发现时依赖已渗入代码。
- **PreToolUse 强制拦截**:采纳。

## 决议

新增任何 runtime 或 dev 依赖,必须先提交一条 ADR(含引入理由、备选、bundle 影响)并由人批准。`PreToolUse(Bash)` hook 解析 `pnpm/npm/yarn add|install` 命令,白名单(当前 package.json 中已有依赖)之外的包名直接 deny,返回提示:「走 ADR 流程」。

初始白名单 = ADR-0001 / ADR-0002 选型确定的依赖(Vite + React + TS、uPlot、TanStack Virtual、Vitest 等)+ 门禁所需的测试工具链(`@testing-library/*`、jsdom、ESLint 及其插件等),随 T00 脚手架一次性预装,故其本身不再单独补 ADR;此后任何白名单之外的新增才触发本流程。

## 后果

- AI 被迫在现有依赖内解决问题,这正是 skills 的设计意图:`uplot-react` skill 存在的理由之一就是堵住「换库」这条逃生通道
- 白名单与 package.json 同步,无独立维护成本
- 人工引入新依赖时需同时补 ADR,流程摩擦增加,接受
