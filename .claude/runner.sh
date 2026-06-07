#!/usr/bin/env bash
# headless runner(harness 组件,architecture.md §6 / plan.md):
# 循环从 plan.md 总览表领取「状态 todo 且依赖全部 done」的任务(ID 升序取第一,task-protocol 一致),
# 调用 `claude -p` 执行;每个任务的输出 tee 到 logs/<ID>-<ts>.log 留档;无可领任务时报告并 exit 0。
#   用法:.claude/runner.sh            正常领取循环
#         .claude/runner.sh --dry-run  仅报告将领取的任务,不执行
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN="$ROOT/plan.md"
LOGDIR="$ROOT/logs"
mkdir -p "$LOGDIR"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

run_log="$LOGDIR/runner-$(date +%Y%m%d-%H%M%S).log"
log() { printf '%s\n' "$*" | tee -a "$run_log"; }

# 总览表行解析:输出 "ID<TAB>deps<TAB>status"
parse_rows() {
  awk -F'|' '
    /^\|[[:space:]]*T[0-9]+[[:space:]]*\|/ {
      id=$2; deps=$4; st=$5;
      gsub(/^[ \t]+|[ \t]+$/,"",id);
      gsub(/^[ \t]+|[ \t]+$/,"",deps);
      gsub(/^[ \t]+|[ \t]+$/,"",st);
      print id "\t" deps "\t" st;
    }' "$PLAN"
}

status_of() {  # $1=ID -> 状态(找不到为 MISSING)
  parse_rows | awk -F'\t' -v id="$1" '$1==id{print $3; f=1} END{if(!f)print "MISSING"}'
}

claimable() {  # 输出第一个可领 ID(ID 升序),无则空
  parse_rows | while IFS=$'\t' read -r id deps st; do
    [ "$st" = "todo" ] || continue
    ok=1
    if [ "$deps" != "-" ] && [ -n "$deps" ]; then
      IFS=',' read -ra arr <<< "$deps"
      for d in "${arr[@]}"; do
        d="$(printf '%s' "$d" | tr -d ' ')"
        [ -z "$d" ] && continue
        [ "$(status_of "$d")" = "done" ] || { ok=0; break; }
      done
    fi
    [ "$ok" -eq 1 ] && { printf '%s\n' "$id"; break; }
  done
}

log "[runner] 领取循环开始 $(date '+%F %T')"
while :; do
  task="$(claimable)"
  if [ -z "$task" ]; then
    log "[runner] 无可领任务(不存在 todo 且依赖全部 done 的任务),退出。"
    exit 0
  fi
  log "[runner] 领取任务:$task"
  if [ "$DRY" -eq 1 ]; then
    log "[runner] --dry-run:仅报告,不执行,退出。"
    exit 0
  fi
  if ! command -v claude >/dev/null 2>&1; then
    log "[runner] 错误:未找到 claude CLI,无法执行 $task,退出。"
    exit 1
  fi
  task_log="$LOGDIR/${task}-$(date +%Y%m%d-%H%M%S).log"
  prompt="执行 plan.md 的 $task,仅此一个任务,按 task-protocol skill 全流程执行(领取→实现→DoD→pnpm gate 绿灯→commit→更新状态)。"
  log "[runner] 调用 claude -p,输出 tee 到 $task_log"
  claude -p "$prompt" 2>&1 | tee "$task_log"
  if [ "$(status_of "$task")" = "todo" ]; then
    log "[runner] 警告:$task 执行后状态仍为 todo,停止以免死循环。"
    exit 1
  fi
done
