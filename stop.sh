#!/usr/bin/env bash
# ==================================================================
#  停止服务 (macOS / Linux)
# ==================================================================
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 Node.js！"
  exit 1
fi

node core/grab-launcher.mjs --stop
