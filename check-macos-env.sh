#!/usr/bin/env bash
# ==============================================================================
#  macOS 环境自动化自检与诊断脚本 (Apple Silicon / Intel 跨架构支持)
#  Flash Sale System · OmniGrab Studio
# ==============================================================================

set -u
cd "$(dirname "$0")"

# 优先载入 Homebrew 环境变量
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/Library/Android/sdk/platform-tools:$PATH"

# 终端色彩定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

ERR_COUNT=0
WARN_COUNT=0

echo -e "${BOLD}${CYAN}====================================================================${RESET}"
echo -e "${BOLD}${CYAN}   🍏 全能抢购工作台 · macOS 环境自检与就绪诊断工具                 ${RESET}"
echo -e "${BOLD}${CYAN}====================================================================${RESET}"
echo ""

# ------------------------------------------------------------------------------
# 1. 操作系统与芯片架构检查
# ------------------------------------------------------------------------------
echo -e "${BOLD}[1/7] 检查操作系统与芯片架构...${RESET}"
OS_NAME=$(uname -s)
ARCH_NAME=$(uname -m)

if [ "$OS_NAME" != "Darwin" ]; then
    echo -e "  ${RED}✘ 异常：当前系统不是 macOS (系统标识: $OS_NAME)${RESET}"
    ERR_COUNT=$((ERR_COUNT + 1))
else
    MAC_VER=$(sw_vers -productVersion 2>/dev/null || echo "未知")
    MAC_BUILD=$(sw_vers -buildVersion 2>/dev/null || echo "")
    if [ "$ARCH_NAME" = "arm64" ]; then
        echo -e "  ${GREEN}✔ macOS $MAC_VER ($MAC_BUILD) · Apple Silicon (M系列芯片 · arm64)${RESET}"
    else
        echo -e "  ${GREEN}✔ macOS $MAC_VER ($MAC_BUILD) · Intel 架构 ($ARCH_NAME)${RESET}"
    fi
fi

# ------------------------------------------------------------------------------
# 2. 包管理器 Homebrew 检查
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[2/7] 检查包管理器 (Homebrew)...${RESET}"
if command -v brew >/dev/null 2>&1; then
    BREW_VER=$(brew --version 2>/dev/null | head -n 1)
    echo -e "  ${GREEN}✔ Homebrew 已安装：${BREW_VER}${RESET}"
else
    echo -e "  ${YELLOW}⚠ 未找到 Homebrew！${RESET}"
    echo -e "    ${DIM}提示：Homebrew 是 Mac 上最推荐的开发依赖安装工具。${RESET}"
    echo -e "    ${CYAN}安装命令：/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${RESET}"
    WARN_COUNT=$((WARN_COUNT + 1))
fi

# ------------------------------------------------------------------------------
# 3. Node.js 运行环境检查
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[3/7] 检查 Node.js 运行时...${RESET}"
if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node -v)
    NODE_PATH=$(which node)
    NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d'.' -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
        echo -e "  ${GREEN}✔ Node.js 已就绪：${NODE_VER} (${NODE_PATH})${RESET}"
    else
        echo -e "  ${YELLOW}⚠ Node.js 版本过低：当前为 ${NODE_VER}，推荐 v18 或 v20 及以上。${RESET}"
        echo -e "    ${CYAN}升级命令：brew upgrade node${RESET}"
        WARN_COUNT=$((WARN_COUNT + 1))
    fi
else
    echo -e "  ${RED}✘ 未找到 Node.js！核心服务无法运行。${RESET}"
    echo -e "    ${CYAN}安装命令：brew install node${RESET}"
    ERR_COUNT=$((ERR_COUNT + 1))
fi

# ------------------------------------------------------------------------------
# 4. Google Chrome 浏览器检查
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[4/7] 检查 Google Chrome 浏览器...${RESET}"
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ALT_CHROME_PATH="$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ -f "$CHROME_PATH" ]; then
    CHROME_VER=$("$CHROME_PATH" --version 2>/dev/null || echo "Google Chrome")
    echo -e "  ${GREEN}✔ Google Chrome 已安装：${CHROME_VER}${RESET}"
    echo -e "    ${DIM}路径: ${CHROME_PATH}${RESET}"
