#!/usr/bin/env bash
# ==================================================================
#  macOS Finder 双击整备手机：解除受限设置、激活无障碍并同步脚本
# ==================================================================
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

node prepare-device.mjs
echo ""
read -n 1 -s -r -p "按任意键退出..."
