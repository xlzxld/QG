#!/usr/bin/env bash
# ==================================================================
#  macOS Finder 双击停止器：停止服务
# ==================================================================
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

node core/grab-launcher.mjs --stop
echo ""
echo "  [OK] 服务已停止。"
read -n 1 -s -r -p "按任意键退出..."
