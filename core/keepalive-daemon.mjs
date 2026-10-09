#!/usr/bin/env node
/**
 * 独立保活守护（2026-10-08；2026-10-09 加控制通道）
 * =====================================================================
 * 根因实测：vmall 服务端会话约 30 分钟无活动就失效（Cookie 还在也没用）；
 * 之前保活挂在驱动里，驱动一停就没人续。本进程独立常驻：每轮间隔 4~6 分钟随机
 * （固定整点节拍=机器人指纹，2026-10-08 加抖动），对每个在跑的槽位窗口发一次
 * 轻请求（www.vmall.com 续 cluster + queryUserInfo 验活），多窗口错开发。
 * 日志：data/grab/keepalive.log（掉线会明确写出来）。
 * 由 grab-bridge.mjs 开机自动拉起；也可手动跑。
 *
 * 2026-10-09 追加「控制小门口」（127.0.0.1:3101，可用 KEEPALIVE_CTL_PORT 改）：
 *   GET  /ping   → 自报身份（pid / 上一轮 / 下一轮 / 是否正在跑）——「在不在跑」以它为准
 *   POST /stop   → 体面退出（被控制台「停止」调用：先发回执、再清 PID 文件、再退）
 *   POST /round  → 立即加跑一轮（被控制台「立即测一轮」调用）
 * 为什么加：旧版「停止」只按 PID 文件杀那一个进程——「立即测一轮」是另起的
 * 一次性进程、不受管，停止后它还在往同一份日志写「已续命」，看起来就是
 * “停了还在保活”；且 PID 文件一旦丢失，活着的守护就变成“看不见、停不掉”。
 * 现在：单例判定 = 控制端口独占（原子，无抢跑窗口）；每轮把 PID 文件自愈重写；
 * 停止 = 端口叫停 + PID 文件兜底 + 测试轮一并停 + 停完复核（都在桥接侧）。
 *
 * 自测：KEEPALIVE_DIR + KEEPALIVE_CTL_PORT 可把日志/PID/槽位文件与端口整体
 * 重定向到临时目录（verify/verify-keepalive-control.mjs 用），不影响生产。
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { CDP, listTabs, judgeVmallLoginBody } from './cdp-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 数据面文件全部可被 KEEPALIVE_DIR 重定向（自测用）；生产 = data/grab
const DATA_DIR = process.env.KEEPALIVE_DIR ? path.resolve(process.env.KEEPALIVE_DIR) : path.join(ROOT, 'data', 'grab');
const LOG = path.join(DATA_DIR, 'keepalive.log');
const PID = path.join(DATA_DIR, 'keepalive.pid');
const SLOTS_FILE = path.join(DATA_DIR, 'rush-slots.huawei.json');
const CTL_PORT = Number(process.env.KEEPALIVE_CTL_PORT || 3101);
const INTERVAL_MS = 5 * 60 * 1000;
const ONCE = process.argv.includes('--once');

// 2026-10-08 加抖动：固定 5:00 一跳（keepalive.log 里整点不差的节拍）= 机器人指纹。
// 每轮间隔 = 基准 ×(0.8~1.2)，即 4~6 分钟随机；两个窗口错开 2~8 秒、发起前再等 0.5~2.5 秒。
// 安全边界：服务端会话 30 分钟失活、cluster 窗口 15 分钟，最长 6 分钟续一次离两个红线都很远。
const jitter = (min, max) => Math.round(min + Math.random() * (max - min));

/* ---- 运行状态（声明必须在所有使用者之前） ---- */
const startedAt = Date.now();
let ctlServer = null;       // 控制小门口（HTTP server）
let ctlOwned = false;       // 是否抢到了控制端口（抢不到 = 降级运行，停止走 PID 文件兜底）
let roundInFlight = false;  // 是否正在跑一轮
let lastRoundAt = 0;        // 上一轮完成时刻
let nextRoundAt = 0;        // 下一轮预定时刻
let nextTimer = null;       // 下一轮的定时器（「立即测一轮」会重排）

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 已存在 */ }

