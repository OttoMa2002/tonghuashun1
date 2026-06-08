# ADR-0009:headless runner 用 bypassPermissions,安全委托 hooks

状态:Accepted(来自 T02 首跑的真实事故)

## 背景

runner 调用 `claude -p` 时未指定权限模式,headless 下无人可批准,
Claude Code 的权限系统拒绝了全部写操作,T02 无法落地。AI 正确识别
"被拒即停、不重试",runner 正确检测"状态未变、停止以免死循环"——
两道防线都生效,但任务无法推进。

## 备选与否决理由

- **保留默认权限提示**:否决。提示假设有人类在场批准,而无人值守场景
  (题目核心)根本没有人。在 headless 下它不是安全机制,是死锁来源。
- **--dangerously-skip-permissions**:可用,但部分版本首次无 TTY 会话
  仍会停在交互确认;备选保留,bypassPermissions 不通时回退。
- **--permission-mode bypassPermissions**:采纳。跳过权限提示,让任务
  在 headless 下可推进。

## 决议

runner 的 `claude -p` 调用加 `--permission-mode bypassPermissions`。

## 后果

- 安全不依赖 Claude Code 的权限提示,而依赖 PreToolUse/Stop hooks——
  hooks 在任何权限模式下都先于权限提示触发,harness 写保护、依赖准入、
  Stop 门禁全部照常生效。
- 立场:权限提示是"问人类",hooks 是"机制强制"。无人值守下前者无意义,
  后者才是真正的裁判。本 ADR 把这个立场显式化。
- 残余风险:bypass 下若 hooks 有覆盖盲区(见 ADR-0008 已知限界),
  无权限提示兜底,更凸显 hooks 规则完备性的重要。