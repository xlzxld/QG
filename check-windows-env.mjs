/**
 * Windows 环境自检与就绪诊断工具
 * =====================================================================
 * 用法：
 *   双击 自检-Windows环境.bat（推荐），或运行： node check-windows-env.mjs
 *
 * 对应 macOS 版：check-macos-env.sh / 自检-macOS环境.command
 * 检查 7 项：系统与架构 / 包管理器 / Node.js / Chrome / ADB / 手机设备 / 依赖与端口
 * =====================================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 输出工具（终端上色；管道/重定向时自动关闭） ---------- */
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const code = (n, s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : s);
const BOLD = (s) => code('1', s);
const DIM = (s) => code('2', s);
const RED = (s) => code('31', s);
const GREEN = (s) => code('32', s);
const YELLOW = (s) => code('33', s);
const BLUE = (s) => code('34', s);
const CYAN = (s) => code('36', s);

let ERR_COUNT = 0;
let WARN_COUNT = 0;
const ok = (s) => `  ${GREEN('✔')} ${s}`;
const warn = (s) => {
  WARN_COUNT++;
  return `  ${YELLOW('⚠')} ${s}`;
};
const fail = (s) => {
  ERR_COUNT++;
  return `  ${RED('✘')} ${s}`;
};

/* ---------- 进程执行工具（异步 spawn，全部带超时，失败不抛异常） ---------- */
function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(out);
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish();
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      finish();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish();
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** 执行命令并返回 { ok, out }；起不来/超时/完全没有输出都算 ok=false。 */
async function run(cmd, timeout = 8000) {
  const out = await runCapture(cmd[0], cmd.slice(1), timeout);
  return { ok: out.trim().length > 0, out: out.trim() };
}

/** PowerShell 辅助：强制 UTF-8 输出，避免中文系统下乱码 */
const PS_PREFIX = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';
function ps(script, timeout = 15000) {
  return run(['powershell', '-NoProfile', '-NonInteractive', '-Command', PS_PREFIX + script], timeout);
}

