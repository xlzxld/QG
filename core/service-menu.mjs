/**
 * 抢购服务启停台（统一入口 —— 双击 服务启停.bat / 服务启停.command）
 * =====================================================================
 * 管理两个后台服务：
 *   桥接服务  :3100   华为抢购后台（常驻；逻辑在 core/grab-launcher.mjs）
 *   手机中枢  :3120   手机抢购设备中枢（后台运行；逻辑在 core/hub-launcher.mjs）
 *                    日志文件：data/grab/device-hub.log
 *   （另有 登录保活守护 :3101，由桥接自动拉起、平时无需手动管；「停止全部」会把
 *     它一并停掉——否则服务都停了它还在给窗口续命，2026-10-09 起）
 *
 * 用法：
 *   node core/service-menu.mjs             → 交互菜单
 *   node core/service-menu.mjs status      → 只看状态（脚本/自动化可用）
 *   node core/service-menu.mjs start-all | stop-all | restart-all
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBrowserUrl } from './grab-launcher.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRAB_DIR = path.join(ROOT, 'data', 'grab');
const BRIDGE_URL = `http://127.0.0.1:${Number(process.env.GRAB_BRIDGE_PORT || 3100)}`;
const HUB_URL = `http://127.0.0.1:${Number(process.env.DEVICE_HUB_PORT || 3120)}`;
const KA_CTL_URL = `http://127.0.0.1:${Number(process.env.KEEPALIVE_CTL_PORT || 3101)}`;
const GRAB_LAUNCHER = path.join(ROOT, 'core', 'grab-launcher.mjs');
const HUB_LAUNCHER = path.join(ROOT, 'core', 'hub-launcher.mjs');
const HUB_LOG = path.join(GRAB_DIR, 'device-hub.log');
const BRIDGE_PID = path.join(GRAB_DIR, 'bridge.pid');
const HUB_PID = path.join(GRAB_DIR, 'device-hub.pid');

/* ============================ 输出工具 ============================ */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function line(ch = '─', n = 64) {
  console.log(C.dim + ch.repeat(n) + C.reset);
}
function title(t) {
  line('═');
  console.log(C.bold + C.cyan + '  ' + t + C.reset);
  line('═');
}

/* ============================ 状态探测 ============================ */

async function httpJson(url, timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json().catch(() => ({}));
  } catch {
    return null;
  }
}

