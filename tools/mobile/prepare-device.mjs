/**
 * tools/mobile/prepare-device.mjs - 真机环境一键整备与提权脚本 (PC侧)
 * =====================================================================
 * 功能：
 *   1. 检查 ADB 设备在线状态
 *   2. 破解 Android 13+ 侧载受限设置 (ACCESS_RESTRICTED_SETTINGS)
 *   3. 静默授权并拉起无障碍服务
 *   4. 关闭系统动效加速渲染
 *   5. 设置充电不息屏
 *   6. 建立 USB 专线通道 (adb reverse tcp:3120 tcp:3120)
 *   7. 将端侧 Agent 源码推送到手机 /sdcard/qg-agent/
 * =====================================================================
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const AGENT_SRC_DIR = path.join(ROOT, 'platforms', 'app', 'agent');

function run(cmd, ignoreError = false) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
    return out.trim();
  } catch (e) {
    if (!ignoreError) {
      console.error(`❌ 执行命令失败: ${cmd}\n${e.stderr || e.message}`);
    }
    return null;
  }
}

function getAdbCommand() {
  if (run('adb version', true)) return 'adb';
  if (process.platform === 'darwin') {
    const candidates = [
      '/opt/homebrew/bin/adb',
      '/usr/local/bin/adb',
      `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        process.env.PATH = `${path.dirname(p)}:${process.env.PATH}`;
        return p;
      }
    }
  }
  return null;
}

console.log('====================================================');
console.log('📱 Android 真机抢购环境一键整备工具 (跨平台版)');
console.log('====================================================');

// 1. 检查 ADB 工具
const adbCmd = getAdbCommand();
const adbVersion = adbCmd ? run(`${adbCmd} version`, true) : null;
if (!adbVersion) {
  console.error('❌ 未在环境变量 PATH 或标准路径中找到 adb 命令！');
  if (process.platform === 'darwin') {
    console.log('💡 macOS 安装指引: 请在终端运行 brew install android-platform-tools');
  } else {
    console.log('💡 请下载 Android 平台工具并将 adb.exe 所在目录加入环境变量 PATH。');
  }
  process.exit(1);
}
console.log('✅ ADB 工具就绪:', adbVersion.split('\n')[0]);

// 2. 检查设备连接
const devicesOut = run('adb devices');
const lines = (devicesOut || '').split('\n').slice(1).filter(l => l.includes('\tdevice'));

if (lines.length === 0) {
  console.warn('⚠️ 当前未检测到已连接的 Android 物理真机！');
  console.log('   排查检查项：');
  console.log('   1. 手机是否已插上 USB 数据线');
  console.log('   2. 手机是否已开启「开发者选项」与「USB 调试」');
  console.log('   3. 手机屏幕上是否点击了「允许此电脑调试」');
  if (process.platform === 'darwin') {
    console.log('   4. ⚡ macOS 特别提示: 屏幕右上角是否弹出「是否允许配件连接？」系统弹窗 (必须点击允许)');
    console.log('   5. ⚡ macOS 特别提示: 检查是否打开了「Android 文件传输 (Android File Transfer)」或 OpenMTP 抢占了 USB 通道 (若有请彻底退出)');
  }
  process.exit(0);
}

const serial = lines[0].split('\t')[0];
console.log(`✅ 成功捕获目标物理设备: [${serial}]`);

// 3. 探测 AutoX / AutoJs6 安装包名
console.log('🔍 正在检测端侧自动化运行时 (AutoX / AutoJs6)...');
const packages = run('adb shell "pm list packages | grep -E \'autojs|autox\'" || true', true) || '';
let pkg = null;

if (packages.includes('org.autojs.autojs6')) {
  pkg = 'org.autojs.autojs6';
} else if (packages.includes('org.autojs.autoxjs.v7')) {
  pkg = 'org.autojs.autoxjs.v7';
} else if (packages.includes('org.autojs.autojs')) {
  pkg = 'org.autojs.autojs';
}

if (!pkg) {
  console.warn('⚠️ 手机上尚未检测到 AutoX.js 或 AutoJs6 运行时！');
  console.log('   请先在手机上安装 AutoJs6 或 AutoX.js（两者均兼容）。');
  console.log('   推荐下载官方 APK：');
  console.log('   • AutoJs6 官方 Releases: https://github.com/SuperMonster003/AutoJs6/releases');
  console.log('   • AutoX 官方 Releases  : https://github.com/automan-bot/AutoX/releases');
  console.log('   💡 安装完成后，重新运行本脚本即可自动完成提权与配置！');
  pkg = 'org.autojs.autojs6'; // 兜底默认包名
} else {
  console.log(`✅ 成功识别已安装的运行时包名: [${pkg}]`);
}

// 4. 解除 Android 13/14/15 侧载权限受限 (Restricted settings)
console.log('🔓 解除 Android 侧载权限限制 (Restricted settings)...');
run(`adb shell appops set ${pkg} ACCESS_RESTRICTED_SETTINGS allow`, true);

// 5. 静默赋权并激活无障碍服务
console.log('⚡ 静默激活无障碍服务...');
run(`adb shell settings put secure enabled_accessibility_services ${pkg}/com.stardust.autojs.core.accessibility.AccessibilityService`, true);
run('adb shell settings put secure accessibility_enabled 1', true);

// 6. 提速优化：关闭窗口动画并常亮
console.log('🏎️ 优化系统设置：禁用三项动效延迟，开启充电常亮...');
run('adb shell settings put global window_animation_scale 0', true);
run('adb shell settings put global transition_animation_scale 0', true);
run('adb shell settings put global animator_duration_scale 0', true);
run('adb shell svc power stayon true', true);

// 7. 建立通信管道
console.log('🔌 建立 USB adb reverse 专线 (:3120)...');
run('adb reverse tcp:3120 tcp:3120', true);

// 8. 推送端侧代码
console.log('📦 推送最新 Agent 代码至手机 /sdcard/qg-agent/ ...');
run('adb shell mkdir -p /sdcard/qg-agent', true);
run(`adb push "${AGENT_SRC_DIR}/." /sdcard/qg-agent/`, true);

console.log('====================================================');
console.log('🎉 真机整备完成！');
console.log('   可通过以下命令在手机上静默拉起抢购 Agent:');
console.log(`   adb shell am start -n ${pkg}/org.autojs.autojs.external.open.RunIntentActivity -d file:///sdcard/qg-agent/main.js`);
console.log('====================================================');
