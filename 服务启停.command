#!/usr/bin/env bash
# ==================================================================
#  macOS Finder 双击入口：服务启停台（启动 / 停止 / 重启 / 状态）
#  桥接服务 :3100 ｜ 手机中枢 :3120
# ==================================================================
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  [错误] 未找到 Node.js！"
  echo "  请打开终端运行: brew install node"
  echo ""
  read -n 1 -s -r -p "按任意键退出..."
  exit 1
fi

node core/service-menu.mjs "$@"