/* ---------- 端口探测（跨平台） ---------- */
async function listeningPids(port) {
  const pids = new Set();
  if (process.platform === 'win32') {
    const out = await runCapture('netstat', ['-ano', '-p', 'TCP'], 10000);
    for (const s of out.split(/\r?\n/)) {
      const m = s.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
  } else {
    const out = await runCapture('lsof', ['-ti', `:${port}`], 10000);
    for (const pid of out.trim().split(/\s+/)) {
      if (pid && !isNaN(Number(pid))) pids.add(pid);
    }
  }
  return pids;
}

async function httpAlive(url, timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/* ==================================================================== */
async function main() {
  console.log('');
  console.log(BOLD(CYAN('====================================================================')));
  console.log(BOLD(CYAN('   🚀 全能抢购工作台 · Windows 环境自检与就绪诊断工具')));
  console.log(BOLD(CYAN('====================================================================')));
  console.log('');

  /* ---------- [1/7] 系统与架构 ---------- */
  console.log(BOLD('[1/7] 检查系统与架构...'));
  const capR = await ps('(Get-CimInstance Win32_OperatingSystem).Caption', 15000);
  const caption = capR.ok && capR.out ? capR.out : `Windows（版本号 ${os.release()}）`;
  const archTxt = os.arch() === 'arm64' ? 'ARM64' : os.arch() === 'x64' ? 'x64' : os.arch();
  if (process.platform === 'win32') {
    console.log(ok(`${caption} · ${os.release()} · ${archTxt}`));
  } else {
    console.log(warn(`当前系统不是 Windows（检测到 ${process.platform}）——这份自检面向 Windows，Mac 请用 自检-macOS环境.command`));
  }

  /* ---------- [2/7] 包管理器 ---------- */
  console.log('');
  console.log(BOLD('[2/7] 检查包管理器 (winget)...'));
  const wingetWhere = await run(['where', 'winget'], 6000);
  if (wingetWhere.ok) {
    const v = await run(['winget', '--version'], 12000);
    console.log(ok(`winget 已安装：${v.ok && v.out ? v.out.split(/\r?\n/)[0] : '（版本读取超时，可忽略）'}`));
  } else {
    console.log(warn('未找到 winget（可选）。没有它也能手动安装 Node / Chrome / platform-tools。'));
    console.log(DIM('       说明：winget 只是"命令行一键装工具"的便利项，不影响本系统运行。'));
  }

  /* ---------- [3/7] Node.js ---------- */
  console.log('');
  console.log(BOLD('[3/7] 检查 Node.js 运行时...'));
  const nodeMajor = Number(String(process.version).replace(/^v/, '').split('.')[0]);
  if (nodeMajor >= 18) {
    console.log(ok(`Node.js 已就绪：${process.version}（${process.execPath}）`));
  } else {
    console.log(warn(`Node.js 版本过低：当前 ${process.version}，推荐 v18 / v20 及以上（https://nodejs.org/）`));
  }

  /* ---------- [4/7] Chrome ---------- */
  console.log('');
  console.log(BOLD('[4/7] 检查 Google Chrome 浏览器...'));
  const chromeCandidates = [
    process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  const chromePath = chromeCandidates.find((p) => fs.existsSync(p)) || null;
  if (chromePath) {
    let ver = '';
    const reg = await run(['reg', 'query', 'HKCU\\SOFTWARE\\Google\\Chrome\\BLBeacon', '/v', 'version'], 6000);
    if (reg.ok) {
      const m = reg.out.match(/version\s+REG_SZ\s+([\d.]+)/i);
      if (m) ver = m[1];
    }
    if (!ver) {
      const r = await ps(`(Get-Item '${chromePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`, 10000);
      if (r.ok && r.out) ver = r.out.split(/\r?\n/)[0];
    }
    console.log(ok(`Google Chrome 已安装${ver ? `：${ver}` : ''}`));
    console.log(DIM(`       路径: ${chromePath}`));
  } else {
    console.log(fail('未找到 Google Chrome！'));
    console.log(YELLOW('       重要说明：本项目多槽位秒杀与 CDP 协议强依赖 Chrome，Edge / Safari 不能替代。'));
    console.log(CYAN('       安装方式：访问 https://www.google.cn/chrome/ 下载安装包'));
  }

  /* ---------- [5/7] ADB ---------- */
  console.log('');
  console.log(BOLD('[5/7] 检查 Android ADB 调试工具...'));
  const adbW = await run(['where', 'adb'], 6000);
  const adbFromPath = adbW.ok ? adbW.out.split(/\r?\n/)[0].trim() : null;
  const adbPath =
    adbFromPath ||
    [
      path.join(ROOT, 'platform-tools', 'adb.exe'),
      process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
      process.env['USERPROFILE'] && path.join(process.env['USERPROFILE'], 'scoop', 'shims', 'adb.exe'),
      'C:\\platform-tools\\adb.exe',
    ]
      .filter(Boolean)
      .find((p) => fs.existsSync(p)) ||
    null;
  if (adbPath) {
    const v = await run([adbPath, 'version'], 8000);
    console.log(ok(`ADB 已就绪：${v.ok && v.out ? v.out.split(/\r?\n/)[0] : '（版本读取失败，但工具文件在）'}`));
    console.log(DIM(`       路径: ${adbPath}`));
    if (!adbFromPath) {
      console.log(warn('这个 adb 不在 PATH 里——手机中枢可能调不到它，建议把所在目录加入 PATH。'));
    }
  } else {
    console.log(fail('未找到 adb 命令！手机中枢将无法通过 USB 整备和连接设备。'));
    console.log(CYAN('       安装方式：下载 platform-tools（https://developer.android.com/tools/releases/platform-tools），'));
    console.log(CYAN('       解压到任意目录（如 C:\\platform-tools），再把该目录加入系统 PATH。'));
  }

  /* ---------- [6/7] 手机设备 ---------- */
  console.log('');
  console.log(BOLD('[6/7] 检查 Android 真机连接...'));
  const tl = await run(['tasklist'], 10000);
  if (tl.ok) {
    const low = tl.out.toLowerCase();
    const squatters = ['hisuite.exe', 'handshaker.exe', '360mobilemgr.exe'].filter((name) => low.includes(name));
    if (squatters.length) {
      console.log(warn(`检测到可能独占 USB 的助手类程序（可能挤掉 ADB）：${squatters.join(', ')}`));
      console.log(DIM('       建议先退出这些程序，再连手机调试。'));
    }
  }
  if (adbPath) {
    const devOut = await run([adbPath, 'devices', '-l'], 10000);
    if (!devOut.ok) {
      console.log(warn('adb devices 执行失败（adb 服务可能没起来，插上手机后重试一次即可）。'));
    } else {
      const lines = devOut.out.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('List of devices'));
      const unauthorized = lines.filter((l) => /\bunauthorized\b/.test(l));
      const online = lines.filter((l) => /\bdevice\b/.test(l) && !/\bunauthorized\b/.test(l));
      if (online.length) {
        const first = online[0].split(/\s+/)[0];
        console.log(ok(`成功识别已授权真机：[${first}]（状态正常）`));
      }
      if (unauthorized.length) {
        console.log(warn('发现未授权设备！请亮屏，在手机上勾选「一律允许使用这台计算机进行调试」。'));
      }
      if (!online.length && !unauthorized.length) {
        console.log(warn('当前未检测到已连接的 Android 真机。'));
        console.log(DIM('       排查指引：'));
        console.log(DIM('       1. 手机是否已插上 USB 数据线？（要数据线，不是纯充电线）'));
        console.log(DIM('       2. 手机是否已在开发者选项中开启「USB 调试」？'));
        console.log(DIM('       3. 手机上是否弹出「允许 USB 调试吗？」，并点了允许？'));
        console.log(DIM('       4. 若电脑认不到设备，可能需要装手机厂商的 USB 驱动。'));
      }
    }
  } else {
    console.log(DIM('  （因缺少 adb，跳过设备探测）'));
  }

  /* ---------- [7/7] 依赖与端口 ---------- */
  console.log('');
  console.log(BOLD('[7/7] 检查项目依赖与端口状态...'));
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.log(ok('项目依赖包 (node_modules) 已就绪'));
  } else {
    console.log(fail('缺少 node_modules！项目尚未安装依赖。'));
    console.log(CYAN('       修复：在本目录运行  npm install'));
  }
  const portInfo = [
    { port: 3100, label: '桥接服务' },
    { port: 3120, label: '手机中枢' },
  ];
  for (const { port, label } of portInfo) {
    const pids = await listeningPids(port);
    if (pids.size) {
      const healthy = await httpAlive(`http://127.0.0.1:${port}/health`);
      console.log(`  ${BLUE('ℹ')} 端口 ${port}（${label}）正在运行（PID ${[...pids].join(', ')}${healthy ? '，健康检查通过' : '，健康检查未通过'}）`);
    } else {
      console.log(ok(`端口 ${port}（${label}）空闲可用`));
    }
  }
  const staleHubPid = path.join(ROOT, 'data', 'grab', 'device-hub.pid');
  if (fs.existsSync(staleHubPid) && !(await listeningPids(3120)).size) {
    console.log(DIM('  （发现残留 device-hub.pid，但中枢未运行；启动/停止脚本会自动处理，无需手删）'));
  }

  /* ---------- 结论 ---------- */
  console.log('');
  console.log(BOLD(CYAN('====================================================================')));
  console.log(BOLD('                       自检诊断结论与建议'));
  console.log(BOLD(CYAN('====================================================================')));

  if (ERR_COUNT === 0 && WARN_COUNT === 0) {
    console.log(GREEN(BOLD('🎉 完美！当前 Windows 运行环境 100% 具备抢购与自动化运行条件！')));
    console.log('');
    console.log(BOLD('  快速启动操作：'));
    console.log(`  · 启停服务（双击）      ：${CYAN('服务启停.bat')} → 按 1 启动全部`);
    console.log(`  · 中枢控制台            ：${BLUE('http://localhost:3120')}`);
    console.log(`  · 手机一键整备（双击）  ：${CYAN('tools\\mobile\\prepare-device.bat')}`);
  } else if (ERR_COUNT === 0) {
    console.log(YELLOW(BOLD(`⚠ 基础核心环境正常，但有 ${WARN_COUNT} 项警示（大多为手机未插 / 未授权 / 缺少可选工具）：`)));
    console.log('  若已安装 Chrome 与 Node，插上手机并开启 USB 调试后即可正常运行！');
    console.log(`  双击运行 ${CYAN('tools\\mobile\\prepare-device.bat')} 可一键整备手机。`);
  } else {
    console.log(RED(BOLD(`✘ 检测到 ${ERR_COUNT} 项缺失！请按下面的指引补全环境：`)));
    console.log('');
    console.log(BOLD('  针对性修复建议：'));
    if (!chromePath) console.log('  · 安装 Google Chrome：https://www.google.cn/chrome/');
    if (!adbPath) {
      console.log('  · 安装 ADB：下载 platform-tools（https://developer.android.com/tools/releases/platform-tools），');
      console.log('    解压到任意目录（如 C:\\platform-tools），再把该目录加入系统 PATH。');
    }
    if (nodeMajor < 18) console.log('  · 升级 Node.js（18+）：https://nodejs.org/');
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) console.log('  · 安装项目依赖：npm install');
    if (wingetWhere.ok) {
      console.log(DIM('    （本机有 winget，也可以尝试： winget install OpenJS.NodeJS.LTS / Google.Chrome / Google.PlatformTools ）'));
    }
  }
  console.log(BOLD(CYAN('====================================================================')));
  console.log('');

  process.exitCode = ERR_COUNT > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error('自检脚本异常：', (e && e.stack) || e);
  process.exitCode = 1;
});
