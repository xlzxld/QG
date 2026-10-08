#!/usr/bin/env bash
# =====================================================================
# 一键为已连接的 Android 手机下载并安装 AutoJs6 / AutoX 运行时
# =====================================================================
set -e

cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "===================================================="
echo "📱 手机端自动化运行时 (AutoJs6) 一键安装工具"
echo "===================================================="

# 1. 检查 ADB
if ! command -v adb >/dev/null 2>&1; then
  echo "❌ 未检测到 adb 命令，请确保已安装 android-platform-tools"
  exit 1
fi

# 2. 检查真机连接
DEVICE_COUNT=$(adb devices | grep -w "device" | wc -l | tr -d ' ')
if [ "$DEVICE_COUNT" -eq "0" ]; then
  echo "❌ 未检测到已连接的 Android 物理真机！"
  echo "   请先通过 USB 数据线连接手机并开启 USB 调试。"
  exit 1
fi

DEVICE_ID=$(adb devices | grep -w "device" | head -n 1 | awk '{print $1}')
echo "✔ 目标手机已锁定: [$DEVICE_ID]"

# 3. 下载 AutoJs6 官方稳定版 APK
APK_NAME="autojs6-v6.7.0-universal.apk"
APK_URL="https://ghproxy.net/https://github.com/SuperMonster003/AutoJs6/releases/download/v6.7.0/autojs6-v6.7.0-universal-047ae62e.apk"
BACKUP_URL="https://github.com/SuperMonster003/AutoJs6/releases/download/v6.7.0/autojs6-v6.7.0-universal-047ae62e.apk"

if [ ! -f "$APK_NAME" ]; then
  echo "📥 正在从官方镜像源高速下载 AutoJs6 安装包..."
  if ! curl -L --connect-timeout 10 -o "$APK_NAME" "$APK_URL"; then
    echo "⚠️ 加速源连接超时，正在尝试直接从 GitHub 官方源下载..."
    curl -L --connect-timeout 30 -o "$APK_NAME" "$BACKUP_URL"
  fi
fi

if [ ! -f "$APK_NAME" ] || [ ! -s "$APK_NAME" ]; then
  echo "❌ 下载失败，请直接在手机浏览器中打开以下链接下载并安装："
  echo "   https://github.com/SuperMonster003/AutoJs6/releases"
  exit 1
fi

echo "✔ 安装包下载完成: $(ls -lh "$APK_NAME" | awk '{print $5}')"

# 4. 一键安装到手机
echo "📲 正在通过 USB 专线将 AutoJs6 安装到手机 [$DEVICE_ID]..."
adb -s "$DEVICE_ID" install -r "$APK_NAME"

echo ""
echo "===================================================="
echo "🎉 安装成功！"
echo "   现在可直接运行: ./prepare-device.sh"
echo "   将自动为你完成无障碍权限激活与代码部署！"
echo "===================================================="
