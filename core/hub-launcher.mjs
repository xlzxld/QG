/**
 * 设备中枢 (device-hub :3120) 生命周期工具
 * =====================================================================
 * 给「服务启停」菜单当内核用，也可以手动跑：
 *
 *   node core/hub-launcher.mjs --start     前台启动中枢（日志显示在本窗口）
 *   node core/hub-launcher.mjs --start-bg  后台启动中枢（日志写 data/grab/device-hub.log）
 *   node core/hub-launcher.mjs --stop      停止中枢（兼容 PID 文件丢失/过期等残留状态）
 *   node core/hub-launcher.mjs --restart   重启中枢（先停再后台起）
 *   node core/hub-launcher.mjs --status    查看中枢状态
 *
 * 为什么不在 .bat 里直接杀进程：
 *   .bat 里没有可靠的「按命令行找进程」能力（PowerShell 那层转义极易写错，
 *   历史上还真踩过：写错之后"看着执行了、其实什么都没找到"）。
 *   这里用 node 统一处理，逻辑与 core/grab-launcher.mjs 的 --stop 保持同款：
 *   优先让中枢自报 PID（/health），其次按端口嗅探，最后查 PID 文件并核对身份，
 *   不会误杀被回收的 PID。
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRAB_DIR = path.join(ROOT, 'data', 'grab');
const HUB_SCRIPT = path.join(ROOT, 'core', 'device-hub.mjs');
const PID_PATH = path.join(GRAB_DIR, 'device-hub.pid');
const LOG_PATH = path.join(GRAB_DIR, 'device-hub.log');
const PORT = Number(process.env.DEVICE_HUB_PORT || 3120);
const HUB_URL = `http://127.0.0.1:${PORT}`;

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

function line(ch = '─', n = 60) {
  console.log(C.dim + ch.repeat(n) + C.reset);
}
function title(t) {
  line('═');
  console.log(C.bold + C.cyan + '  ' + t + C.reset);
  line('═');
}

/* ============================ 状态探测 ============================ */

