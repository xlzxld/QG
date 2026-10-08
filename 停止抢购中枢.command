#!/usr/bin/env bash
# ==================================================================
#  macOS Finder 双击停止器：停止 QG 抢购中枢 (device-hub :3120)
# ==================================================================
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo ""
echo "  正在停止 QG 抢购中枢…"

STOPPED=0

# 1) 首选: PID 文件 (中枢启动时写入 data/grab/device-hub.pid)
if [ -f "data/grab/device-hub.pid" ]; then
  HUB_PID=$(tr -d '[:space:]' < "data/grab/device-hub.pid")
  if [ -n "$HUB_PID" ] && kill -0 "$HUB_PID" 2>/dev/null; then
    kill "$HUB_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6; do
      kill -0 "$HUB_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$HUB_PID" 2>/dev/null
    echo "  [OK] 已停止中枢进程 (PID $HUB_PID)"
    STOPPED=1
  fi
fi

# 2) 兜底: 按命令行匹配残留的中枢进程 (PID 文件丢失/被改时也能停干净)
LEFTOVER=$(pgrep -f "node .*core/device-hub\.mjs" 2>/dev/null)
if [ -n "$LEFTOVER" ]; then
  kill $LEFTOVER 2>/dev/null
  sleep 1
  kill -9 $LEFTOVER 2>/dev/null
  echo "  [OK] 已停止残留中枢进程: $(echo $LEFTOVER | tr '\n' ' ')"
  STOPPED=1
fi

# 清理 PID 文件 (无论进程是否真的在跑)
rm -f "data/grab/device-hub.pid"

if [ "$STOPPED" = "0" ]; then
  echo "  [i] 抢购中枢当前未在运行。"
fi

echo ""
read -n 1 -s -r -p "按任意键退出..."
