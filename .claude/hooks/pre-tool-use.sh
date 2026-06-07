#!/usr/bin/env bash
# PreToolUse 门禁(architecture.md §6.3):
#   - 依赖准入(ADR-0005):白名单外的 add/install 一律 deny,提示走 ADR 流程
#   - harness 路径写保护(ADR-0008):CLAUDE.md / .claude/ / package.json / pnpm-lock / tsconfig / eslint 配置只读
#   - 危险命令拦截:rm -rf、git push --force、删除既有测试
# 协议:stdin 收 Claude Code hook JSON;deny = exit 2 + stderr(被模型读取并回灌)。allow = exit 0。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
input="$(cat)"
tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty')"

deny() { printf 'DENY %s\n' "$1" >&2; exit 2; }

# ADR-0008 只读路径
is_harness_path() {
  case "$1" in
    *CLAUDE.md|*/.claude/*|*/.claude|*package.json|*pnpm-lock.yaml|*tsconfig*.json|*eslint.config.*|*.eslintrc*) return 0 ;;
  esac
  return 1
}

case "$tool_name" in
  Edit|Write|MultiEdit|NotebookEdit)
    fp="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
    if [ -n "$fp" ] && is_harness_path "$fp"; then
      deny "(harness 只读 ADR-0008):禁止写 ${fp} —— 门禁红灯的唯一出路是修复代码,不是修改裁判;harness 变更只走人工 commit。"
    fi
    ;;
  Bash)
    cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"

    # 1) 危险删除 / 强推
    if printf '%s' "$cmd" | grep -iqE '\brm\b[[:space:]]+-[a-z]*[rf]'; then
      deny "(危险命令):检测到 rm -rf 类删除,如确需请人工执行。"
    fi
    if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+push\b.*(--force|--force-with-lease|[[:space:]]-f\b)'; then
      deny "(危险命令):禁止 git push --force。"
    fi

    # 2) 经 Bash 改写 harness 路径(重定向 / sed -i / rm / mv / cp / truncate)
    if printf '%s' "$cmd" | grep -qE '(>>?|[[:space:]]tee[[:space:]]|sed[[:space:]]+-i|[[:space:]]rm[[:space:]]|[[:space:]]mv[[:space:]]|[[:space:]]cp[[:space:]]|truncate)[^|;&]*(CLAUDE\.md|\.claude/|package\.json|pnpm-lock\.yaml|tsconfig[^[:space:]]*\.json|eslint\.config|\.eslintrc)'; then
      deny "(harness 只读 ADR-0008):禁止经 Bash 改写 harness 路径。"
    fi

    # 3) 禁止删除既有测试(ADR-0008)
    if printf '%s' "$cmd" | grep -qE '\brm\b[^|;&]*\.(test|spec|bench)\.[cm]?[jt]sx?\b'; then
      deny "(ADR-0008):既有测试禁止删除/skip,红灯只能修代码。"
    fi

    # 5) 补丁/恢复类命令可改写任意路径,绕过写动词检测(T00 实测盲区,人工补强)
    if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+apply\b|(^|[;&|[:space:]])patch[[:space:]]'; then
      deny "(harness 只读 ADR-0008):git apply / patch 可绕过路径写保护,一律由人工执行。"
    fi
    if printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+(checkout|restore)\b[^|;&]*(CLAUDE\.md|\.claude/|package\.json|pnpm-lock\.yaml|tsconfig[^[:space:]]*\.json|eslint\.config|\.eslintrc)'; then
      deny "(harness 只读 ADR-0008):禁止经 git checkout/restore 回滚 harness 路径。"
    fi
    
    # 4) 依赖准入(ADR-0005):拦截白名单外的 add/install <pkg>
    if printf '%s' "$cmd" | grep -qE '\b(pnpm|npm|yarn)\b.*\b(add|install|i)\b'; then
      pkgs="$(printf '%s' "$cmd" \
        | grep -oE '\b(add|install|i)\b.*' \
        | tr ' ' '\n' \
        | grep -vE '^(add|install|i|pnpm|npm|yarn|-{1,2}[a-zA-Z].*)$' \
        | awk 'NF' || true)"
      if [ -n "$pkgs" ]; then
        allow="$(jq -r '((.dependencies // {}) + (.devDependencies // {})) | keys[]' "$ROOT/package.json" 2>/dev/null || true)"
        while IFS= read -r pkg; do
          [ -z "$pkg" ] && continue
          base="$(printf '%s' "$pkg" | sed -E 's/(@[^/]+\/[^@]+|[^@/][^@]*)@.*/\1/')"
          if ! printf '%s\n' "$allow" | grep -qxF "$base"; then
            deny "(依赖准入 ADR-0005):包名 [${base}] 不在白名单。新增依赖须先提 ADR(引入理由/备选/bundle 影响)并经人批准;skills 的设计意图之一就是堵住『换库』这条逃生通道。"
          fi
        done <<< "$pkgs"
      fi
    fi
    ;;
esac

exit 0