async function hubAlive(timeoutMs = 1200) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${HUB_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    if (!fs.existsSync(PID_PATH)) return null;
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearPidFile() {
  try {
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  } catch {
    /* 忽略 */
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但不属于本用户
  }
}

/** 异步执行命令并收集 stdout（用异步 spawn，不卡事件循环）。失败/超时返回空串。 */
function runCapture(cmd, args, timeoutMs = 8000) {
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

/** 返回监听指定端口的 PID 集合（跨平台）。失败时返回空集合（不谎报）。
 *  ★ macOS/Linux 必须加 `-sTCP:LISTEN`：裸 `lsof -ti :port` 会把**持有该端口连接**的进程
 *    （手机长轮询的 ESTABLISHED、adb reverse 的出站连接等）也当"占用者"——
 *    2026-10-10 实证：中枢已停但手机连接未断，导致启动永远误报"端口被占"。 */
async function listeningPids(port) {
  const pids = new Set();
  if (process.platform === 'win32') {
    const out = await runCapture('netstat', ['-ano', '-p', 'TCP']);
    for (const s of out.split(/\r?\n/)) {
      const m = s.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
  } else {
    const out = await runCapture('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t']);
    for (const pid of out.trim().split(/\s+/)) {
      if (pid && !isNaN(Number(pid))) pids.add(pid);
    }
  }
  return pids;
}

async function waitHubDown(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await hubAlive(700))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !(await hubAlive(700));
}

/** 问 /health 要中枢自报的 PID（能应答 3120 的就是中枢本尊）。拿不到返回 null。 */
async function healthPid() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${HUB_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const pid = Number(j?.pid);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 判断某个 PID 的命令行是否就是 device-hub（PID 文件兜底前的身份核对）。无法核对返回 null。 */
async function looksLikeHub(pid) {
  if (process.platform === 'win32') {
    const out = await runCapture(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      8000,
    );
    if (!out) return null;
    return /device-hub\.mjs/i.test(out);
  }
  const out = await runCapture('ps', ['-p', String(pid), '-o', 'command='], 5000);
  if (!out) return null;
  return /device-hub\.mjs/i.test(out);
}

/** 把"确定是中枢"的进程全部结束（TERM → 等待 → KILL）。返回是否全部结束。 */
async function killHubs(pids) {
  for (const p of pids) {
    try {
      process.kill(Number(p), 'SIGTERM');
      console.log(`${C.yellow}·${C.reset} 结束中枢进程 PID ${p}…`);
    } catch (e) {
      console.log(`${C.dim}  （PID ${p} 信号发送失败：${e.code || e.message}）${C.reset}`);
    }
  }
  // 等 SIGTERM 生效（中枢会在 1.2s 内强制退出，见 device-hub 的信号处理）
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const rest = [];
    for (const p of pids) if (pidAlive(Number(p))) rest.push(p);
    if (!rest.length) return true;
  }
  for (const p of pids) {
    try {
      process.kill(Number(p), 'SIGKILL');
      console.log(`${C.yellow}·${C.reset} 强杀 PID ${p}…`);
    } catch {
      /* 可能已退出 */
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  return [...pids].every((p) => !pidAlive(Number(p)));
}

/* ============================ 启动 ============================ */

/** 启动前的端口自愈: 占用者若全部核对为 device-hub 残留 → 自动清掉再启动; 有外人 → 报错 */
async function clearPortForStart() {
  const busy = await listeningPids(PORT);
  if (!busy.size) return true;
  const targets = new Set();
  for (const l of busy) {
    if (await looksLikeHub(l)) targets.add(String(l));
  }
  if (targets.size && targets.size === busy.size) {
    console.log(`${C.yellow}·${C.reset} 端口 ${PORT} 被残留的中枢进程占用（PID ${[...targets].join(', ')}）→ 自动清理…`);
    if ((await killHubs(targets)) && !(await listeningPids(PORT)).size) return true;
    console.log(`${C.red}✘ 清理失败，无法启动。${C.reset}`);
    return false;
  }
  console.log(`${C.red}✘ 端口 ${PORT} 已被其它进程占用${C.reset}（PID ${[...busy].join(', ')}），中枢无法启动。`);
  console.log(`  ${C.dim}处理：确认占用者身份后手动处理（它不是本中枢的残留进程）。${C.reset}`);
  return false;
}

async function startHub() {
  title('启动设备中枢 (:3120)');

  if (await hubAlive()) {
    const pid = readPid();
    console.log(`${C.green}✔${C.reset} 设备中枢已经在运行${pid ? `（PID ${pid}）` : ''}，不重复启动。`);
    console.log(`  ${C.dim}控制台：${C.reset}http://localhost:${PORT}`);
    return true;
  }

  if (!(await clearPortForStart())) return false;

  if (!fs.existsSync(HUB_SCRIPT)) {
    console.log(`${C.red}✘ 找不到中枢脚本：${HUB_SCRIPT}${C.reset}`);
    return false;
  }

  console.log(`${C.dim}正在前台启动，中枢日志会直接显示在本窗口。${C.reset}`);
  console.log(`${C.dim}停止方式：本窗口按 Ctrl+C、关闭本窗口，或从「服务启停」菜单停止。${C.reset}`);
  console.log('');

  const child = spawn(process.execPath, [HUB_SCRIPT], { cwd: ROOT, stdio: 'inherit', windowsHide: true });

  let exitInfo = null;
  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
    resolveExit();
  });
  child.on('error', (err) => {
    exitInfo = { code: `spawn 失败（${err.code || err.message}）`, signal: null };
    resolveExit();
  });

  // 等它真的就绪（最多 15 秒）；期间如果进程先退了，就是启动失败
  for (let i = 0; i < 30; i++) {
    if (exitInfo) break;
    await new Promise((r) => setTimeout(r, 500));
    if (await hubAlive()) break;
  }

  if (exitInfo) {
    console.log('');
    console.log(`${C.red}✘ 中枢启动失败（退出码 ${exitInfo.code ?? exitInfo.signal}）${C.reset}。`);
    console.log(`  ${C.dim}常见原因：端口被占 / node 版本过旧 / 依赖缺失（先跑 npm install）。${C.reset}`);
    return false;
  }

  if (await hubAlive()) {
    console.log('');
    console.log(`${C.green}✔ 设备中枢已就绪${C.reset} —— 电脑浏览器打开：${C.cyan}http://localhost:${PORT}${C.reset}`);
    console.log(`${C.dim}（本窗口保持开着即可；关掉窗口前建议先从「服务启停」菜单停止）${C.reset}`);
  } else {
    console.log(`${C.dim}（等了 15 秒健康检查还没响应，继续观察下面的输出……）${C.reset}`);
  }

  // 前台保持：等中枢进程退出
  if (!exitInfo) await exitPromise;
  console.log('');
  console.log(`${C.yellow}·${C.reset} 设备中枢已退出（退出码 ${exitInfo?.code ?? exitInfo?.signal}）。`);
  return true;
}

/* ============================ 后台启动 ============================ */

async function startHubBackground() {
  title('启动设备中枢 (:3120) · 后台运行');

  if (await hubAlive()) {
    const pid = readPid();
    console.log(`${C.green}✔${C.reset} 设备中枢已经在运行${pid ? `（PID ${pid}）` : ''}，不重复启动。`);
    console.log(`  ${C.dim}控制台：${C.reset}http://localhost:${PORT}`);
    return true;
  }

  if (!(await clearPortForStart())) return false;

  if (!fs.existsSync(HUB_SCRIPT)) {
    console.log(`${C.red}✘ 找不到中枢脚本：${HUB_SCRIPT}${C.reset}`);
    return false;
  }

  const out = fs.openSync(LOG_PATH, 'a');
  let child;
  try {
    child = spawn(process.execPath, [HUB_SCRIPT], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
  } catch (e) {
    console.log(`${C.red}✘ 后台启动失败：${e.code || e.message}${C.reset}`);
    return false;
  }
  child.unref();
  try {
    fs.closeSync(out);
  } catch {
    /* 忽略 */
  }

  console.log(`${C.dim}已转入后台启动，日志写入：${path.relative(ROOT, LOG_PATH)}${C.reset}`);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await hubAlive()) break;
  }

  if (await hubAlive()) {
    const pid = await healthPid();
    console.log(`${C.green}✔ 设备中枢已后台启动${C.reset}${pid ? `（PID ${pid}）` : ''}`);
    console.log(`  ${C.dim}控制台：${C.reset}http://localhost:${PORT}`);
    console.log(`  ${C.dim}管理入口：${C.reset}双击「服务启停」→ 手机中枢（停止 / 看日志 / 重启）`);
    return true;
  }

  console.log(`${C.red}✘ 后台启动失败：15 秒内未见健康检查响应。${C.reset}`);
  console.log(`  ${C.dim}请查看日志尾部排查：${path.relative(ROOT, LOG_PATH)}${C.reset}`);
  return false;
}

