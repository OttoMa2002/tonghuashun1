# ADR-0008:Harness 自身只读,门禁红灯的唯一出路是修复代码

状态:Accepted

## 背景

ADR-0006 建立了「绿灯才算完成」的硬保证后,出现一条新的逃生通道:门禁压力下,AI 的最短路径可能不是修复代码,而是修改裁判——放宽 tsconfig、注释掉 ESLint 规则、删除或 skip 失败的测试、改写 gate script。这是 reward hacking 在工程侧的具体形态。裁判可被被裁判者修改,则门禁形同虚设。

未并入 ADR-0006 的理由:0006 解决的是「门禁放在哪、阻不阻断」的布局取舍,本条解决的是「门禁本身的完整性」,威胁模型不同,失效后果不同,各自独立演进。

## 备选与否决理由

- **信任 + 事后审计 diff**:否决:与无人值守前提冲突,且被污染的门禁会给后续所有任务发放假绿灯,损害是累积的。
- **仅靠 CLAUDE.md 文本规则**:否决:与 ADR-0005 同理,纯文本规则在目标压力下约束力不足,须有强制机制。
- **PreToolUse 路径拦截 + gate 内容检查**:采纳。

## 决议

只读路径清单:`CLAUDE.md`(含各子级)、`.claude/`(hooks、skills、settings)、`package.json`、`tsconfig.json`、ESLint 配置。`PreToolUse(Edit|Write|Bash)` 拦截对上述路径的一切写操作;测试文件禁止删除。

**内容级篡改无法靠路径拦截**(skip 测试改的是测试文件自身内容),分两层兜底:

- `eslint-plugin-vitest` 的 no-disabled-tests / no-focused-tests 规则,在 `pnpm gate` 中拦截 `.skip` / `.only`
- 既有测试的删改在 commit diff 中天然留痕,作为人工抽查锚点

例外:`plan.md` 的任务状态列是 AI 必须更新的,不在只读清单;其修改边界由 task-protocol skill 约束(只许改状态,不许改 DoD)。

Harness 的一切变更走唯一通道:人工 commit。bootstrap 阶段(harness 自身的搭建)在锁定前由人工监督完成,不属于无人值守范围。

## 后果

- AI 无法自助新增 npm script 或依赖声明,需要人工介入:接受,这正是设计意图
- 只读清单需随 harness 演进同步维护,由人负责
- 「修改裁判」与「修复代码」的成本差被强制拉开,AI 的最短路径回到修复代码本身
