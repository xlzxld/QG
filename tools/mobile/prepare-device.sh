#!/usr/bin/env bash
# ==================================================================
#  真机环境一键整备与提权脚本 (macOS / Linux)
# ==================================================================
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 Node.js！请运行 brew install node"
  exit 1
fi

node prepare-device.mjs "$@"