async function restartHub() {
  const ok = await stopHub();
  if (!ok) {
    console.log(`${C.red}✘ 重启中止：旧进程没停掉，直接起新的会因端口被占而失败。${C.reset}`);
    return false;
  }
  return startHubBackground();
}

/* ============================ 停止 ============================ */

async function stopHub() {
  title('停止设备中枢 (:3120)');

  const alive = await hubAlive();

  if (!alive) {
    const stale = readPid();
    clearPidFile();
    // ★ 终态以"端口 LISTEN"为准：/health 无响应但仍有监听 = 半死状态, 也要清
    const listeners = await listeningPids(PORT);
    if (listeners.size) {
      console.log(`${C.yellow}·${C.reset} /health 无响应, 但端口仍有 ${listeners.size} 个监听者, 逐一核对并清理…`);
      return await stopByListeners(listeners);
    }
    console.log(`${C.dim}设备中枢本来就没在运行。${C.reset}`);
    if (stale) console.log(`${C.dim}（已顺手清理残留的 device-hub.pid，写的是 PID ${stale}）${C.reset}`);
    return true;
  }

  // 收集全部目标：① /health 自报 ② 端口 LISTEN 全集 ③ PID 文件（需身份核对）
  const targets = new Set();
  const hp = await healthPid();
  if (hp) targets.add(String(hp));
  for (const l of await listeningPids(PORT)) targets.add(String(l));
  if (!targets.size) {
    const filePid = readPid();
    if (filePid && pidAlive(filePid)) {
      const match = await looksLikeHub(filePid);
      if (match === true) targets.add(String(filePid));
      else {
        console.log(
          `${C.yellow}·${C.reset} 发现存活进程 PID ${filePid}（来自 PID 文件），但${match === false ? '它不是 device-hub' : '无法核对它的身份'} → 不贸然结束它。`,
        );
      }
    }
  }

  clearPidFile();

  if (!targets.size) {
    console.log(`${C.red}✘ 停止失败：找不到中枢进程（3120 有人在听，但定位不到它的 PID）${C.reset}`);
    console.log(`  ${C.dim}请手动关闭那个运行中的中枢窗口（或在窗口里按 Ctrl+C）后重试。${C.reset}`);
    return false;
  }

  const ok = await killHubs(targets);
  const stillUp = await hubAlive(900) || (await listeningPids(PORT)).size > 0;
  if (!ok || stillUp) {
    console.log(`${C.red}✘ 停止失败：3120 仍被占用${C.reset}`);
    console.log(`  ${C.dim}请手动关闭那个运行中的中枢窗口（或在窗口里按 Ctrl+C）后重试。${C.reset}`);
    return false;
  }
  console.log(`${C.green}✔${C.reset} 设备中枢已停止（PID ${[...targets].join(', ')}）。`);
  return true;
}

