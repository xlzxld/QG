#!/usr/bin/env bash
# ==================================================================
#  启动 APP端抢购设备中枢 Device Hub :3120 (macOS / Linux)
# ==================================================================
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 Node.js！请通过 'brew install node' 安装。"
  exit 1
fi

echo ""
echo "============================================================"
echo "  🚀 正在启动 APP端抢购设备中枢 (Device Hub :3120)..."
echo "============================================================"
echo ""

node core/device-hub.mjs
