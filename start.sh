#!/usr/bin/env bash
# ==================================================================
#  启动全能抢购工作台 (macOS / Linux)
# ==================================================================
set -e
cd "$(dirname "$0")"

# 自动补齐 Apple Silicon Homebrew 与标准 bin 路径
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 Node.js！请通过 'brew install node' 安装或将 node 加入 PATH。"
  exit 1
fi

node core/grab-launcher.mjs "$@"
