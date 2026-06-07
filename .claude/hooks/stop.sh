#!/usr/bin/env bash
# Stop 硬门禁(ADR-0006):宣称完成时强制 pnpm gate(typecheck+lint+test+build)。
# 红灯则 block(exit 2 + stderr 回灌,继续修复);绿灯放行。绿灯是「完成」的唯一定义。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
input="$(cat)"

# 防无限循环:本轮 Stop 已由 harness 触发过则放行
active="$(printf '%s' "$input" | jq -r '.stop_hook_active // false')"
[ "$active" = "true" ] && exit 0

cd "$ROOT" || { echo "Stop 门禁:无法进入项目根目录 $ROOT" >&2; exit 2; }

gate_out="$(pnpm gate 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && exit 0

{
  echo "Stop 门禁红灯:pnpm gate 失败(exit $rc)。"
  echo "完成的唯一定义是绿灯。请修复代码,不要修改裁判(ADR-0008):放宽 tsconfig / 注释 ESLint 规则 / skip 测试 / 改 gate 都不是出路。"
  echo "----- pnpm gate 输出(末 40 行)-----"
  printf '%s\n' "$gate_out" | tail -40
} >&2
exit 2
