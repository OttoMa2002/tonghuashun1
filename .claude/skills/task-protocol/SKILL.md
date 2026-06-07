---
name: task-protocol
description: 无人值守任务执行协议。每次会话开始、领取任务、宣称完成、提交 commit 前必读。定义领取规则、DoD 纪律、commit 格式、plan.md 修改边界与禁止事项。
---

# 任务执行协议

## 领取

1. 读 plan.md 总览表,找出状态 todo 且依赖全部 done 的任务,按 ID 升序取第一个
2. 无可领任务:明确报告「无可领任务」并结束,不要自行发明工作
3. 领取即把状态改为 doing(plan.md 中你唯一允许修改的就是状态列)
4. 读任务卡片「引用」列出的全部文档段落,再读对应目录的 CLAUDE.md,然后才动手

## 执行

- 范围以卡片为准:卡片没要求的不做,做不完的不糊弄。发现卡片范围有误,
  状态改 blocked 并写明原因,等人裁决
- 遇到契约(data-contract.md)未定义的行为:同上,blocked,不自行发明语义
- 测试与实现同任务交付,DoD 里的每条断言都要有对应测试或留痕

## 完成

「完成」的唯一定义,缺一不可:

1. 卡片 DoD 逐条满足
2. `pnpm gate` 绿灯(Stop 门禁会强制验证,红灯无法结束)
3. 状态改 done,一个任务一个 commit

commit message 格式:

```
T05: worker 消息协议骨架与 matrix→列式转换

- <做了什么,2-4 行>
- bench/证据:<如适用,引用结果或 docs/evidence/ 路径>
```

## 禁止事项(每条都有强制机制,违反会被拦截或留痕)

- 门禁红灯时宣称完成、改状态为 done
- 修改 harness 路径(CLAUDE.md、.claude/、package.json、tsconfig、ESLint 配置)
- 删除或 skip/only 既有测试
- 修改任务卡片的 DoD、范围、依赖(把 DoD 改宽 = 修改裁判,ADR-0008)
- 安装契约/ADR 未批准的依赖
- 一次会话跨多个任务

## 红灯处理顺序

门禁失败时:先修代码 → 仍失败则查自己对契约的理解 → 仍失败则 blocked 留言等人。
任何时候,出路都不在修改裁判。
