#!/usr/bin/env bash
set -euo pipefail

# Agent2Agent · Claude Code SessionStart hook
#
# 会话启动时，若项目根目录存在 .agent-platform.json，则执行 `a2a checkin`
# 输出摘要（双向同步 + 收件箱/待办/记忆摘要）。平台离线或未接入时静默跳过，
# 绝不打断会话。

# 1) 解析 Claude Code hook 经 stdin 传入的 JSON 里的 cwd；失败则退回当前目录
INPUT="$(cat 2>/dev/null || true)"
CWD="${CLAUDE_PROJECT_DIR:-$PWD}"
if [[ -n "$INPUT" ]]; then
  if command -v jq >/dev/null 2>&1; then
    CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)"
  else
    CWD="$(printf '%s' "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)"
  fi
fi
CWD="${CWD:-$PWD}"

# 2) 从 cwd 逐级向上查找项目根（含 .agent-platform.json 的目录）
find_project_root() {
  local dir="$1"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -f "$dir/.agent-platform.json" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

ROOT="$(find_project_root "$CWD" || true)"
if [[ -z "$ROOT" ]]; then
  # 项目未接入平台，静默跳过
  exit 0
fi

# 3) 定位 a2a CLI：优先项目内 cli/a2a.js，其次项目根 a2a.js，最后 PATH
CLI=""
if [[ -f "$ROOT/cli/a2a.js" ]]; then
  CLI="node $ROOT/cli/a2a.js"
elif [[ -f "$ROOT/a2a.js" ]]; then
  CLI="node $ROOT/a2a.js"
elif command -v a2a >/dev/null 2>&1; then
  CLI="a2a"
else
  echo "[agent-platform] 未找到 a2a CLI（项目内 cli/a2a.js 或 PATH 均无），跳过 check-in" >&2
  exit 0
fi

# 4) 在项目根目录执行 check-in（输出摘要；失败不阻断会话）
cd "$ROOT"
if ! $CLI checkin; then
  echo "[agent-platform] check-in 失败（平台可能离线），继续会话" >&2
fi

exit 0