const log = (msg) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* 忽略 */ }
};
const slotsPorts = () => {
  try { return (JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8')).slots || []).map((s) => s.port).filter(Boolean); }
  catch { return []; }
};

/** 体面退出：清自己的 PID 文件（只删内容是自己那个）、关控制端口 */
function cleanupAndExit(code = 0) {
  try {
    if (fs.existsSync(PID) && fs.readFileSync(PID, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID);
  } catch { /* 忽略 */ }
  try { ctlServer && ctlServer.close(); } catch { /* 忽略 */ }
  process.exit(code);
}

async function pingOnce(tag) {
  // 一次性/手动轮的标记：这些日志跟「停止」的管辖范围无关，必须一眼能分清是谁写的
  const pre = tag ? `【${tag}】` : '';
  // 每轮随机洗牌窗口顺序，别让 9401 永远第一个发请求
  const ports = [...new Set(slotsPorts())].sort(() => Math.random() - 0.5);
  for (const port of ports) {
    await new Promise((r) => setTimeout(r, jitter(500, 2500))); // 发起前再晃一下
    try {
      if (!(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json().catch(() => null))) continue;
      const tab = (await listTabs(port).catch(() => [])).find((t) => /comdetail/.test(t.url || ''));
      if (!tab) continue;
      const cdp = new CDP(tab.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Runtime.enable');
      const r = await cdp.eval(`(async () => {
        try { await fetch('https://www.vmall.com/', { credentials: 'include', mode: 'no-cors' }); } catch (e) {}
        try {
          const r = await fetch('https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN', { credentials: 'include' });
          return (await r.text()).slice(0, 300);
        } catch (e) { return '__ERR__' + ((e && e.message) || e); }
      })()`).catch(() => '__ERR__');
      try { cdp.ws.close(); } catch { /* 已关 */ }
      // 判定挪到宿主侧（judgeVmallLoginBody 抗 vmall 挖 s 混淆——13:59 把已登录的 9401 误报成掉线就是它）
      const verdict = String(r).startsWith('__ERR__') ? 'err' : judgeVmallLoginBody(r);
      const head = String(r).replace(/\s+/g, ' ').slice(0, 80);
      if (verdict === 'out') log(`${pre}端口 ${port}：⚠️ 掉线了（服务端会话失效）——需要人工重新登录｜响应头：${head}`);
      else if (verdict === 'err') log(`${pre}端口 ${port}：探测出错（网络抖动，下轮再看）`);
      else if (verdict === null) log(`${pre}端口 ${port}：响应读不懂（不当掉线，下轮再看）：${head}`);
      else log(`${pre}端口 ${port}：已续命`);
    } catch (e) {
      log(`${pre}端口 ${port}：检查异常（${e.message}）`);
    }
    // 多窗口时错开几秒，别同一秒齐射（两个端口日志总在同一秒=太整齐）
    if (ports.indexOf(port) < ports.length - 1) await new Promise((r) => setTimeout(r, jitter(2000, 8000)));
  }
}

/** 跑完一轮：收尾 + PID 文件自愈重写（文件被误删也能在下一轮长回来，不留“看不见的守护”） */
async function runRound(tag) {
  if (roundInFlight) return false;
  roundInFlight = true;
  try { await pingOnce(tag); } finally { roundInFlight = false; }
  lastRoundAt = Date.now();
  if (!ONCE) { try { fs.writeFileSync(PID, String(process.pid)); } catch { /* 忽略 */ } }
  return true;
}

function scheduleNext() {
  if (ONCE) return;
  if (nextTimer) clearTimeout(nextTimer);
  // 递归 setTimeout（不用 setInterval）：每轮间隔都重新摇
  const gap = Math.round(INTERVAL_MS * (0.8 + Math.random() * 0.4));
  nextRoundAt = Date.now() + gap;
  log(`下一轮 ${new Date(nextRoundAt).toLocaleTimeString('zh-CN', { hour12: false })}（间隔 ${Math.round(gap / 1000)} 秒）`);
  nextTimer = setTimeout(async () => { await runRound(''); scheduleNext(); }, gap);
}

/* ---- 控制小门口：本机端口，问状态 / 叫停 / 加跑一轮 ---- */
function answerCtl(req, res) {
  const send = (code, obj) => { try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); } catch { /* 忽略 */ } };
  const u = (req.url || '').split('?')[0];
  if (req.method === 'GET' && u === '/ping') {
    return send(200, { ok: true, pid: process.pid, startedAt, lastRoundAt, nextRoundAt, roundInFlight });
  }
  if (req.method === 'POST' && u === '/stop') {
    log('收到控制台的「停止」指令，退出');
    send(200, { ok: true, pid: process.pid });
    setTimeout(() => cleanupAndExit(0), 80); // 先把回执发出去再退
    return;
  }
  if (req.method === 'POST' && u === '/round') {
    if (roundInFlight) return send(200, { ok: true, note: '这一轮正在跑，稍等片刻看下方日志' });
    send(200, { ok: true, note: '已加跑一轮测试（约半分钟），看下方日志' });
    runRound('手动测试').then((done) => { if (done) scheduleNext(); }).catch(() => {});
    return;
  }
  send(404, { ok: false, error: 'not found' });
}
function startControlServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(answerCtl);
    srv.once('error', reject);
    srv.listen(CTL_PORT, '127.0.0.1', () => { srv.removeListener('error', reject); resolve(srv); });
  });
}
/** 问一下控制端口是不是“同类”：端口被占时用来区分「已有守护在跑」和「被别的程序占用」 */
async function probeControl(tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CTL_PORT}/ping`, { signal: AbortSignal.timeout(500) });
      const j = await r.json();
      if (j && j.ok && j.pid) return j;
    } catch { /* 再试 */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/* ============================ 启动 ============================ */

if (ONCE) {
  // 一次性测试轮：不写 PID 文件、不占控制端口，跑完就退（由桥接的 test.pid 跟踪，便于「停止」一并叫停）
  log(`【测试轮】开始（pid ${process.pid}，一次性：跑完自动退出）`);
  await runRound('测试轮');
  process.exit(0);
}

// 单例 = 控制端口独占（原子，没有“同时启动两个”的抢跑窗口）
try {
  ctlServer = await startControlServer();
  ctlOwned = true;
} catch {
  const theirs = await probeControl();
  if (theirs) {
    log(`保活守护已在运行（pid ${theirs.pid}），本次不再重复启动`);
    process.exit(0);
  }
  log(`注意：控制端口 ${CTL_PORT} 被其他程序占用，本次以降级模式运行（停止仍可用，会走 PID 文件兜底）`);
}
try { fs.writeFileSync(PID, String(process.pid)); } catch { /* 忽略 */ }
log(`保活守护启动（pid ${process.pid}，每轮 4~6 分钟随机，带抖动${ctlOwned ? `，控制端口 ${CTL_PORT}` : ''}）`);

await runRound('');
scheduleNext();

// PID 文件随退出清理（被强杀时不执行，由桥接侧停止流程兜底清理）
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => cleanupAndExit(0)); } catch { /* 平台不支持该信号 */ }
}
