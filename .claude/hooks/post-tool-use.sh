#!/usr/bin/env bash
# PostToolUse 非阻断反馈(ADR-0006):对改动的 .ts/.tsx 跑 eslint(单文件)+ tsc(全量)。
# 中间态报错是重构的合法状态,因此本 hook 永不阻断:始终 exit 0,结果经 additionalContext 回灌。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
input="$(cat)"
fp="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"

case "$fp" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

cd "$ROOT" || exit 0

lint_out="$(pnpm -s exec eslint "$fp" 2>&1)"; lint_rc=$?
type_out="$(pnpm -s exec tsc --noEmit 2>&1)"; type_rc=$?

if [ "$lint_rc" -eq 0 ] && [ "$type_rc" -eq 0 ]; then
  exit 0   # 干净则不打扰
fi

msg="PostToolUse 非阻断反馈(不阻断,可先完成结构调整再统一修复):"
[ "$lint_rc" -ne 0 ] && msg="$msg"$'\n'"[eslint] $(printf '%s' "$lint_out" | tail -15)"
[ "$type_rc" -ne 0 ] && msg="$msg"$'\n'"[tsc] $(printf '%s' "$type_out" | tail -15)"

jq -n --arg ctx "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$ctx}}'
exit 0