function readPidFile(p) {
  try {
    const pid = Number(fs.readFileSync(p, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function bridgeStatus() {
  const j = await httpJson(`${BRIDGE_URL}/health`);
  return { running: !!j, pid: (j && j.pid) || readPidFile(BRIDGE_PID) || null };
}

async function hubStatus() {
  const j = await httpJson(`${HUB_URL}/health`);
  return { running: !!j, pid: (j && j.pid) || readPidFile(HUB_PID) || null, uptimeSec: (j && j.uptimeSec) ?? null };
}

function fmtDur(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

async function printStatus() {
  const [b, h] = await Promise.all([bridgeStatus(), hubStatus()]);
  const dot = (on) => (on ? `${C.green}● 运行中${C.reset}` : `${C.dim}○ 未运行${C.reset}`);
  console.log(
    `  ${C.bold}桥接服务${C.reset} :3100　${dot(b.running)}${b.running && b.pid ? ` ${C.dim}（PID ${b.pid}）${C.reset}` : ''}`,
  );
  console.log(
    `  ${C.bold}手机中枢${C.reset} :3120　${dot(h.running)}${
      h.running && h.pid ? ` ${C.dim}（PID ${h.pid}${h.uptimeSec != null ? ` · 已跑 ${fmtDur(h.uptimeSec)}` : ''}）${C.reset}` : ''
    }`,
  );
  return { b, h };
}

/* ============================ 执行子工具 ============================ */

function runTool(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(-1));
  });
}

/* ============================ 组合动作 ============================ */

async function actionStartAll() {
  console.log(`${C.cyan}▶${C.reset} 启动桥接服务…`);
  await runTool(GRAB_LAUNCHER, ['--start']);
  console.log('');
  console.log(`${C.cyan}▶${C.reset} 启动手机中枢（后台）…`);
  await runTool(HUB_LAUNCHER, ['--start-bg']);
}

/** 停掉登录保活守护（桥接还在就优先走桥接接口，它会把「测试轮」也一并停；否则直接敲守护控制端口） */
async function stopKeepalive() {
  const viaBridge = await fetch(`${BRIDGE_URL}/api/keepalive/stop`, { method: 'POST', signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (viaBridge && viaBridge.ok) return viaBridge.note || '已处理';
  const viaCtl = await fetch(`${KA_CTL_URL}/stop`, { method: 'POST', signal: AbortSignal.timeout(1200) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (viaCtl && viaCtl.ok) return '已停止（控制端口直连）';
  return null; // 没在跑
}

async function actionStopAll() {
  const kaNote = await stopKeepalive();
  console.log(`${C.cyan}▶${C.reset} 停止登录保活守护…${kaNote ? ` ${C.dim}${kaNote}${C.reset}` : ` ${C.dim}（本来就没在跑）${C.reset}`}`);
  console.log('');
  console.log(`${C.cyan}▶${C.reset} 停止手机中枢…`);
  await runTool(HUB_LAUNCHER, ['--stop']);
  console.log('');
  console.log(`${C.cyan}▶${C.reset} 停止桥接服务…`);
  await runTool(GRAB_LAUNCHER, ['--stop']);
}

async function actionRestartAll() {
  console.log(`${C.cyan}▶${C.reset} 重启桥接服务…`);
  await runTool(GRAB_LAUNCHER, ['--restart']);
  console.log('');
  console.log(`${C.cyan}▶${C.reset} 重启手机中枢…`);
  await runTool(HUB_LAUNCHER, ['--restart']);
}

async function runSelfCheck() {
  console.log('');
  if (process.platform === 'win32') {
    await runTool(path.join(ROOT, 'check-windows-env.mjs'));
  } else {
    await new Promise((resolve) => {
      const c = spawn('bash', [path.join(ROOT, 'check-macos-env.sh')], { cwd: ROOT, stdio: 'inherit' });
      c.on('exit', resolve);
      c.on('error', resolve);
    });
  }
}

function showHubLog() {
  console.log('');
  try {
    const txt = fs.readFileSync(HUB_LOG, 'utf8');
    const lines = txt.split(/\r?\n/).filter((l) => l.trim());
    const tail = lines.slice(-40);
    if (!tail.length) {
      console.log(`${C.dim}  日志文件还是空的。${C.reset}`);
      return;
    }
    console.log(`${C.dim}—— 手机中枢日志（最近 ${tail.length} 行）｜ ${path.relative(ROOT, HUB_LOG)} ——${C.reset}`);
    console.log('');
    for (const l of tail) console.log('  ' + l);
  } catch {
    console.log(`${C.dim}  还没有日志文件（中枢尚未以后台方式启动过）。${C.reset}`);
    console.log(`${C.dim}  文件位置：${path.relative(ROOT, HUB_LOG)}${C.reset}`);
  }
}

/* ============================ 交互基础 ============================ */

/**
 * 输入一律走「行队列」：粘贴 / 管道批量输入时按顺序逐条消费，
 * 不会出现"第一条之后的输入被 readline 静默丢掉"的问题。
 */
let rl = null;
let closed = false;
const lineQueue = [];
let pending = null;

function getRL() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      const val = String(line || '').trim();
      if (pending) {
        const p = pending;
        pending = null;
        p(val);
      } else {
        lineQueue.push(val);
      }
    });
    rl.on('close', () => {
      closed = true;
      const p = pending;
      pending = null;
      if (p) p('');
    });
  }
  return rl;
}

function ask(q) {
  return new Promise((resolve) => {
    getRL();
    process.stdout.write(q);
    // 先消费已排队的输入（粘贴/管道批量输入），队列空了才处理"输入流已关闭"
    if (lineQueue.length) return resolve(lineQueue.shift());
    if (closed) return resolve('');
    pending = resolve;
  });
}

function closeRL() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

const PROMPT = `  ${C.bold}请输入编号并回车${C.reset}: `;
const BACK = `  ${C.dim}按回车返回菜单…${C.reset}`;

/* ============================ 子菜单 ============================ */

async function bridgeSubmenu() {
  for (;;) {
    console.log('');
    title('桥接服务 :3100（华为抢购后台）');
    const b = await bridgeStatus();
    console.log(`  当前状态：${b.running ? `${C.green}运行中${C.reset}${b.pid ? ` ${C.dim}（PID ${b.pid}）${C.reset}` : ''}` : `${C.dim}未运行${C.reset}`}`);
    console.log('');
    console.log('   1) 启动　　2) 停止　　3) 重启　　4) 打开控制台（浏览器）　　0) 返回');
    console.log('');
    const ans = (await ask(PROMPT)).toUpperCase();
    if (closed && !ans) return;
    if (ans === '0' || ans === 'Q') return;
    if (ans === '1') {
      await runTool(GRAB_LAUNCHER, ['--start']);
      await ask(BACK);
    } else if (ans === '2') {
      await runTool(GRAB_LAUNCHER, ['--stop']);
      await ask(BACK);
    } else if (ans === '3') {
      await runTool(GRAB_LAUNCHER, ['--restart']);
      await ask(BACK);
    } else if (ans === '4') {
      openBrowserUrl(BRIDGE_URL);
      console.log(`${C.dim}  已尝试打开浏览器：${BRIDGE_URL}${C.reset}`);
      await ask(BACK);
    }
  }
}

async function hubSubmenu() {
  for (;;) {
    console.log('');
    title('手机中枢 :3120（手机抢购）');
    const h = await hubStatus();
    console.log(
      `  当前状态：${h.running ? `${C.green}运行中${C.reset}${h.pid ? ` ${C.dim}（PID ${h.pid}${h.uptimeSec != null ? ` · 已跑 ${fmtDur(h.uptimeSec)}` : ''}）${C.reset}` : ''}` : `${C.dim}未运行${C.reset}`}`,
    );
    console.log('');
    console.log('   1) 启动（后台）　2) 停止　3) 重启　4) 看日志　5) 打开中枢控制台　0) 返回');
    console.log('');
    const ans = (await ask(PROMPT)).toUpperCase();
    if (closed && !ans) return;
    if (ans === '0' || ans === 'Q') return;
    if (ans === '1') {
      await runTool(HUB_LAUNCHER, ['--start-bg']);
      await ask(BACK);
    } else if (ans === '2') {
      await runTool(HUB_LAUNCHER, ['--stop']);
      await ask(BACK);
    } else if (ans === '3') {
      await runTool(HUB_LAUNCHER, ['--restart']);
      await ask(BACK);
    } else if (ans === '4') {
      showHubLog();
      await ask(BACK);
    } else if (ans === '5') {
      openBrowserUrl(HUB_URL);
      console.log(`${C.dim}  已尝试打开浏览器：${HUB_URL}${C.reset}`);
      await ask(BACK);
    }
  }
}

/* ============================ 主菜单 ============================ */

async function mainMenu() {
  for (;;) {
    console.log('');
    title('抢购服务启停台');
    console.log('');
    await printStatus();
    console.log('');
    line();
    console.log('   1) 启动全部　（桥接 + 手机中枢）');
    console.log('   2) 停止全部');
    console.log('   3) 重启全部');
    console.log('   4) 刷新状态');
    line();
    console.log('   5) 桥接服务…　（单项管理）');
    console.log('   6) 手机中枢…　（单项管理 / 看日志）');
    line();
    console.log('   7) 打开抢购控制台（浏览器）');
    console.log('   8) 环境自检');
    console.log('   9) 打开完整启动器（爬虫 / 采集）');
    console.log('   0) 退出');
    console.log('');
    const ans = (await ask(PROMPT)).toUpperCase();
    if (closed && !ans) break;
    if (ans === '0' || ans === 'Q') break;

    if (ans === '1') {
      await actionStartAll();
      await ask(BACK);
    } else if (ans === '2') {
      await actionStopAll();
      await ask(BACK);
    } else if (ans === '3') {
      await actionRestartAll();
      await ask(BACK);
    } else if (ans === '4') {
      // 直接回到循环顶部重新渲染状态
    } else if (ans === '5') {
      await bridgeSubmenu();
    } else if (ans === '6') {
      await hubSubmenu();
    } else if (ans === '7') {
      openBrowserUrl(BRIDGE_URL);
      console.log(`${C.dim}  已尝试打开浏览器：${BRIDGE_URL}${C.reset}`);
      await ask(BACK);
    } else if (ans === '8') {
      await runSelfCheck();
      await ask(BACK);
    } else if (ans === '9') {
      console.log(`${C.dim}  进入完整启动器；想回到本菜单，在启动器里按 Q 退出即可。${C.reset}`);
      await runTool(GRAB_LAUNCHER, []);
      await ask(BACK);
    }
  }
  closeRL();
  console.log(`\n  ${C.dim}已退出。服务状态不受影响（后台服务继续运行）。${C.reset}\n`);
}

/* ============================ 主入口 ============================ */

async function main() {
  const arg = String(process.argv[2] || '').toLowerCase();

  if (arg === 'status') {
    title('服务状态');
    const { b, h } = await printStatus();
    process.exitCode = b.running && h.running ? 0 : 1;
    return;
  }
  if (arg === 'start-all') {
    title('启动全部服务');
    await actionStartAll();
    console.log('');
    await printStatus();
    return;
  }
  if (arg === 'stop-all') {
    title('停止全部服务');
    await actionStopAll();
    console.log('');
    await printStatus();
    return;
  }
  if (arg === 'restart-all') {
    title('重启全部服务');
    await actionRestartAll();
    console.log('');
    await printStatus();
    return;
  }
  if (arg) {
    console.log(`未知参数：${arg}`);
    console.log('可用：status / start-all / stop-all / restart-all（不带参数 = 交互菜单）');
    process.exitCode = 2;
    return;
  }

  await mainMenu();
}

main().catch((e) => {
  console.error(`\n${C.red}服务启停台异常：${e.message}${C.reset}`);
  console.error(C.dim + (e.stack || '') + C.reset);
  process.exitCode = 1;
});