elif [ -f "$ALT_CHROME_PATH" ]; then
    CHROME_VER=$("$ALT_CHROME_PATH" --version 2>/dev/null || echo "Google Chrome")
    echo -e "  ${GREEN}✔ Google Chrome 已安装 (用户目录)：${CHROME_VER}${RESET}"
    echo -e "    ${DIM}路径: ${ALT_CHROME_PATH}${RESET}"
else
    echo -e "  ${RED}✘ 未在 /Applications 中找到 Google Chrome！${RESET}"
    echo -e "    ${YELLOW}重要说明：本项目多槽位秒杀与 CDP 协议强依赖 Chrome，Safari 无法替代。${RESET}"
    echo -e "    ${CYAN}安装方式 1：brew install --cask google-chrome${RESET}"
    echo -e "    ${CYAN}安装方式 2：访问 https://www.google.cn/chrome/ 下载安装包${RESET}"
    ERR_COUNT=$((ERR_COUNT + 1))
fi

# ------------------------------------------------------------------------------
# 5. Android 平台工具 (ADB) 检查
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[5/7] 检查 Android ADB 调试工具...${RESET}"
if command -v adb >/dev/null 2>&1; then
    ADB_VER=$(adb version 2>/dev/null | head -n 1)
    ADB_PATH=$(which adb)
    echo -e "  ${GREEN}✔ ADB 工具已就绪：${ADB_VER}${RESET}"
    echo -e "    ${DIM}路径: ${ADB_PATH}${RESET}"
else
    echo -e "  ${RED}✘ 未找到 adb 命令！手机中枢将无法通过 USB 整备和救活设备。${RESET}"
    echo -e "    ${CYAN}一键安装：brew install android-platform-tools${RESET}"
    ERR_COUNT=$((ERR_COUNT + 1))
fi

# ------------------------------------------------------------------------------
# 6. Android 物理设备连接诊断
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[6/7] 检查 Android 物理设备连接...${RESET}"
# 检查是否有多余进程抢占 USB
MTP_PROCS=$(pgrep -f -l "Android File Transfer|OpenMTP" 2>/dev/null || true)
if [ -n "$MTP_PROCS" ]; then
    echo -e "  ${YELLOW}⚠ 警告：检测到后台正在运行 MTP 传输工具（可能会独占 USB 导致 ADB 失联）：${RESET}"
    echo -e "    ${DIM}$MTP_PROCS${RESET}"
    echo -e "    ${CYAN}建议命令：pkill -f 'Android File Transfer' ; pkill -f 'OpenMTP'${RESET}"
    WARN_COUNT=$((WARN_COUNT + 1))
fi

if command -v adb >/dev/null 2>&1; then
    ADB_DEV_LIST=$(adb devices 2>/dev/null | sed '1d' | grep -v '^$' || true)
    if [ -z "$ADB_DEV_LIST" ]; then
        echo -e "  ${YELLOW}⚠ 当前未检测到已连接的 Android 物理真机${RESET}"
        echo -e "    ${DIM}排查指引：${RESET}"
        echo -e "    1. 手机是否已插上 USB 数据线？"
        echo -e "    2. 手机是否已在开发者选项中开启「USB 调试」？"
        echo -e "    3. ${BOLD}Mac 屏幕右上角是否弹出「允许配件连接？」系统通知？(必须点击允许)${RESET}"
        WARN_COUNT=$((WARN_COUNT + 1))
    else
        ONLINE_DEV=$(echo "$ADB_DEV_LIST" | grep 'device$' || true)
        UNAUTH_DEV=$(echo "$ADB_DEV_LIST" | grep 'unauthorized$' || true)
        if [ -n "$ONLINE_DEV" ]; then
            DEV_SN=$(echo "$ONLINE_DEV" | head -n 1 | awk '{print $1}')
            echo -e "  ${GREEN}✔ 成功识别已授权真机：[${DEV_SN}] (状态正常)${RESET}"
        fi
        if [ -n "$UNAUTH_DEV" ]; then
            echo -e "  ${YELLOW}⚠ 发现未授权设备！请亮屏并在手机端勾选「一律允许使用这台计算机进行调试」${RESET}"
            WARN_COUNT=$((WARN_COUNT + 1))
        fi
    fi
