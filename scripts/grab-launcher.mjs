/**
 * 一键启动器（交互菜单）
 * =====================================================================
 * 用法：双击 启动.bat，或在终端运行 node scripts/grab-launcher.mjs
 *
 * 功能：
 *   1. 检查桥接服务是否在跑；没跑就自动拉起
 *   2. 列出所有爬虫（来自 data/grab/crawlers.json，加新平台会自动出现）
 *   3. 输入编号 → 回车 → 手动启动该爬虫
 *   4. 可选二级菜单选择运行方式（完整采集 / 只刷新 / 只发现 / 显示窗口）
 *   5. 跑完打印结果，回到主菜单
 *
 * 说明：手动启动过的爬虫，当天不会再被自动调度启动（见 grab-bridge.mjs）。
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRAB_DIR = path.join(ROOT, 'data', 'grab');
const BRIDGE_URL = process.env.GRAB_BRIDGE_URL || 'http://127.0.0.1:3100';
const BRIDGE_SCRIPT = path.join(ROOT, 'scripts', 'grab-bridge.mjs');

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

function line(ch = '─', n = 66) {
  console.log(C.dim + ch.repeat(n) + C.reset);
}
function title(t) {
  line('═');
  console.log(C.bold + C.cyan + '  ' + t + C.reset);
  line('═');
}

/* ============================ 桥接服务 ============================ */

async function bridgeAlive(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${BRIDGE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

let bridgeProc = null;

async function ensureBridge() {
  if (await bridgeAlive()) {
    console.log(`${C.green}✔${C.reset} 桥接服务已在运行 ${C.dim}${BRIDGE_URL}${C.reset}`);
    return true;
  }

  console.log(`${C.yellow}·${C.reset} 桥接服务未运行，正在自动启动…`);
  if (!fs.existsSync(BRIDGE_SCRIPT)) {
    console.log(`${C.red}✘ 找不到桥接服务脚本：${BRIDGE_SCRIPT}${C.reset}`);
    return false;
  }

  bridgeProc = spawn(process.execPath, [BRIDGE_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ||
        path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    },
    detached: true,
    stdio: 'ignore',
    // ★ Windows：detached 的桥接进程不继承本窗口的控制台，
    //   不加这个标志它自己（以及它后来 spawn 的子进程）会弹黑窗口。
    windowsHide: true,
  });
  bridgeProc.unref();

  // 等它起来
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await bridgeAlive()) {
      console.log(`${C.green}✔${C.reset} 桥接服务已启动 ${C.dim}${BRIDGE_URL}${C.reset}`);
      return true;
    }
  }
  console.log(`${C.red}✘ 桥接服务启动超时。请手动运行：node scripts/grab-bridge.mjs${C.reset}`);
  return false;
}