/** 按端口监听者清理（/health 已无响应的"半死"场景）：只杀核对过身份的 device-hub */
async function stopByListeners(listeners) {
  const targets = new Set();
  for (const l of listeners) {
    const match = await looksLikeHub(l);
    if (match === true) targets.add(String(l));
    else console.log(`${C.dim}  （PID ${l} ${match === false ? '不是 device-hub，跳过' : '身份无法核对，跳过'}）${C.reset}`);
  }
  if (!targets.size) {
    console.log(`${C.red}✘ 清理失败：监听者中没有 device-hub，需手动处理。${C.reset}`);
    return false;
  }
  const ok = await killHubs(targets);
  const stillUp = (await listeningPids(PORT)).size > 0;
  if (!ok || stillUp) {
    console.log(`${C.red}✘ 清理失败：3120 仍被占用${C.reset}`);
    return false;
  }
  console.log(`${C.green}✔${C.reset} 已清理残留中枢（PID ${[...targets].join(', ')}）。`);
  return true;
}

/* ============================ 状态 ============================ */

async function statusHub() {
  title('设备中枢状态');

  const alive = await hubAlive();
  const pid = readPid();

  if (alive) {
    let upTxt = '';
    try {
      const j = await (await fetch(`${HUB_URL}/health`)).json();
      if (j.uptimeSec != null) upTxt = `，已运行 ${j.uptimeSec} 秒`;
    } catch {
      /* 忽略 */
    }
    console.log(`${C.green}✔${C.reset} 设备中枢在运行（127.0.0.1:${PORT}${pid ? `，PID ${pid}` : ''}${upTxt}）`);
    console.log(`  ${C.dim}控制台：${C.reset}http://localhost:${PORT}`);
    process.exitCode = 0;
    return;
  }

  console.log(`${C.yellow}·${C.reset} 设备中枢未运行（127.0.0.1:${PORT} 空闲）`);
  if (pid) {
    console.log(`${C.dim}  （发现残留 device-hub.pid：${pid}；下次启动/停止时会自动清理）${C.reset}`);
  }
  process.exitCode = 1;
}

/* ============================ 主入口 ============================ */

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--start')) {
    process.exitCode = (await startHub()) ? 0 : 1;
    return;
  }
  if (argv.includes('--start-bg')) {
    process.exitCode = (await startHubBackground()) ? 0 : 1;
    return;
  }
  if (argv.includes('--restart')) {
    process.exitCode = (await restartHub()) ? 0 : 1;
    return;
  }
  if (argv.includes('--stop')) {
    process.exitCode = (await stopHub()) ? 0 : 1;
    return;
  }
  if (argv.includes('--status')) {
    await statusHub();
    return;
  }

  console.log('用法：node core/hub-launcher.mjs --start | --start-bg | --stop | --restart | --status');
  process.exitCode = 2;
}

main().catch((e) => {
  console.error(`\n${C.red}hub-launcher 异常：${e.message}${C.reset}`);
  console.error(C.dim + (e.stack || '') + C.reset);
  process.exitCode = 1;
});