else
    echo -e "  ${DIM}（因缺少 adb，跳过设备探测）${RESET}"
fi

# ------------------------------------------------------------------------------
# 7. 项目依赖与端口占用检查
# ------------------------------------------------------------------------------
echo -e "\n${BOLD}[7/7] 检查项目依赖与端口状态...${RESET}"
if [ -d "node_modules" ]; then
    echo -e "  ${GREEN}✔ 项目依赖包 (node_modules) 已就绪${RESET}"
else
    echo -e "  ${RED}✘ 缺少 node_modules！项目尚未安装依赖。${RESET}"
    echo -e "    ${CYAN}修复命令：npm install${RESET}"
    ERR_COUNT=$((ERR_COUNT + 1))
fi

# 检查端口占用
PORT_3100_PID=$(lsof -ti :3100 2>/dev/null || true)
PORT_3120_PID=$(lsof -ti :3120 2>/dev/null || true)

if [ -n "$PORT_3100_PID" ]; then
    echo -e "  ${BLUE}ℹ 端口 3100 (桥接服务) 当前正在运行 (PID: $PORT_3100_PID)${RESET}"
else
    echo -e "  ${GREEN}✔ 端口 3100 (桥接服务) 空闲可用${RESET}"
fi

if [ -n "$PORT_3120_PID" ]; then
    echo -e "  ${BLUE}ℹ 端口 3120 (手机中枢) 当前正在运行 (PID: $PORT_3120_PID)${RESET}"
else
    echo -e "  ${GREEN}✔ 端口 3120 (手机中枢) 空闲可用${RESET}"
fi

# ------------------------------------------------------------------------------
# 诊断结论与一键行动建议
# ------------------------------------------------------------------------------
echo ""
echo -e "${BOLD}${CYAN}====================================================================${RESET}"
echo -e "${BOLD}                       自检诊断结论与建议                           ${RESET}"
echo -e "${BOLD}${CYAN}====================================================================${RESET}"

if [ "$ERR_COUNT" -eq 0 ] && [ "$WARN_COUNT" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}🎉 完美！当前 Mac 运行环境 100% 具备抢购与自动化运行条件！${RESET}"
    echo ""
    echo -e "  ${BOLD}快速启动操作：${RESET}"
    echo -e "  • 双击启动（Finder）：${CYAN}服务启停.command${RESET} → 菜单按 1（启动全部）"
    echo -e "  • 终端命令          ：运行 ${CYAN}node core/service-menu.mjs${RESET}"
    echo -e "  • 看板网址          ：${BLUE}http://localhost:3120${RESET}"
elif [ "$ERR_COUNT" -eq 0 ]; then
    echo -e "${YELLOW}${BOLD}⚠ 基础核心环境正常，但有 $WARN_COUNT 项警示（大多为手机未插或未授权）：${RESET}"
    echo -e "  若已安装 Chrome 与 Node，插上手机并开启 USB 调试后即可正常运行！"
    echo -e "  双击运行 ${CYAN}tools/mobile/prepare-device.command${RESET} 即可一键整备手机。"
else
    echo -e "${RED}${BOLD}✘ 检测到 $ERR_COUNT 项缺失！请按以下命令补全环境：${RESET}"
    echo ""
    echo -e "${BOLD}针对性修复命令 (在 Mac 终端复制执行)：${RESET}"
    FIX_CMD=""
    if ! command -v node >/dev/null 2>&1; then
        FIX_CMD="brew install node"
    fi
    if ! command -v adb >/dev/null 2>&1; then
        FIX_CMD="${FIX_CMD:+$FIX_CMD && }brew install android-platform-tools"
    fi
    if [ ! -f "$CHROME_PATH" ] && [ ! -f "$ALT_CHROME_PATH" ]; then
        FIX_CMD="${FIX_CMD:+$FIX_CMD && }brew install --cask google-chrome"
    fi
    if [ ! -d "node_modules" ]; then
        FIX_CMD="${FIX_CMD:+$FIX_CMD && }npm install"
    fi
    [ -z "$FIX_CMD" ] && FIX_CMD="npm install"
    echo -e "  ${CYAN}${BOLD}${FIX_CMD}${RESET}"
    echo ""
fi
echo -e "${BOLD}${CYAN}====================================================================${RESET}"