async function apiGet(p) {
  const r = await fetch(`${BRIDGE_URL}${p}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ============================ 服务的停止 / 重启 ============================ */

const PID_PATH = path.join(GRAB_DIR, 'bridge.pid');

/** 读桥接自己写的 PID 文件（新版服务启动时会写）。读不到返回 null。 */
function readBridgePid() {
  try {
    if (!fs.existsSync(PID_PATH)) return null;
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8').trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/**
 * 停止桥接服务。三条路依次试，**任何一条没成功都不会谎报成功**：
 *   1. POST /api/shutdown —— 优雅退出（新版服务）；
 *   2. PID 文件 + process.kill —— 零依赖（跑的是新版服务但接口被占住时）；
 *   3. 端口 → PID → taskkill —— 兜底，专治"跑着的是没写 PID 文件的旧版服务"。
 *      （在受限环境里起外部命令会失败，所以它只是兜底，不指望它。）
 */
async function stopBridge() {
  if (!(await bridgeAlive())) {
    console.log(`${C.dim}桥接服务本来就没在运行${C.reset}`);
    return true;
  }
  const oldPid = readBridgePid();

  // 1) 优雅停止
  const r = await apiPost('/api/shutdown').catch(() => null);
  if (r && r.status === 200) {
    console.log(`${C.yellow}·${C.reset} 已发送停止请求，等待退出…`);
    if (await waitBridgeDown(6000)) { console.log(`${C.green}✔${C.reset} 桥接服务已停止`); return true; }
  }

  // 2) PID 文件 + process.kill（不依赖任何外部命令）
  const pid = oldPid ?? readBridgePid();
  if (pid) {
    console.log(`${C.yellow}·${C.reset} 按 PID ${pid} 结束进程…`);
    try { process.kill(pid); } catch (e) { console.log(`${C.dim}  （信号发送失败：${e.code || e.message}）${C.reset}`); }
    if (await waitBridgeDown(4000)) { console.log(`${C.green}✔${C.reset} 桥接服务已停止（PID ${pid}）`); return true; }
    try {
      process.kill(pid, 'SIGKILL');   // Windows 上等同 TerminateProcess
      console.log(`${C.yellow}·${C.reset} 强杀 PID ${pid}…`);
    } catch { /* 可能已退出 */ }
    if (await waitBridgeDown(4000)) { console.log(`${C.green}✔${C.reset} 桥接服务已停止（强杀 PID ${pid}）`); return true; }
  } else {
    console.log(`${C.dim}  （没找到 PID 文件：跑着的应该是旧版服务）${C.reset}`);
  }

  // 3) 兜底：端口 → PID → taskkill
  const killed = killByPort(3100);
  if (killed) {
    console.log(`${C.yellow}·${C.reset} 按端口结束 PID ${killed}…`);
    if (await waitBridgeDown(4000)) { console.log(`${C.green}✔${C.reset} 桥接服务已停止（强制结束 PID ${killed}）`); return true; }
  }

  console.log(`${C.red}✘ 停止失败：进程仍在占用 ${BRIDGE_URL}${C.reset}`);
  console.log(`${C.dim}  请手动关闭那个运行中的服务窗口（或在本窗口按 Ctrl+C 后重来）${C.reset}`);
  return false;
}

/** 等桥接下线，返回是否已下线 */
async function waitBridgeDown(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await bridgeAlive())) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return !(await bridgeAlive());
}

/** 找出监听指定端口的进程并结束。返回 PID 或 null。
 *  ⚠ 依赖 netstat/taskkill，在受限环境会失败 —— 所以只作兜底，
 *     失败时必须如实返回 null，让调用方报失败（不能谎报成功）。 */
function killByPort(port) {
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === port) pids.add(m[2]);
    }
    let last = null;
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', windowsHide: true });
        last = pid;
      } catch { /* 可能已退出 */ }
    }
    return last;
  } catch (e) {
    console.log(`${C.dim}  （按端口结束失败：${e.code || e.message}）${C.reset}`);
    return null;
  }
}

/** 重启桥接服务：先停（确保跑的是最新代码），确认端口释放后再起。 */
async function restartBridge() {
  console.log(`${C.cyan}·${C.reset} 重启桥接服务…`);
  const oldPid = readBridgePid();
  const stopped = await stopBridge();
  if (!stopped) {
    console.log(`${C.red}✘ 重启中止：旧进程没停掉，直接起新的会因端口被占而失败。${C.reset}`);
    return false;
  }
  const ok = await ensureBridge();
  if (!ok) return false;
  // 证明真的是**新进程**：新进程会重写 PID 文件，PID 应当变了
  await new Promise((r) => setTimeout(r, 500));
  const newPid = readBridgePid();
  if (oldPid && newPid && oldPid === newPid) {
    console.log(`${C.red}✘ 重启可疑：PID 没变（${newPid}），跑的可能还是旧代码${C.reset}`);
    return false;
  }
  console.log(`${C.green}✔${C.reset} 桥接服务已重启${newPid ? `（新 PID ${newPid}${oldPid ? `，旧 ${oldPid}` : ''}）` : ''}，跑的是最新代码`);
  return true;
}

async function apiGetText(p) {
  const r = await fetch(`${BRIDGE_URL}${p}`);
  return { ok: r.ok, text: await r.text() };
}
async function apiPost(p, body) {
  const r = await fetch(`${BRIDGE_URL}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
}

/* ============================ 交互 ============================ */

/**
 * 全程复用同一个 readline 接口。
 *
 * ⚠ 早期实现是「每次提问新建一个 readline，问完就 close」。
 *    后果：管道/重定向输入时，第二次提问之后 stdin 就不再被消费
 *    （测试中表现为「输入 1 能进菜单，输入 2 之后第三次输入丢失」）。
 *    单例接口可以彻底避免这类问题，也更符合终端程序惯例。
 */
let rlInstance = null;

function getRL() {
  if (!rlInstance) {
    rlInstance = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return rlInstance;
}

function closeRL() {
  if (rlInstance) {
    rlInstance.close();
    rlInstance = null;
  }
}

/** 提一个问题并等待回车 */
function ask(question) {
  return new Promise((resolve) => {
    const rl = getRL();
    rl.question(question, (a) => resolve(String(a || '').trim()));
  });
}

/** 兼容旧调用点 */
function makePrompt() {
  return { rl: { close: () => {} }, ask };
}

/* ============================ 主流程 ============================ */

async function showStatus() {
  let s;
  try {
    s = await apiGet('/api/crawler/status');
  } catch {
    return;
  }

  const win = s.window || {};
  const winTxt =
    win.earliestHour === 0 && win.latestHour >= 24
      ? '全天（0:00 ~ 24:00 之间随机）'
      : `${win.earliestHour}:00 ~ ${win.latestHour}:00 之间随机`;

  console.log('');
  console.log(`  ${C.dim}自动调度${C.reset}：${s.scheduleEnabled ? C.green + '已开启' + C.reset : C.yellow + '已关闭' + C.reset}　窗口：${winTxt}`);
  console.log(`  ${C.dim}今日计划${C.reset}：${C.bold}${s.plannedLocal || '—'}${C.reset}${s.planDate && s.planDate !== s.today ? C.dim + `（${s.planDate}）` + C.reset : ''}`);

  if (s.lastRunAt) {
    const when = String(s.lastRunAt).replace('T', ' ').slice(0, 19);
    const trig = { auto: '自动', manual: '手动', launcher: '启动器' }[s.lastRunTrigger] || s.lastRunTrigger;
    const okMark = s.lastRunExitCode === 0 ? C.green + '成功' + C.reset : C.red + '失败(' + s.lastRunExitCode + ')' + C.reset;
    console.log(`  ${C.dim}上次采集${C.reset}：${when}　${trig}　${okMark}`);
  } else {
    console.log(`  ${C.dim}上次采集${C.reset}：${C.dim}尚未采集过${C.reset}`);
  }

  // 各爬虫今日是否已跑
  if (Array.isArray(s.crawlers) && s.crawlers.length) {
    const done = s.lastAutoByCrawler || {};
    const parts = s.crawlers.map((c) => {
      const ran = done[c.id] === s.today;
      const mark = c.schedule === false ? C.dim + '仅手动' + C.reset : ran ? C.green + '今日已跑' + C.reset : C.yellow + '今日待跑' + C.reset;
      return `#${c.id} ${c.name} ${mark}`;
    });
    console.log(`  ${C.dim}爬虫状态${C.reset}：${parts.join('　')}`);
  }
  console.log('');
}

async function showCatalogBrief(platform = 'huawei') {
  try {
    const c = await apiGet(`/api/crawler/catalog?platform=${platform}`);
    const rush = c.rushBuy || [];
    const prods = c.products || [];
    const inv = Object.keys(c.inventory || {}).length;

    console.log(`  ${C.dim}最近采集于${C.reset} ${String(c.generatedAt).replace('T', ' ').slice(0, 19)}`);
    console.log(`  ${C.dim}商品${C.reset} ${prods.length} 个　${C.dim}SKU库存${C.reset} ${inv} 条　${C.dim}抢购场次${C.reset} ${rush.length} 条`);

    // 抢购场次按时间归并展示
    const byTime = new Map();
    for (const r of rush) {
      const k = r.startTime || '(无时间)';
      if (!byTime.has(k)) byTime.set(k, []);
      byTime.get(k).push(r);
    }
    let shown = 0;
    for (const [t, list] of byTime) {
      if (shown++ >= 3) break;
      const mins = list[0].startsInMs != null ? Math.round(list[0].startsInMs / 60000) : null;
      console.log(
        `    ${C.cyan}开售${C.reset} ${String(t).replace('T', ' ').slice(0, 19)}　规格 ${list.length} 个　限购 ${list[0].limitNum ?? '—'}` +
          (mins != null && mins > 0 ? `　${C.green}${mins} 分钟后${C.reset}` : ''),
      );
    }
    if ((c.restockSignals || []).length) {
      console.log(`    ${C.green}发现回流信号 ${c.restockSignals.length} 条${C.reset}`);
    }
  } catch {
    console.log(`  ${C.dim}（还没有采集结果，先跑一次吧）${C.reset}`);
  }
  console.log('');
}

async function runOne(crawler, opts = {}) {
  const presets = crawler.presetArgs && crawler.presetArgs.length
    ? crawler.presetArgs
    : [{ key: '1', label: '默认运行', args: [] }];

  // 非交互模式：直接用指定预设（或第一个）
  let preset;
  if (opts.nonInteractive) {
    preset = opts.presetKey
      ? presets.find((p) => String(p.key) === String(opts.presetKey))
      : presets[0];
    if (!preset) {
      console.log(`${C.red}✘ 无此运行方式：${opts.presetKey}${C.reset}`);
      return;
    }
    console.log(`${C.yellow}▶ ${crawler.name}${C.reset} —— ${preset.label}`);
  } else {
    // 交互模式：二级菜单
    console.log('');
    line();
    console.log(`${C.bold}  #${crawler.id} ${crawler.name}${C.reset} ${C.dim}选择运行方式${C.reset}`);
    line();
    for (const p of presets) {
      console.log(`   ${C.bold}${p.key}${C.reset}) ${p.label}`);
    }
    console.log(`   ${C.dim}0) 返回${C.reset}`);
    console.log('');

    const key = await ask(`  请输入编号并回车 ${C.dim}[1]${C.reset}: `);

    const chosenKey = key === '' ? presets[0].key : key;
    if (chosenKey === '0') return;

    preset = presets.find((p) => String(p.key) === String(chosenKey));
    if (!preset) {
      console.log(`  ${C.red}无效编号：${chosenKey}${C.reset}`);
      return;
    }

    console.log('');
    console.log(`${C.yellow}▶ 正在启动${C.reset} #${crawler.id} ${crawler.name} —— ${preset.label}`);
    console.log(`${C.dim}  （在后台运行，完成后自动返回本菜单）${C.reset}`);
    if (String(preset.key) === '1') {
      console.log(`${C.dim}  完整采集含"发现新商品"阶段，通常 2~5 分钟；想快就用第 2 项${C.reset}`);
    } else {
      console.log(`${C.dim}  预计 10~30 秒${C.reset}`);
    }
    console.log('');
  }

  const t0 = Date.now();
  let res;
  try {
    res = await apiPost('/api/crawler/run', {
      id: crawler.id,
      presetKey: preset.key,
    });
  } catch (e) {
    console.log(`${C.red}✘ 请求失败：${e.message}${C.reset}`);
    return;
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (res.status === 200 && res.body?.ok) {
    const c = res.body.summary?.counts || {};
    console.log(`${C.green}✔ 采集完成${C.reset}（${secs} 秒）`);
    if (Object.keys(c).length) {
      console.log(
        `  商品 ${c.products ?? 0} 个　SKU库存 ${c.inventorySkus ?? 0} 条　抢购场次 ${c.rushBuyEntries ?? 0} 条　新发现 ${c.discovered ?? 0} 个` +
          (c.blocked ? `　${C.red}风控中断 ${c.blocked} 次${C.reset}` : ''),
      );
    }
    if (res.body.stdoutTail) {
      const tail = String(res.body.stdoutTail).split('\n').filter(Boolean).slice(-6);
      console.log('');
      for (const l of tail) console.log(`  ${C.dim}${l}${C.reset}`);
    }
  } else {
    console.log(`${C.red}✘ 采集失败${C.reset}（${secs} 秒）`);
    const b = res.body || {};
    if (b.error) console.log(`  ${C.red}${b.error}${C.reset}`);
    if (b.hint) console.log(`  ${C.yellow}${b.hint}${C.reset}`);
    if (b.stderrTail) {
      console.log('');
      for (const l of String(b.stderrTail).split('\n').filter(Boolean).slice(-8)) console.log(`  ${C.dim}${l}${C.reset}`);
    }
  }

  console.log('');
  console.log(`  ${C.dim}提示：本爬虫今天已标记为「已跑过」，不会再被自动调度重复启动。${C.reset}`);
}

async function main() {
  const once = process.argv.includes('--once');
  const wantId = (() => {
    const i = process.argv.indexOf('--id');
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
  })();
  const wantPreset = (() => {
    const i = process.argv.indexOf('--preset');
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
  })();

  // 非交互子命令：给「重启服务.bat / 停止服务.bat」用
  // （桥接改完代码必须重启才生效，用户不该需要去找进程 PID）
  if (process.argv.includes('--restart')) {
    title('重启桥接服务');
    const ok = await restartBridge();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (process.argv.includes('--stop')) {
    title('停止桥接服务');
    const ok = await stopBridge();
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (process.argv.includes('--status')) {
    title('服务状态');
    const alive = await bridgeAlive();
    console.log(alive
      ? `${C.green}✔${C.reset} 桥接服务在运行 ${C.dim}${BRIDGE_URL}${C.reset}`
      : `${C.yellow}·${C.reset} 桥接服务未运行`);
    process.exitCode = alive ? 0 : 1;
    return;
  }

  console.clear?.();
  title('华为商城抢购 · 一键启动器');

  if (!(await ensureBridge())) {
    process.exitCode = 1;
    return;
  }

  // 拉取爬虫清单
  let crawlers = [];
  try {
    const r = await apiGet('/api/crawler/list');
    crawlers = r.crawlers || [];
  } catch (e) {
    console.log(`${C.red}✘ 读取爬虫清单失败：${e.message}${C.reset}`);
    process.exitCode = 1;
    return;
  }

  // --once / --id：非交互，直接跑（给批处理或计划任务用）
  if (once || wantId) {
    const c = wantId ? crawlers.find((x) => String(x.id) === String(wantId)) : crawlers[0];
    if (!c) {
      console.log(`${C.red}✘ 未找到爬虫 ${wantId}${C.reset}`);
      process.exitCode = 1;
      return;
    }
    await runOne(c, { nonInteractive: true, presetKey: wantPreset });
    return;
  }

  // 交互循环
  for (;;) {
    await showStatus();
    await showCatalogBrief('huawei');

    line();
    console.log(`${C.bold}  可用的爬虫${C.reset}`);
    line();
    if (!crawlers.length) {
      console.log(`  ${C.yellow}（没有启用的爬虫，请检查 data/grab/crawlers.json）${C.reset}`);
    }
    for (const c of crawlers) {
      const tag = c.schedule === false ? C.dim + '[仅手动]' + C.reset : C.green + '[每日自动]' + C.reset;
      console.log(`   ${C.bold}${c.id}${C.reset}) ${c.name.padEnd(12)} ${tag} ${C.dim}${c.desc || ''}${C.reset}`);
    }
    console.log(`   ${C.dim}R${C.reset}) 重新读取状态`);
    console.log(`   ${C.dim}A${C.reset}) 全部爬虫各跑一次`);
    console.log(`   ${C.dim}C${C.reset}) 打开控制台网页（结果回传 / 参数配置）`);
    console.log(`   ${C.bold}S${C.reset}) ${C.bold}重启服务${C.reset} ${C.dim}（改完桥接代码后点这个：先停再起）${C.reset}`);
    console.log(`   ${C.dim}T${C.reset}) 停止服务 ${C.dim}（关掉后台的桥接进程）${C.reset}`);
    console.log(`   ${C.dim}Q${C.reset}) 退出`);
    console.log('');

    const ans = await ask(`  ${C.bold}请输入编号并回车${C.reset}: `);

    const a = ans.toUpperCase();
    if (a === 'Q' || a === '') {
      console.log(`\n  ${C.dim}已退出。桥接服务仍在后台运行（下次启动器会自动复用）。${C.reset}\n`);
      closeRL();
      return;
    }
    if (a === 'R') continue;

    if (a === 'S') {
      console.log('');
      await restartBridge();
      console.log('');
      continue;
    }

    if (a === 'T') {
      console.log('');
      await stopBridge();
      console.log(`\n  ${C.dim}服务已关闭。要恢复请重新运行本启动器。${C.reset}\n`);
      closeRL();
      return;
    }

    if (a === 'C') {
      console.log(`\n  ${C.cyan}控制台地址：${BRIDGE_URL}/${C.reset}\n`);
      // 尝试用系统默认浏览器打开
      try {
        spawn('cmd', ['/c', 'start', '', BRIDGE_URL], { detached: true, stdio: 'ignore' }).unref();
      } catch {
        /* 打不开就算了，地址已经打印 */
      }
      continue;
    }

    if (a === 'A') {
      for (const c of crawlers) {
        await runOne(c);
      }
      continue;
    }

    const c = crawlers.find((x) => String(x.id) === a);
    if (!c) {
      console.log(`  ${C.red}无效输入：${ans}${C.reset}\n`);
      continue;
    }
    await runOne(c);
  }
}

main().catch((e) => {
  console.error(`\n${C.red}启动器异常：${e.message}${C.reset}`);
  console.error(C.dim + (e.stack || '') + C.reset);
  process.exitCode = 1;
});
