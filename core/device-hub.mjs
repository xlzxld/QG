/**
 * 设备中枢守护进程 (Device Hub) — 2026-10-09 全面重构版
 * =====================================================================
 * 职责：
 *   1. 手机设备发现、注册（hello）与状态心跳监测（heartbeat）
 *   2. 双模通信：USB adb reverse (127.0.0.1:3120) + 局域网 Wi-Fi (0.0.0.0:3120)
 *   3. HTTP 长轮询任务队列（poll-task，挂起 ≤25s）
 *   4. 任务结果接收、幂等去重（taskId+seq）并沉降至 data/grab/
 *   5. 一键设备连接：ADB 检测 → reverse → 推送脚本+区划数据 → 拉起 Agent → 验证上线
 *   6. 游标式事件流（sinceMs）+ 事件清空（双向同步）
 *   7. 探针库 / 账号库 / 量化配置管理
 *
 * 启动：node core/device-hub.mjs   （npm run hub）
 * =====================================================================
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, exec as execAsync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateIdCard, validatePhone, loadAccountProfile, saveAccountProfile } from '../platforms/damai/account-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// 数据目录默认 data/grab; 测试等场景可用 DEVICE_HUB_DATA_DIR 指向临时目录, 避免污染生产数据
const GRAB_DIR = process.env.DEVICE_HUB_DATA_DIR
  ? path.resolve(process.env.DEVICE_HUB_DATA_DIR)
  : path.join(ROOT, 'data', 'grab');
const PORT = Number(process.env.DEVICE_HUB_PORT || 3120);
const HOST = '0.0.0.0';
const AGENT_SCRIPT = path.join(ROOT, 'platforms', 'app', 'agent', 'main.js');
const REGIONS_FILE = path.join(GRAB_DIR, 'regions.json');
const CONSOLE_HTML = path.join(ROOT, 'web', 'hub-console.html');
const AUTOJS_PKG = 'org.autojs.autojs6';
const AUTOJS_ACC_SERVICE = 'org.autojs.autojs.core.accessibility.AccessibilityServiceUsher';

/* ============ 本机 adb 优先：项目根 platform-tools ============
 * 不依赖系统 PATH 是否已生效（刚配置完 / 老窗口环境变量没刷新时照样能用）。 */
const LOCAL_ADB_DIR = path.join(ROOT, 'platform-tools');
if (fs.existsSync(path.join(LOCAL_ADB_DIR, 'adb.exe'))) {
  const curPath = process.env.PATH || process.env.Path || '';
  if (!curPath.toLowerCase().includes(LOCAL_ADB_DIR.toLowerCase())) {
    process.env.PATH = LOCAL_ADB_DIR + ';' + curPath;
  }
}

/* ============ ADB 设备探测 (2s 缓存) ============ */
let lastAdbScanTime = 0;
let cachedAdbDevices = [];

function runAdb(cmd, timeoutMs = 4000) {
  // ★ 无控制台环境（后台运行）下必须 windowsHide，否则每次调用都会弹一个黑窗口（同桥接约定）
  return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: 'pipe', windowsHide: true });
}

function parseAdbDevices(output) {
  const list = [];
  for (const line of String(output).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices attached')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts[1] === 'device') {
      const modelMatch = trimmed.match(/model:(\S+)/);
      list.push({
        serial: parts[0],
        model: modelMatch ? modelMatch[1] : 'Android',
      });
    }
  }
  return list;
}

function scanAdbDevices() {
  const now = Date.now();
  if (now - lastAdbScanTime < 2000) return cachedAdbDevices;
  lastAdbScanTime = now;
  // 测试开关: DEVICE_HUB_FAKE_NO_ADB=1 → 强制"无 USB"场景 (验证 WiFi 降级链路用, 不碰真机)
  if (process.env.DEVICE_HUB_FAKE_NO_ADB === '1') { cachedAdbDevices = []; return cachedAdbDevices; }
  try {
    const output = runAdb('adb devices -l', 6000);
    const list = parseAdbDevices(output);
    // 自动维持 USB 反向端口代理
    for (const d of list) {
      try { runAdb(`adb -s ${d.serial} reverse tcp:${PORT} tcp:${PORT}`, 1200); } catch (e) {}
    }
    cachedAdbDevices = list;
  } catch (e) {
    cachedAdbDevices = [];
  }
  return cachedAdbDevices;
}

// 后台周期探测: 维持 adb reverse 隧道与设备缓存 (hub 重启 / 手机重插 USB 后自动恢复,
// 不依赖浏览器控制台是否打开; async 执行避免阻塞事件循环)
//
// ★ 自适应节奏：adb 正常时每 5 秒一轮（抢购场景要的就是手机掉线后快速自愈）；
//   问不到 adb（没装 / 不在 PATH）时退避为每 60 秒试一次，避免每 5 秒白跑一次；
//   装好 adb 后重启中枢，节奏自动恢复正常。
let adbPollMs = 5000;
let adbPollState = 'ok'; // 'ok' | 'no-adb'
// 超时给足 6 秒：adb 服务冷启动（开机后第一次 / 服务被清掉时）可能要 2~4 秒拉起，
// 超时太短会被误判成「adb 不可用」而错误降频（实测 2 秒必被强杀）。
const scheduleAdbPoll = () => {
  setTimeout(() => {
    execAsync('adb devices -l', { timeout: 6000, windowsHide: true }, (err, stdout) => {
      if (err) {
        cachedAdbDevices = [];
        lastAdbScanTime = Date.now();
        if (adbPollState !== 'no-adb') {
          adbPollState = 'no-adb';
          adbPollMs = 60000;
          log('[设备探测] 未找到 adb（或执行失败）：探测降频为每 60 秒一次；装好 adb 后重启中枢即可恢复正常节奏');
        }
        scheduleAdbPoll();
        return;
      }
      if (adbPollState !== 'ok') {
        adbPollState = 'ok';
        adbPollMs = 5000;
        log('[设备探测] adb 已恢复正常，探测节奏恢复为每 5 秒一次');
      }
      const list = parseAdbDevices(stdout);
      lastAdbScanTime = Date.now();
      cachedAdbDevices = list;
      for (const d of list) {
        execAsync(`adb -s ${d.serial} reverse tcp:${PORT} tcp:${PORT}`, { timeout: 1500, windowsHide: true }, () => {});
      }
      if (list.length) log(`[USB 隧道] 已自动维持 ${list.length} 台设备的 tcp:${PORT} 反向代理`);
      scheduleAdbPoll();
    });
  }, adbPollMs).unref();
};
scheduleAdbPoll();

/* ============ 常驻 adb shell 通道 (grab 抢购热路径专用) ============
 * 2026-10-09 真机实测: 每次 execSync spawn adb.exe ≈ 210ms/次;
 * 常驻 shell 经 stdin 写入命令 ≈ 29ms/次(连发) / echo 往返 3ms。
 * 首击与提交风暴都靠它提速; 任何失败自动回落 execSync 通道。 */
const ADB_BIN = fs.existsSync(path.join(LOCAL_ADB_DIR, 'adb.exe'))
  ? path.join(LOCAL_ADB_DIR, 'adb.exe')
  : 'adb';
let adbShellProc = null;
let adbShellSerial = null;

function ensureAdbShell(serial) {
  if (adbShellProc && adbShellSerial === serial && adbShellProc.exitCode === null && !adbShellProc.killed) return true;
  try { if (adbShellProc) adbShellProc.kill(); } catch (e) { /* 忽略 */ }
  adbShellProc = null;
  try {
    adbShellProc = spawn(ADB_BIN, ['-s', serial, 'shell'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    adbShellSerial = serial;
    adbShellProc.stdout.on('data', () => { /* 排水: 不关心输出 */ });
    adbShellProc.stderr.on('data', () => { /* 排水 */ });
    adbShellProc.on('exit', () => { adbShellProc = null; });
    adbShellProc.on('error', () => { adbShellProc = null; });
    return true;
  } catch (e) { adbShellProc = null; return false; }
}

/** 通过常驻 shell 一次写入多行命令 (fire-and-forget, 不等待执行完成) */
function adbWriteLines(lines) {
  const adbList = scanAdbDevices();
  if (!adbList.length) return false;
  const serial = adbList[0].serial;
  if (!ensureAdbShell(serial)) return false;
  try {
    adbShellProc.stdin.write(lines.map((l) => l + '\n').join(''));
    return true;
  } catch (e) {
    adbShellProc = null;
    return false;
  }
}

/**
 * 手机侧"系统通知"提示 (尽力而为, 无回执) —— 只在手机脚本旧到不认 phone_op verify_script 时用:
 * 那种情况下手机自己帮不上忙, 只能由电脑经 USB adb 直接往通知栏投一条 (Android 8+ 的 `cmd notification post`)。
 * 返回 { ok, via, note };ok=false 时 note 说明原因 —— 不假装成功。走常驻 shell 是为了绕开 Windows 侧引号/中文编码坑。
 */
function notifyPhoneViaAdb(title, text) {
  const adbList = scanAdbDevices();
  if (!adbList.length) {
    return { ok: false, via: 'none', note: '手机侧弹不出提示: 走不了手机自检通道（脚本不是当前这一版 / 端侧过旧）, 又没有 USB 数据线可直投通知' };
  }
  const clean = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/'/g, '').slice(0, 180);
  const line = `cmd notification post -t '${clean(title)}' qg-script '${clean(text)}'`;
  if (adbWriteLines([line])) {
    return { ok: true, via: 'adb-notification', note: '走不了手机自检通道, 已改由 USB 直投系统通知 (无回执, 请看手机通知栏)' };
  }
  try {
    runAdb(`adb -s ${adbList[0].serial} shell "${line}"`, 5000);
    return { ok: true, via: 'adb-notification-exec', note: '已由 USB 直投系统通知 (无回执, 请看手机通知栏)' };
  } catch (e) {
    const why = String((e && (e.stderr || e.message)) || e).trim().replace(/\s+/g, ' ').slice(0, 150);
    return { ok: false, via: 'adb-failed', note: '手机侧提示未送达: ' + why };
  }
}

/* ============ 计划击发 (hub 侧预置首击) ============
 * 2026-10-09 实测教训: 「到点才发 HTTP 请求」不稳 —— 中枢每 5 秒的 adb 隧道维护/设备探测
 * 会把事件循环占住 1~2 秒, T0 那一发请求可能直接超时, 首击被拖到 T0+1.7s。
 * 解法: 手机在 T0 前把这一发"排在中枢自己的时钟上", 到点由中枢直接写常驻 shell (3ms 级), 全程不经网络。 */
const armedTaps = new Map();   // tag -> timer
const armResults = new Map();  // tag -> { atMs, actualMs, deltaMs, via, x, y }

function armTapStrike({ tag, x, y, atMs }) {
  const prev = armedTaps.get(tag);
  if (prev) { clearTimeout(prev); armedTaps.delete(tag); }
  const px = Math.round(x), py = Math.round(y);
  const fire = () => {
    armedTaps.delete(tag);
    const actual = Date.now();
    let via = 'persist';
    if (!adbWriteLines([`input tap ${px} ${py}`])) {
      via = 'exec';
      try {
        const l = scanAdbDevices();
        if (l.length) runAdb(`adb -s ${l[0].serial} shell input tap ${px} ${py}`, 2500);
        else via = 'fail';
      } catch (e) { via = 'fail'; }
    }
    armResults.set(tag, { atMs, actualMs: actual, deltaMs: actual - atMs, via, x: px, y: py });
    if (armResults.size > 50) armResults.delete(armResults.keys().next().value);   // 防无限增长
    log(`[计划击发] ${tag} 落点(${px},${py}) ΔT0=${actual - atMs}ms via=${via}`);
  };
  const waitMs = atMs - Date.now();
  if (waitMs <= 0) { fire(); return { immediate: true, waitMs: 0 }; }
  const t = setTimeout(fire, waitMs);
  if (t.unref) t.unref();
  armedTaps.set(tag, t);
  return { immediate: false, waitMs };
}

/* ============ 抢购保活优化 (2026-10-09: 全部可回退, 抢完一键恢复原状) ============
 * 目的: 防手机把 Agent 冻住/降级, 导致任务下发延迟或读不到界面。
 * 做的事(全部走 adb, 不安装任何东西):
 *   ① 电池优化白名单 (Doze whitelist)  ← 防 Doze 冻结
 *   ② RUN_ANY_IN_BACKGROUND allow      ← 防后台运行被限
 *   ③ standby bucket = active          ← 防 App Standby 降级
 *   ④ svc power stayon true            ← 插着线时屏幕常亮 (锁屏就读不到按钮了)
 * 回退原则: 只回退"我们确实改过"的项, 原值落盘 data/grab/perf-boost-backup.json (中枢重启也不丢)。 */
const PERF_PKG = 'org.autojs.autojs6';   // 手机端脚本运行时 (AutoJs6)
const PERF_BACKUP_FILE = path.join(GRAB_DIR, 'perf-boost-backup.json');

function adbShell(cmd, timeoutMs = 8000) {
  const l = scanAdbDevices();
  if (!l.length) throw new Error('无 USB 设备');
  return runAdb(`"${ADB_BIN}" -s ${l[0].serial} shell ${cmd}`, timeoutMs);
}

function perfBoostStatus() {
  const out = { pkg: PERF_PKG };
  try {
    const wl = adbShell('dumpsys deviceidle whitelist');
    out.dozeWhitelisted = new RegExp(PERF_PKG.replace(/\./g, '\\.')).test(wl);
  } catch (e) { out.dozeError = e.message; }
  try { out.standbyBucket = String(adbShell(`am get-standby-bucket ${PERF_PKG}`)).trim().replace(/\s+/g, ' '); } catch (e) { out.bucketError = e.message; }
  try {
    const t = String(adbShell(`cmd appops get ${PERF_PKG} RUN_ANY_IN_BACKGROUND`));
    const m = t.match(/:\s*(\w+)/);
    out.runAnyInBg = m ? m[1] : t.trim().slice(0, 40);
  } catch (e) { out.opError = e.message; }
  try { out.stayOn = String(adbShell('settings get global stay_on_while_plugged_in')).trim(); } catch (e) { out.stayOnError = e.message; }
  return out;
}

function perfBoostOn() {
  const before = perfBoostStatus();
  const steps = [];
  const run = (label, cmd) => {
    try { adbShell(cmd, 6000); steps.push(label + ' ✓'); } catch (e) { steps.push(label + ' ✗ ' + e.message); }
  };
  if (before.dozeWhitelisted === false) run('① 电池优化白名单', `cmd deviceidle whitelist +${PERF_PKG}`);
  else steps.push('① 电池优化白名单: 已在（无需改）');
  run('② 后台运行不限', `cmd appops set ${PERF_PKG} RUN_ANY_IN_BACKGROUND allow`);
  run('③ 常驻活动桶', `am set-standby-bucket ${PERF_PKG} active`);
  run('④ 插电屏幕常亮', 'svc power stayon true');
  try { fs.writeFileSync(PERF_BACKUP_FILE, JSON.stringify({ at: Date.now(), before }, null, 2), 'utf8'); } catch (e) { /* 记不上也能跑 */ }
  log(`[保活优化] 开启 → ${steps.join(' | ')}`);
  return { before, steps, after: perfBoostStatus() };
}

function perfBoostOff() {
  let backup = null;
  try { if (fs.existsSync(PERF_BACKUP_FILE)) backup = JSON.parse(fs.readFileSync(PERF_BACKUP_FILE, 'utf8')); } catch (e) { /* 忽略 */ }
  const before = (backup && backup.before) || {};
  const steps = [];
  const run = (label, cmd) => {
    try { adbShell(cmd, 6000); steps.push(label + ' ✓'); } catch (e) { steps.push(label + ' ✗ ' + e.message); }
  };
  // 只回退"我们确实改过"的项 (原值来自备份)
  if (before.dozeWhitelisted === false) run('① 移出电池白名单', `cmd deviceidle whitelist -${PERF_PKG}`);
  else steps.push('① 电池白名单: 原本就在，不动');
  if (before.runAnyInBg && /deny|ignore|default/i.test(before.runAnyInBg)) {
    const mode = /deny/i.test(before.runAnyInBg) ? 'deny' : 'default';
    run(`② 后台运行恢复为 ${mode}`, `cmd appops set ${PERF_PKG} RUN_ANY_IN_BACKGROUND ${mode}`);
  } else if (before.runAnyInBg === undefined) steps.push('② 后台运行: 无备份原值，跳过');
  else steps.push('② 后台运行: 原本就是 ' + before.runAnyInBg + '，不动');
  if (before.standbyBucket && /^\d+$/.test(before.standbyBucket)) {
    run(`③ 活动桶恢复为 ${before.standbyBucket}`, `am set-standby-bucket ${PERF_PKG} ${before.standbyBucket}`);
  } else if (before.standbyBucket) {
    const n = before.standbyBucket.match(/\d+/);
    if (n) run('③ 活动桶恢复原值', `am set-standby-bucket ${PERF_PKG} ${n[0]}`);
    else steps.push('③ 活动桶: 原值无法解析，跳过');
  } else steps.push('③ 活动桶: 无备份原值，跳过');
  if (before.stayOn !== undefined && before.stayOn !== 'null' && /^\d+$/.test(before.stayOn)) {
    run(`④ 插电常亮恢复为 ${before.stayOn}`, `settings put global stay_on_while_plugged_in ${before.stayOn}`);
  } else if (before.stayOn === 'null') {
    run('④ 插电常亮恢复为默认(false)', 'svc power stayon false');
  } else steps.push('④ 插电常亮: 无备份原值，跳过');
  try { if (fs.existsSync(PERF_BACKUP_FILE)) fs.unlinkSync(PERF_BACKUP_FILE); } catch (e) { /* 忽略 */ }
  log(`[保活优化] 恢复原状 → ${steps.join(' | ')}`);
  return { restoredFrom: before, steps, after: perfBoostStatus() };
}

/* ---- 入参小工具 (grab 派发校验用) ---- */
const clampInt = (v, lo, hi, dft) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dft;
};
const validXY = (p) => {
  if (!p) return null;
  const x = Number(p.x), y = Number(p.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
  return { x: Math.round(x), y: Math.round(y) };
};

if (!fs.existsSync(GRAB_DIR)) fs.mkdirSync(GRAB_DIR, { recursive: true });

const PID_PATH = path.join(GRAB_DIR, 'device-hub.pid');
const RESULTS_FILE = path.join(GRAB_DIR, 'app.results.jsonl');
const EVENTS_FILE = path.join(GRAB_DIR, 'device-events.jsonl');
const CONFIG_FILE_ROOT = path.join(ROOT, 'damai.config.json');
const CONFIG_FILE_GRAB = path.join(GRAB_DIR, 'damai.config.json');
const CATALOG_FILE = path.join(GRAB_DIR, 'damai.catalog.json');

function writePidFile() {
  try { fs.writeFileSync(PID_PATH, String(process.pid), 'utf8'); } catch (e) {}
}
function removePidFile() {
  try {
    if (fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch { /* 忽略 */ }
}

const log = (...args) => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  console.log(`[Hub ${ts}]`, ...args);
};

function getLocalIps() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) results.push({ name, address: net.address });
    }
  }
  return results;
}
function primaryLanIp() {
  const ips = getLocalIps();
  return ips.find(i => i.address.startsWith('192.168.'))?.address || ips[0]?.address || '127.0.0.1';
}

/* ============ 内存状态 ============ */
const devices = new Map();          // deviceId -> info
const deviceCancelOverride = new Map();   // deviceId -> taskId (任务记录被清理后的兜底撤销标记)
const taskQueues = new Map();       // deviceId -> [tasks]
const waitingPolls = new Map();     // deviceId -> { res, timer }
const processedResults = new Set(); // `${taskId}:${seq}`
const recentEvents = [];            // 最近 400 条 {at, ...}
let eventsClearedAt = 0;            // 清空水位 (客户端只看大于此水位的事件)
const taskStates = new Map();       // taskId -> { task, dispatchedAt, result? } (最近 30 条)

function addRecentEvent(evt) {
  evt.at = evt.at || Date.now();
  recentEvents.push(evt);
  if (recentEvents.length > 400) recentEvents.shift();
}

/* ============ 统一通道解析 (2026-10-09 新增) ============
 * 问题: 原来所有"中枢代为操作手机"的接口都硬依赖 ADB —— 手机只用 WiFi 连中枢时,
 *       点「打开商品页 / 检测通道自测 / 保活优化」全都被 503「无 USB 设备」挡掉。
 * 口径: **USB(ADB) 优先 → 无 USB 时降级 WiFi(手机 Agent 本地执行)**。
 *   能走 WiFi 的: 打开商品页 / 手势点击 / 界面自测 / 停止 / 更新脚本 → 统一走 phone_op 任务下发
 *   只能走 USB 的: input tap 注入 / adb shell 保活 / 中枢时钟预置击发 / 界面树+截图取证
 *                 → 明确返回 needUsb, 不再笼统报「无USB」(避免让人以为是手机没连上)
 */
/**
 * 「活着的 Agent」= 心跳够新 **且没被按过停止**。
 * ★ 2026-10-10 修: 以前只看心跳新鲜度 —— 点了「停止手机脚本」后中枢仍把设备当在线,
 *   控制台会继续显示"已连接"、还能下发任务(排到队列里没人执行), 最长要等 20 秒心跳超时才纠正。
 *   现在一按停止就立刻把它从"在线"里摘出去 (脚本重启会走 hello, 那时自动恢复)。
 */
function liveAgents(explicitDeviceId) {
  const list = [...devices.values()].filter(d => !d.isAdbOnly && !d.stoppingAt && (Date.now() - d.lastSeen < 20000));
  if (!explicitDeviceId) return list;
  const hit = list.find(d => d.deviceId === explicitDeviceId);
  return hit ? [hit] : list;
}

function resolveChannel(explicitDeviceId) {
  const adb = scanAdbDevices();
  const agent = liveAgents(explicitDeviceId)[0] || null;
  const usb = adb.length > 0;
  const mode = usb ? 'usb' : (agent ? 'wifi' : 'none');
  return {
    mode,                      // 'usb' | 'wifi' | 'none'
    usb, usbCount: adb.length,
    wifi: !!agent,
    deviceId: agent ? agent.deviceId : null,
    // ★ 2026-10-10: 手机自主点击能力 (Shizuku) 状态随心跳更新; 'active' = 已开, 其余都算不能点
    shizuku: agent ? (agent.shizuku || 'unknown') : 'none',
    shizukuReady: !!agent && agent.shizuku === 'active',
    agentVersion: agent ? (agent.agentVersion || '') : '',
    connectionMode: agent ? (agent.connectionMode || '') : (usb ? 'USB (adb reverse)' : ''),
    caps: {
      // 打开商品页 / 自测: 两条通道都能做 (WiFi 走手机本地能力)
      openItem: mode !== 'none',
      // ★ 2026-10-10: 点击只有两路 —— USB(PC-ADB) 与 手机本地 Shizuku; 无障碍手势已删除 (对自绘按钮无效)
      tapAdb: usb,
      tapShizuku: !!agent,     // 手机端需已开 Shizuku, 实际可用性由端侧上报
      armTap: usb,             // 中枢时钟预置击发 = 常驻 adb shell, USB 独占
      perfBoost: usb,          // deviceidle/appops/standby 只能 adb shell, USB 独占
      diagSnapshot: usb,       // uiautomator dump + screencap, USB 独占
    },
  };
}

/* ================================================================
 * 「停止脚本」的确认流程 (2026-10-10 用户口径)
 *   用户原话: 手机收到停止指令后, **退出前先给中枢发一条消息**; 中枢收到就把状态刷成已停止,
 *   然后再"复探一次" —— 若手机还在回应(心跳/轮询) 就说明没停成, 撤回标记。
 *   比"用户点一下中枢就自己假设停掉了"准确得多。
 * ================================================================ */

/** 控制指令即时下发: 若手机正挂在长轮询上, 直接把指令塞进那个响应 (秒级送达, 不用等心跳) */
function deliverControlNow(deviceId, control) {
  if (!deviceId || !waitingPolls.has(deviceId)) return false;
  const { res, timer } = waitingPolls.get(deviceId);
  clearTimeout(timer);
  waitingPolls.delete(deviceId);
  try {
    sendJson(res, 200, { status: 'control', control, serverTime: Date.now() });
    log(`[控制指令] 经长轮询即时下发 → 设备 ${deviceId}: ${JSON.stringify(control)}`);
    return true;
  } catch (e) { return false; }
}

/** 手机回报"我要退了" → 立刻把设备摘出"在线"(isAlive=false), 状态即时刷新 */
function markStopConfirmed(deviceId, reason) {
  const dev = devices.get(deviceId);
  if (!dev) return { ok: false, note: '设备不在列表 (可能已重启/换 id)' };
  dev.stoppingAt = Date.now();
  dev.stopConfirmedAt = Date.now();
  dev.stopReason = String(reason || '').slice(0, 80);
  dev.stopRequested = false;
  log(`[停止确认] 手机回报「我要退了」→ 设备 ${deviceId} 即时按"已停止"处理 (${dev.stopReason})`);
  return { ok: true };
}

/** 复探: 手机回报过停止却还在回应 (心跳/轮询) ⇒ 停止未生效, 撤回"已停止"标记并如实告警 */
function discardStopMark(dev, why) {
  if (!dev || (!dev.stoppingAt && !dev.stopPushedAt)) return;
  const wasConfirmed = !!dev.stoppingAt;
  delete dev.stoppingAt; delete dev.stopConfirmedAt; delete dev.stopReason; delete dev.stopPushedAt;
  log(`[停止复探] ⚠ 设备 ${dev.deviceId} 停止没生效 (${why}) → 撤销停止状态, 脚本仍在运行, 需要的话请再点一次「停止手机脚本」`);
  try {
    addRecentEvent({
      event: 'agent_stop_failed', at: Date.now(), taskId: null,
      detail: { deviceId: dev.deviceId, why, wasConfirmed },
      receivedAt: new Date().toISOString(),
    });
  } catch (e) {}
}

/** 把一条「手机本地执行」的指令下发给 Agent (WiFi 降级通道) */
function dispatchPhoneOp(op, params, deviceId) {
  const task = {
    taskId: `t-op-${op}-${Date.now()}`,
    platform: 'damai',
    mode: 'phone_op',
    op,
    params: params || {},
  };
  const r = dispatchTask(task, deviceId || null);
  return { ...r, task };
}

/* ================================================================
 * 抢购全程记录导出 (2026-10-10) —— 把 device-events.jsonl 里的一次抢购
 * 渲染成**人话 Markdown**（复盘用：手机每一步 + 你在控制台的操作，都在同一条时间线上）
 * ================================================================ */
const DIGEST_EVENT_CN = {
  task_dispatched: '任务下发', task_started: '手机开始执行', step: '步骤', log: '手机日志',
  console_op: '【你/控制台的操作】', task_result: '任务结果',
  grab_armed: '布防参数', channel_probe: '通道预检', channel_warn: '通道告警',
  item_open_ok: '链接就位', item_open_fail: '链接就位失败',
  page_verify_ok: '页面核对通过', page_verify_fail: '页面核对失败', page_id_degraded: '页面身份退化判定',
  station_switch: '巡演切站', anchor_ok: '按钮位置锁定', anchor_degraded: '定位退化', anchor_no_presale: '页面上没有预约结构',
  timesync_done: '与大麦对时', t0_mismatch: '页面开售时间与填写值不符',
  prewatch_change: '开抢前页面就有变化', signal_anomaly: '读不到页面结构', text_signal_fire: '文案兜底命中',
  blind_fire: '到点盲点一发', first_tap_sent: '首击已发出', first_tap_failed: '首击打不出去',
  popup_retry_click: '点了「继续尝试」弹窗', popup_first_seen: '首次发现「继续尝试」弹窗', popup_evidence: '弹窗取证结果', popup_never_seen: '全程没探到弹窗',
  sidecar_start: '副手开工', submit_tap_loop: '连点结束', watch_timeout: '盯梢兜底闸门超时',
  captcha_seen: '出现滑块验证码', captcha_evidence: '验证码取证结果', agent_stopping: '手机回报「我要退了」', diag_saved: '已保存现场证据',
  page_refreshed: '自动刷新页面', selftest_result: '通道自测结果',
  script_verified: '手机脚本自检', ticket_status_change: '余票状态变化',
};
/** 这些是噪音事件, 不进复盘记录 */
const DIGEST_SKIP = new Set(['task_cancel_requested', 'device_hello', 'heartbeat', 'device_online', 'device_offline', 'device_result_ack']);

/** 单条事件 → 一行人话 (未知事件只列关键字段, 不整段 JSON) */
function digestLine(o) {
  const t = new Date(o.at || Date.parse(o.receivedAt || '') || Date.now()).toTimeString().slice(0, 8);
  const d = o.detail || {};
  const cn = DIGEST_EVENT_CN[o.event] || o.event;
  if (o.event === 'log') return `- \`${t}\` ${d.msg || ''}`;
  if (o.event === 'console_op') return `- \`${t}\` **【人工/控制台】${d.msg || ''}**`;
  if (o.event === 'step') return `- \`${t}\` [步骤] ${d.step} → ${d.status}${d.detail ? ' · ' + d.detail : ''}`;
  if (o.event === 'task_dispatched') return `- \`${t}\` [任务下发] ${d.mode} · ${d.target || ''}`;
  if (o.event === 'task_started') return `- \`${t}\` [手机开始执行] ${d.mode} ${d.target || ''}`;
  if (o.event === 'task_result') return `- \`${t}\` **[结果] ${d.outcome} — ${d.message || d.evidence || ''}**`;
  if (o.event === 'submit_tap_loop') return `- \`${t}\` [连点结束] 共 ${d.totalClicks} 下 · 最快 ${d.peakPerSec}/秒 · 弹窗补点 ${d.popupClicks} · 原因 ${d.endReason}${d.injectFails ? ' · 发不出去 ' + d.injectFails + ' 下' : ''}`;
  if (o.event === 'blind_fire') return `- \`${t}\` [到点盲点一发] 晚 ${d.deltaMs}ms · 方式 ${d.viaName || '-'}`;
  if (o.event === 'first_tap_sent') return `- \`${t}\` [首击已发出] 晚 ${d.deltaMs}ms · 方式 ${d.viaName || 'hub预置'} · 落点 (${d.x},${d.y})`;
  if (o.event === 'first_tap_failed') return `- \`${t}\` **[首击打不出去] ${d.why || ''}**`;
  if (o.event === 'popup_retry_click') return `- \`${t}\` [点弹窗] 第 ${d.n} 下 (${d.x},${d.y} via=${d.via})`;
  if (o.event === 'popup_first_seen') return `- \`${t}\` [首次发现「继续尝试」弹窗] 命中方式 ${d.via} · 落点 (${d.x},${d.y})${d.nodeText ? ' · 节点文字「' + d.nodeText + '」' : ''}`;
  if (o.event === 'captcha_seen') return `- \`${t}\` **[出现滑块验证码] 已停止连点, 剩下交给人工**`;
  if (o.event === 'agent_stopping') return `- \`${t}\` **[手机回报「我要退了」] 中枢已即时判定"已停止" (${d.reason || ''})**`;
  if (o.event === 'timesync_done') return `- \`${t}\` [对时] 手机比大麦 ${d.damaiOffsetMs >= 0 ? '快' : '慢'} ${Math.abs(d.damaiOffsetMs)}ms（来回 ${d.damaiRttMs}ms）${d.pageSellText ? ' · 页面开抢「' + d.pageSellText + '」' : ''}`;
  if (o.event === 'anchor_ok') return `- \`${t}\` [按钮位置锁定] (${d.x},${d.y}) · 来源 ${d.src} · 预约结构 ${String(d.presale || '').split(' ')[0]}`;
  if (o.event === 'grab_armed') return `- \`${t}\` [布防参数] 商品 ${d.itemId} · ${d.test ? '测试' : '正式'} · 盲点 ${d.blindFire ? '开' : '关'} · 双读 ${d.doubleReadMs}ms`;
  if (o.event === 'channel_probe') return `- \`${t}\` [通道预检] ${d.ok ? d.ms + 'ms 合格' : '不通'}${d.url ? ' · ' + d.url : ''}`;
  if (o.event === 'diag_saved') return `- \`${t}\` [现场证据] ${(d.files || []).map((f) => String(f).split(/[\\/]/).pop()).join(' + ')}`;
  if (o.event === 'selftest_result') return `- \`${t}\` [通道自测] 基线抖动 ${d.baselineChanges} 次 · 读取 ${d.readsPerSec}/秒 · 发现延迟 ${d.detectMs}ms`;
  if (o.event === 'watch_timeout') return `- \`${t}\` [盯梢超时] 等了 ${Math.round((d.waitedMs || 0) / 1000)}s 页面无变化, 未点击`;
  const parts = Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
  return `- \`${t}\` [${cn}] ${parts.slice(0, 200)}`;
}

/** 生成一次抢购的可读记录 (同时落盘 data/grab/digest/*.md), 返回 markdown 给控制台 */
function buildDigest({ taskId, sinceMs }) {
  const from = sinceMs > 0 ? sinceMs : (taskId ? 0 : Date.now() - 2 * 3600 * 1000);
  let raw = '';
  try { raw = fs.readFileSync(EVENTS_FILE, 'utf8'); } catch (e) { return { ok: false, error: '读不到事件文件: ' + e.message }; }
  const kept = [];
  let total = 0;
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    total++;
    let o; try { o = JSON.parse(ln); } catch (e) { continue; }
    if (DIGEST_SKIP.has(o.event)) continue;
    if (taskId) {
      // 该任务的事件 + 时间窗内的"人工/控制台操作"（后者没有 taskId）
      if (o.taskId !== taskId && !(o.event === 'console_op' && (o.at || 0) >= from)) continue;
    } else if ((o.at || 0) < from) continue;
    kept.push(o);
  }
  const out = [
    `# 抢购全程记录 · ${taskId || '（最近 2 小时全部）'}`,
    '',
    `- 导出时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `- 来源: \`data/grab/device-events.jsonl\`（共扫 ${total} 条, 取用 ${kept.length} 条）`,
    '- 读法: **【人工/控制台】** = 你在控制台/手机上手动做了什么; 其余 = 手机脚本自己做的事',
    '',
    '## 时间线',
    '',
  ];
  if (!kept.length) out.push('_(这个时间窗内没有任何记录)_');
  else out.push(...kept.map(digestLine));

  // 关键结论
  const first = kept.find((o) => o.event === 'first_tap_sent');
  const blind = kept.find((o) => o.event === 'blind_fire');
  const loop = kept.find((o) => o.event === 'submit_tap_loop');
  const res = [...kept].reverse().find((o) => o.event === 'task_result');
  const captcha = kept.some((o) => o.event === 'captcha_seen');
  const popupFirst = kept.find((o) => o.event === 'popup_first_seen');
  const popupClicks = kept.filter((o) => o.event === 'popup_retry_click').reduce((m, o) => Math.max(m, (o.detail || {}).n || 0), 0);
  out.push('', '## 关键结论', '');
  out.push(`- **首击**: ${first ? `发出, 比开抢时刻晚 ${first.detail.deltaMs}ms（方式 ${first.detail.viaName || 'hub预置'}）` : (blind ? '只打了"到点盲点"那一发' : '没有发出')}`);
  out.push(`- **到点盲点一发**: ${blind ? '打出了, 晚 ' + blind.detail.deltaMs + 'ms' : '未触发（开关关 / 或检测到页面变化先出手了）'}`);
  out.push(`- **连点链**: ${loop ? `${loop.detail.totalClicks} 下, 最快 ${loop.detail.peakPerSec} 下/秒, 弹窗补点 ${loop.detail.popupClicks} 下, 结束原因 ${loop.detail.endReason}` : '未进入'}`);
  out.push(`- **「继续尝试」弹窗**: ${popupFirst ? `本次探到并按了 ${popupClicks} 下` : '全程没探到（这条本身就是重要结论 —— 下次可据此判断它到底长什么样）'}`);
  out.push(`- **滑块验证码**: ${captcha ? '出现过（脚本已自动停止连点, 交给人工）' : '未出现'}`);
  out.push(`- **最终结果**: ${res ? `${res.detail.outcome} — ${res.detail.message || res.detail.evidence || ''}` : '没有结果记录（任务还在跑 / 未回传）'}`);

  const markdown = out.join('\n') + '\n';
  let file = null;
  try {
    const dir = path.join(GRAB_DIR, 'digest');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + (taskId || 'all') + '.md');
    fs.writeFileSync(file, markdown, 'utf8');
  } catch (e) { /* 落盘失败也把内容回给控制台 */ }
  return { ok: true, file, count: kept.length, markdown };
}

// 启动预热: 去重集 + 事件历史
if (fs.existsSync(RESULTS_FILE)) {
  try {
    for (const line of fs.readFileSync(RESULTS_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.taskId) processedResults.add(`${r.taskId}:${r.seq ?? 0}`);
    }
    log(`已载入历史结果去重记录 ${processedResults.size} 条`);
  } catch (e) { log('解析历史结果文件异常:', e.message); }
}
if (fs.existsSync(EVENTS_FILE)) {
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).slice(-80);
    for (const line of lines) {
      try { addRecentEvent(JSON.parse(line)); } catch {}
    }
  } catch (e) { log('解析历史事件异常:', e.message); }
}

/* ============ 配置与档案 ============ */
function loadDamaiConfig() {
  const file = fs.existsSync(CONFIG_FILE_ROOT) ? CONFIG_FILE_ROOT : CONFIG_FILE_GRAB;
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { log('读取配置失败:', e.message); }
  return null;
}
function saveDamaiConfig(cfg) {
  const str = JSON.stringify(cfg, null, 2);
  fs.writeFileSync(CONFIG_FILE_ROOT, str, 'utf8');
  fs.writeFileSync(CONFIG_FILE_GRAB, str, 'utf8');
  log('大麦抢购配置已更新落盘');
}
function loadDamaiCatalog() {
  try {
    if (fs.existsSync(CATALOG_FILE)) return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  } catch (e) {}
  return { items: [] };
}
function updateAccountProfileFromDeviceResult(data) {
  try {
    const profile = loadAccountProfile();
    let changed = false;
    if (data.data?.viewers && Array.isArray(data.data.viewers) && data.data.viewers.length > 0) {
      const existingMap = new Map();
      (profile.viewers || []).forEach(v => {
        if (v.idCard) existingMap.set(v.idCard, v.name);
        if (v.displayName) existingMap.set(v.displayName, v.name);
      });
      profile.viewers = data.data.viewers.map(v => ({
        ...v,
        name: existingMap.get(v.idCard) || existingMap.get(v.displayName) || v.name,
      }));
      changed = true;
    }
    if (data.data?.addresses && Array.isArray(data.data.addresses)) {
      profile.addresses = data.data.addresses;
      changed = true;
    }
    if (changed) {
      saveAccountProfile(profile);
      log(`[账号库自动同步] 观演人: ${profile.viewers?.length || 0}, 地址: ${profile.addresses?.length || 0}`);
    }
  } catch (e) { log('更新账号库异常:', e.message); }
}

/* ============ HTTP 辅助 ============ */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

/* ============ 任务派发 ============ */
function dispatchTask(task, targetDeviceId = null) {
  const deviceId = targetDeviceId || [...devices.keys()].find(id => {
    const dev = devices.get(id);
    return dev && (dev.state === 'idle' || !dev.state);
  }) || [...devices.keys()][0];
  if (!deviceId) throw new Error('当前无任何在线或注册的 Android 设备 (请先连接设备并启动手机端 Agent)');

  /* ★ 防重防堆积 (2026-10-10 修复"无限循环"): 设备 busy 时新任务会排队, 连点按钮 = 队列塞满,
   *  每条又是完整抢购流水线 (30~60s), 逐个执行看起来像无限循环。两条闸门:
   *  ① 排队上限: busy 且已排 ≥2 条 → 拒绝, 提示先停止
   *  ② 自测单飞: 上一个自测 120s 内未出结果 → 拒绝重复点击 */
  const devNow = devices.get(deviceId);
  const isBusy = devNow && devNow.state === 'busy';
  const pending = taskQueues.get(deviceId) || [];
  if (isBusy && pending.length >= 2) {
    throw new Error(`设备正忙且已有 ${pending.length} 个任务排队 — 请先「⛔ 停止」或等当前任务结束再下发 (防止任务堆积连跑)`);
  }
  if (task.mode === 'grab' && task.grab && task.grab.selfTest) {
    const dup = [...taskStates.values()].find((e) =>
      e.task && e.task.mode === 'grab' && e.task.grab && e.task.grab.selfTest && !e.result
      && (Date.now() - e.dispatchedAt) < 120000);
    if (dup) throw new Error('检测通道自测仍在执行 (运行或排队中), 请等本轮出结果再点');
  }

  addRecentEvent({
    deviceId,
    event: 'task_dispatched',
    detail: {
      taskId: task.taskId,
      mode: task.mode,
      target: task.target?.name,
      itemId: task.target?.itemId,
      grabMode: task.grab ? (task.grab.selfTest ? 'selftest' : task.grab.dryRun ? 'test' : 'live') : undefined,
      session: task.target?.session,
      price: task.target?.priceText,
      viewers: task.target?.viewers || [task.target?.viewer || ''],
      count: task.target?.count || 1,
    },
    receivedAt: new Date().toISOString(),
  });
  taskStates.set(task.taskId, {
    task,
    dispatchedAt: Date.now(),
    result: null,
    deviceId,
    cancelRequested: false,   // 用户已请求取消 (手机可能在下一个心跳取走)
    cancelledAt: null,
  });
  if (taskStates.size > 30) {
    const firstKey = taskStates.keys().next().value;
    taskStates.delete(firstKey);
  }

  if (waitingPolls.has(deviceId)) {
    const { res, timer } = waitingPolls.get(deviceId);
    clearTimeout(timer);
    waitingPolls.delete(deviceId);
    log(`[任务派发] 唤醒长轮询 -> 设备 ${deviceId}, 任务 ${task.taskId}`);
    sendJson(res, 200, { status: 'task', task });
    return { deviceId, dispatchedImmediately: true };
  }
  if (!taskQueues.has(deviceId)) taskQueues.set(deviceId, []);
  taskQueues.get(deviceId).push(task);
  log(`[任务入队] 设备 ${deviceId} 队列深度: ${taskQueues.get(deviceId).length}`);
  return { deviceId, dispatchedImmediately: false };
}

/**
 * 本地合成一条「已取消」结果 (任务未在手机端实际执行时使用)。
 * 若手机稍后仍上报该任务, 心跳会继续回带取消指令兜底; 真实结果到达时会覆盖本条。
 */
function settleCancelled(entry, taskId, evidence) {
  const record = {
    taskId,
    seq: 0, // 手机端真实结果 seq>=1, 0 不与去重集冲突
    deviceId: entry.deviceId || 'device',
    platform: entry.task?.platform || 'damai',
    outcome: 'cancelled',
    reason: 'manual_abort',
    evidence,
    receivedAt: new Date().toISOString(),
  };
  entry.result = record;
  addRecentEvent({ deviceId: entry.deviceId || 'device', event: 'task_result', detail: record, receivedAt: record.receivedAt });
  try { fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n'); } catch (e) {}
  log(`[任务取消] ${taskId} → 已取消 (${evidence})`);
}

/* ============ 一键设备连接 (核心流程) ============ */

/* ★ 手机上实际装的是哪个 AutoJs 系应用, 动态探测 (2026-10-10 修复):
 *   之前写死 org.autojs.autojs6 + Usher 服务类 —— 而用户手机装的是 AutoX.js v7
 *   (org.autojs.autoxjs.v7 / com.stardust.autojs...AccessibilityService)。
 *   后果: am start 拉不起 → 一键连接失败; settings put 写入**不存在的组件** →
 *   整个 enabled_accessibility_services 列表被覆盖 → 无障碍被"关"。 */
const AUTOJS_CANDIDATES = [
  { pkg: 'org.autojs.autoxjs.v7', acc: 'com.stardust.autojs.core.accessibility.AccessibilityService', launch: 'org.autojs.autojs.external.open.RunIntentActivity', name: 'AutoX.js v7' },
  { pkg: 'org.autojs.autojs6', acc: 'org.autojs.autojs.core.accessibility.AccessibilityServiceUsher', launch: 'org.autojs.autojs.external.open.RunIntentActivity', name: 'AutoJs6' },
  { pkg: 'org.autojs.autoxjs', acc: 'com.stardust.autojs.core.accessibility.AccessibilityService', launch: 'org.autojs.autojs.external.open.RunIntentActivity', name: 'AutoX.js v6' },
  { pkg: 'com.stardust.autojs', acc: 'com.stardust.autojs.core.accessibility.AccessibilityService', launch: 'org.autojs.autojs.external.open.RunIntentActivity', name: 'AutoX.js' },
];

async function detectAutoJs(serial) {
  for (const c of AUTOJS_CANDIDATES) {
    try {
      const out = runAdb(`adb -s ${serial} shell pm list packages ${c.pkg}`, 3000) || '';
      if (out.includes(`package:${c.pkg}`)) return c;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

let connectFlowBusy = false;   // 互斥: 手动一键连接 / 更新脚本 / USB 自动连接 不允许并发跑

async function connectDeviceFlow(options = {}) {
  // 手动触发: 等自动流程跑完再上 (最多 20s); 自动触发: 忙时直接让路
  if (connectFlowBusy) {
    if (options.auto) return { ok: false, steps: [], error: '连接流程执行中, 自动连接让路' };
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (!connectFlowBusy) break;
    }
    if (connectFlowBusy) return { ok: false, steps: [], error: '上一次连接流程仍在执行, 请稍候再试' };
  }
  connectFlowBusy = true;
  try {
    return await connectDeviceFlowInner(options);
  } finally {
    connectFlowBusy = false;
  }
}

async function connectDeviceFlowInner(options = {}) {
  const steps = [];
  const step = (name, ok, detail = '') => {
    steps.push({ name, ok, detail });
    log(`[一键连接] ${ok ? '✅' : '❌'} ${name}${detail ? ': ' + detail : ''}`);
    return ok;
  };

  // 1. ADB 设备检测
  const adbList = scanAdbDevices();
  if (!step('检测 USB 设备', adbList.length > 0, adbList.length ? `${adbList[0].model} (${adbList[0].serial})` : '未检测到 USB 设备, 请检查数据线与 USB 调试')) {
    return { ok: false, steps, error: '未检测到 USB 连接的 Android 设备' };
  }
  const serial = adbList[0].serial;

  // 1.5 探测实际安装的自动化应用 —— **探测失败不拦路**: 部分厂商 shell 对管道输出有怪癖
  //     (本机实证: vivo 的 pm list packages 管道会丢内容, 但 pm path 查得到) → 回退默认 AutoJs6
  let app = await detectAutoJs(serial);
  if (app) {
    step('检测自动化应用', true, `${app.name} (${app.pkg})`);
  } else {
    app = AUTOJS_CANDIDATES[0];
    step('检测自动化应用', true, `未探测到 (厂商 shell 输出怪癖?) → 按默认 ${app.name} 继续, 拉起失败会自动换备选`);
  }

  // 2. 端口反向代理
  try {
    runAdb(`adb -s ${serial} reverse tcp:${PORT} tcp:${PORT}`, 2000);
    step('建立 USB 端口代理', true, `tcp:${PORT} <-> tcp:${PORT}`);
  } catch (e) {
    step('建立 USB 端口代理', false, e.message);
  }

  // 3. 写入 hub.conf (USB + 最新局域网 IP)
  try {
    const lan = primaryLanIp();
    runAdb(`adb -s ${serial} shell "mkdir -p /sdcard/qg-agent"`, 2000);
    runAdb(`adb -s ${serial} shell "printf 'http://127.0.0.1:${PORT}\\nhttp://${lan}:${PORT}\\n' > /sdcard/qg-agent/hub.conf"`, 2000);
    step('写入通信配置 hub.conf', true, `127.0.0.1 + ${lan}`);
  } catch (e) {
    step('写入通信配置 hub.conf', false, e.message);
  }

  // 4. 推送区划数据 (缺则自动生成)
  try {
    if (!fs.existsSync(REGIONS_FILE)) await generateRegionsFile();
    if (fs.existsSync(REGIONS_FILE)) {
      runAdb(`adb -s ${serial} push "${REGIONS_FILE}" /sdcard/qg-agent/regions.json`, 4000);
      step('推送省市区数据集 regions.json', true);
    }
  } catch (e) {
    step('推送省市区数据集 regions.json', false, e.message);
  }

  // 5. 推送 Agent 脚本
  try {
    runAdb(`adb -s ${serial} push "${AGENT_SCRIPT}" /sdcard/qg-agent/main.js`, 6000);
    step('推送 Agent 脚本 main.js', true, `${(fs.statSync(AGENT_SCRIPT).size / 1024).toFixed(1)} KB`);
  } catch (e) {
    return { ok: false, steps, error: '推送脚本失败: ' + e.message };
  }

  // 6. 拉起 Agent (仅在 Agent 不在线时) —— ★ **绝不 force-stop 应用、绝不碰无障碍**。
  //    实证: vivo 会在应用被 force-stop 时主动关掉其无障碍授权, 写回设置也救不回来。
  //    更新脚本的重启改由 Agent 自己换引擎 (见 /api/device/update-script 的 restartAgent 指令)。
  const agentWasOnline = [...devices.values()].some(d => Date.now() - d.lastSeen < 20000);
  if (!agentWasOnline) {
    let launched = null;
    for (const cand of AUTOJS_CANDIDATES) {
      try {
        const out = runAdb(`adb -s ${serial} shell am start -n ${cand.pkg}/${cand.launch} -a android.intent.action.VIEW -d "file:///sdcard/qg-agent/main.js" -t "application/x-javascript"`, 4000) || '';
        if (/Error|does not exist|not found|Exception/i.test(out)) continue;
        launched = cand;
        break;
      } catch (e) { /* 试下一个 */ }
    }
    if (!step(`拉起 ${launched ? launched.name : '自动化应用'} 运行 Agent`, !!launched, launched ? launched.pkg : '全部候选都拉起失败')) {
      return { ok: false, steps, error: '无法启动手机端脚本 (请确认手机已安装 AutoJs6/AutoX)' };
    }
  } else {
    step('Agent 已在线', true, '跳过拉起 (非破坏式连接, 不打断在跑的任务, 全程不触碰无障碍)');
  }

  // 8. 等待 Agent 注册上线 (最长 15s)
  const t0 = Date.now();
  let online = false;
  while (Date.now() - t0 < 15000) {
    for (const d of devices.values()) {
      if (d.registeredAt >= t0 - 2000 || d.lastSeen > t0) { online = true; break; }
    }
    if (online) break;
    await sleep(500);
  }
  step('Agent 注册上线', online, online ? '手机已连接控制台' : '15 秒内未收到 Agent 上线心跳');

  return { ok: online, steps, error: online ? null : 'Agent 未能上线 (可能无障碍服务未授权, 请在手机上检查)' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generateRegionsFile() {
  const { provinces, cities, areas } = await import('china-division');
  const byProv = new Map(), byCity = new Map();
  for (const c of cities) {
    if (!byProv.has(c.provinceCode)) byProv.set(c.provinceCode, []);
    byProv.get(c.provinceCode).push(c);
  }
  for (const a of areas) {
    if (!byCity.has(a.cityCode)) byCity.set(a.cityCode, []);
    byCity.get(a.cityCode).push(a);
  }
  const tree = provinces.map(p => [p.name, (byProv.get(p.code) || []).map(c => [c.name, (byCity.get(c.code) || []).map(a => a.name)])]);
  fs.writeFileSync(REGIONS_FILE, JSON.stringify(tree));
  log(`[区划数据] 已生成 regions.json (${tree.length} 省级单位)`);
}

/* ---- 打开商品页: 入参/白名单闸门 (副作用之前, USB 与 WiFi 通道共用) ---- */
function openItemGate(itemId) {
  if (!/^\d{6,}$/.test(itemId)) return { ok: false, status: 400, error: 'itemId 必须为纯数字' };
  const cat = loadDamaiCatalog();
  const inCatalog = !!(cat && Array.isArray(cat.items) && cat.items.some((it) =>
    String(it.itemId) === itemId ||
    (Array.isArray(it.stations) && it.stations.some((s) => String(s.itemId) === itemId))));
  if (!inCatalog) return { ok: false, status: 403, error: '该商品不在探针库白名单内, 请先「补采此商品」' };
  return { ok: true };
}

/* ============ 打开商品页 (USB/ADB 通道实现; WiFi 通道由手机本地 deep-link 兜底) ============
 * 2026-10-09: 从 /api/adb/open-item 抽出来, 供统一入口 /api/phone/cmd 复用。 */
async function openItemViaAdb(itemId) {
  const g = openItemGate(itemId);
  if (!g.ok) return { ok: false, status: g.status, error: g.error };
  const adbList = scanAdbDevices();
  if (!adbList.length) return { ok: false, status: 503, needUsb: true, error: '中枢当前没有 USB 设备 (adb 不可用)' };
  const serial = adbList[0].serial;
  const variants = [
    { name: 'damai://detail', cmd: `am start -a android.intent.action.VIEW -d 'damai://detail' --es itemId ${itemId} -p cn.damai` },
    { name: 'damai://trade/detail', cmd: `am start -a android.intent.action.VIEW -d 'damai://trade/detail' --es itemId ${itemId} -p cn.damai` },
    { name: 'damai://projectdetail', cmd: `am start -a android.intent.action.VIEW -d 'damai://projectdetail' --es itemId ${itemId} -p cn.damai` },
    { name: 'https://m.damai.cn/damai/perform/item.html', cmd: `am start -a android.intent.action.VIEW -d 'https://m.damai.cn/damai/perform/item.html?itemId=${itemId}' -p cn.damai` },
    { name: 'PRO_DETAIL', cmd: `am start -a cn.damai.intent.action.PRO_DETAIL --es itemId ${itemId} -p cn.damai` },
  ];
  const tried = [];
  for (const v of variants) {
    tried.push(v.name);
    let out = '';
    try { out = runAdb(`adb -s ${serial} shell "${v.cmd}"`, 4000) || ''; } catch (e) { out = String(e.stdout || e.message || e); }
    if (!/Starting:/.test(out)) continue;
    await new Promise((r) => setTimeout(r, 1300));
    let top = '';
    try { top = runAdb(`adb -s ${serial} shell "dumpsys activity activities | grep -m2 ResumedActivity"`, 4000) || ''; } catch (e) { top = ''; }
    if (top.includes('ProjectDetailActivity')) {
      ensureAdbShell(serial); // 顺手预热常驻通道 (给首击提速)
      return { ok: true, hit: v.name, tried, via: 'usb' };
    }
  }
  return { ok: false, status: 500, tried, via: 'usb', error: '所有 deep-link 变体都未能落到详情页' };
}

/* ============ HTTP 服务 ============ */
const server = http.createServer(async (req, res) => {
  const clientIp = req.socket.remoteAddress || '';
  const isLoopback = clientIp.includes('127.0.0.1') || clientIp === '::1';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  /* ---- 基础 ---- */
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok', service: 'device-hub',
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      onlineDevices: devices.size,
      lanIps: getLocalIps(),
      serverTime: Date.now(),
    });
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    let hubAgentScriptSize = 0;
    try { hubAgentScriptSize = fs.statSync(AGENT_SCRIPT).size; } catch (eS) { /* 忽略 */ }
    return sendJson(res, 200, {
      uptimeSec: Math.floor(process.uptime()),
      onlineDevices: [...devices.values()].map(d => ({ ...d, isAlive: (Date.now() - d.lastSeen < 15000) && !d.stoppingAt })),
      lanIps: getLocalIps(),
      hubAgentScriptSize,   // 电脑端 main.js 体积: 与设备上报的 scriptSize 对账即可判断"手机脚本是否最新"
      serverTime: Date.now(),
    });
  }

  /* ---- 设备通信 ---- */
  if (pathname === '/api/device/hello' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const deviceId = data.deviceId || `dev-${Math.random().toString(36).slice(2, 8)}`;
      const connMode = isLoopback ? 'USB (adb reverse)' : `Wi-Fi (${clientIp})`;
      devices.set(deviceId, {
        ...data, deviceId, clientIp, connectionMode: connMode,
        state: 'idle', lastSeen: Date.now(), registeredAt: Date.now(),
      });
      log(`[设备上线] ${deviceId} [${connMode}] 分辨率:${JSON.stringify(data.screen || [])} 电量:${data.battery ?? '?'}%`);
      return sendJson(res, 200, { status: 'registered', deviceId, connectionMode: connMode, serverTime: Date.now(), channel: resolveChannel(deviceId) });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/device/heartbeat' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      if (!data.deviceId) return sendJson(res, 400, { error: '缺少 deviceId' });
      // ★ 2026-10-10: 中枢重启后设备表是空的, 而手机只在**脚本启动时**发一次 hello →
      //   分辨率/版本号/运行时等"注册时才有"的字段会一直空着, 控制台就会误报"版本号未上报(旧脚本)"。
      //   这里告诉手机"我还不认识你", 它收到会立刻补发 hello 重新注册。
      const registeredBefore = devices.has(data.deviceId);
      const dev = devices.get(data.deviceId) || {
        deviceId: data.deviceId, registeredAt: Date.now(),
        clientIp: isLoopback ? '127.0.0.1' : clientIp,
        connectionMode: isLoopback ? 'USB (adb reverse)' : `Wi-Fi (${clientIp})`,
      };
      if (!registeredBefore) log(`[重新注册] 中枢不认识 ${data.deviceId} (刚重启?) → 已通知手机补发 hello`);
      dev.lastSeen = Date.now();
      dev.state = data.state || dev.state || 'idle';
      dev.battery = data.battery ?? dev.battery;
      dev.charging = data.charging ?? dev.charging;
      dev.accessibility = data.accessibility ?? dev.accessibility;
      if (data.agentVersion) dev.agentVersion = String(data.agentVersion).slice(0, 20);   // ★ 心跳也带版本号, 不再只依赖 hello
      if (data.shizuku) dev.shizuku = data.shizuku;   // 手机自主点击能力 (Shizuku 本地注入) 状态随心跳更新
      dev.currentTaskId = data.taskId ?? null;
      if (Number.isFinite(Number(data.scriptSize))) dev.scriptSize = Number(data.scriptSize);
      devices.set(data.deviceId, dev);

      // 取消指令捎带: 手机执行任务期间唯一可靠的下行通道 (执行时接收任务的长轮询是被堵住的)
      // 只认「手机当前正在上报的任务」→ 用户取消过的任务一旦出现在心跳里, 直到结果回来前持续回带
      let control = null;
      const pushControl = (patch) => { control = Object.assign(control || {}, patch); };
      if (dev.currentTaskId) {
        const ts = taskStates.get(dev.currentTaskId);
        if (ts && ts.cancelRequested) {
          pushControl({ cancelTaskId: dev.currentTaskId });
          if (!ts.cancelControlLogged) {
            ts.cancelControlLogged = true;
            log(`[任务取消] 心跳回带取消指令 → 设备 ${data.deviceId} 任务 ${dev.currentTaskId}`);
          }
        }
        // 兜底: 任务记录可能已被清理(只留最近 30 条), 但手机还在跑 → 仍要能撤掉
        // (2026-10-09 实测踩到: 一条测试任务被清理后撤不掉, 手机一直占着 busy)
        if (!control && deviceCancelOverride.get(data.deviceId) === dev.currentTaskId) {
          pushControl({ cancelTaskId: dev.currentTaskId });
          log(`[任务取消] 兜底回带 → 设备 ${data.deviceId} 任务 ${dev.currentTaskId} (原任务记录已清理)`);
        }
      } else if (deviceCancelOverride.has(data.deviceId)) {
        deviceCancelOverride.delete(data.deviceId);   // 设备空了, 兜底标记作废
      }
      // ★ 停止复探 (2026-10-10 用户口径): 手机回报过"我要退了", 可它还在发心跳 (>3 秒宽限) ⇒ 停止没生效, 撤回标记
      if (dev.stopConfirmedAt && Date.now() - dev.stopConfirmedAt > 3000) {
        discardStopMark(dev, '回报停止后仍在发心跳');
      }
      // 停止指令下了却没等来"退场告知", 且脚本还活着 ⇒ 重新下发 (最多 3 次)
      if (!dev.stoppingAt && dev.stopPushedAt && !dev.stopRequested
          && Date.now() - dev.stopPushedAt > 10000 && (dev.stopPushCount || 0) < 3) {
        dev.stopRequested = true;
        dev.stopPushedAt = Date.now();
        dev.stopPushCount = (dev.stopPushCount || 0) + 1;
        log(`[停止指令] ⚠ 设备 ${data.deviceId} 10 秒未回报"退场" → 重新下发 (第 ${dev.stopPushCount} 次)`);
      }
      // 停止手机端脚本 / 局域网自更新: 一次性下发, 发过即清
      if (dev.stopRequested) {
        pushControl({ stopAgent: true });
        dev.stopRequested = false;
        dev.stopPushedAt = Date.now();
        log(`[停止指令] 已下发「停止脚本」→ 设备 ${data.deviceId}`);
      }
      if (dev.selfUpdateRequested) {
        pushControl({ selfUpdate: true });
        dev.selfUpdateRequested = false;
        log(`[自更新] 已下发「更新脚本」→ 设备 ${data.deviceId}`);
      }
      if (dev.restartRequested) {
        // USB 更新脚本后的自重启: Agent 自己换引擎加载新脚本 (不 force-stop 应用 → 不碰无障碍)
        pushControl({ restartAgent: true });
        dev.restartRequested = false;
        log(`[自重启] 已下发「重启引擎」→ 设备 ${data.deviceId}`);
      }
      // ★ 心跳回带当前通道: 手机据此决定 ADB 类操作是打中枢还是走本地 (避免 WiFi 下白等超时)
      const ch = resolveChannel(data.deviceId);
      return sendJson(res, 200, {
        status: 'ok', serverTime: Date.now(), channel: ch,
        registered: registeredBefore,   // false = 中枢刚重启/还没这台设备的注册信息 → 手机会立刻补发 hello
        ...(control ? { control } : {}),
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/device/poll-task' && req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) return sendJson(res, 400, { error: '缺少 deviceId' });
    if (devices.has(deviceId)) {
      const d0 = devices.get(deviceId);
      d0.lastSeen = Date.now();
      // ★ 停止复探 (同心跳): 手机回报过"我要退了"却还在轮询任务 → 停止没生效, 撤回标记
      if (d0.stopConfirmedAt && Date.now() - d0.stopConfirmedAt > 3000) discardStopMark(d0, '回报停止后仍在轮询任务');
    }

    const queue = taskQueues.get(deviceId);
    if (queue && queue.length > 0) {
      const task = queue.shift();
      log(`[立即下发] 队列任务 -> ${deviceId} -> ${task.taskId}`);
      return sendJson(res, 200, { status: 'task', task });
    }
    const timer = setTimeout(() => {
      waitingPolls.delete(deviceId);
      sendJson(res, 200, { status: 'idle', serverTime: Date.now() });
    }, 25000);
    if (waitingPolls.has(deviceId)) clearTimeout(waitingPolls.get(deviceId).timer);
    waitingPolls.set(deviceId, { res, timer });
    req.on('close', () => {
      if (waitingPolls.has(deviceId) && waitingPolls.get(deviceId).res === res) {
        clearTimeout(timer);
        waitingPolls.delete(deviceId);
      }
    });
    return;
  }

  if (pathname === '/api/device/event' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const record = { ...data, receivedAt: new Date().toISOString() };
      addRecentEvent(record);
      try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(record) + '\n'); } catch (e) {}
      return sendJson(res, 200, { status: 'ok' });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ---- 事件流 (游标式) ---- */
  if (pathname === '/api/events' && req.method === 'GET') {
    const sinceMs = Number(url.searchParams.get('sinceMs') || 0);
    const limit = Number(url.searchParams.get('limit') || 100);
    const minMs = Math.max(sinceMs, eventsClearedAt);
    const evts = recentEvents.filter(e => (e.at || 0) > minMs).slice(-limit);
    return sendJson(res, 200, { events: evts, clearedAt: eventsClearedAt, serverTime: Date.now() });
  }

  if (pathname === '/api/events/clear' && req.method === 'POST') {
    eventsClearedAt = Date.now();
    recentEvents.length = 0;
    log('[事件清空] 控制台日志已清空 (水位: ' + eventsClearedAt + ')');
    return sendJson(res, 200, { status: 'ok', clearedAt: eventsClearedAt });
  }

  /* ---- 控制台本页操作落盘 (2026-10-10): 只追加到 events 文件, **不回灌事件环**（否则控制台会重复显示一遍） ---- */
  if (pathname === '/api/events/console' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const rec = {
        event: 'console_op',
        at: Number(body.at) || Date.now(),
        taskId: body.taskId ? String(body.taskId) : null,
        detail: { tag: String(body.tag || '[操作]').slice(0, 24), msg: String(body.msg || '').slice(0, 400) },
        receivedAt: new Date().toISOString(),
      };
      try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(rec) + '\n'); } catch (e) {}
      return sendJson(res, 200, { status: 'ok' });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  /* ---- 抢购全程记录导出 (2026-10-10): 事件文件 → 人话 Markdown（含人工操作）, 落盘 data/grab/digest/ ---- */
  if (pathname === '/api/record/digest' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const r = buildDigest({ taskId: String(body.taskId || '').trim(), sinceMs: Number(body.sinceMs || 0) || 0 });
      if (r.ok) log(`[记录导出] ${r.count} 条 → ${r.file || '(未落盘)'}`);
      return sendJson(res, r.ok ? 200 : 500, r);
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  /* ---- 任务结果 ---- */
  if (pathname === '/api/device/result' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const dedupeKey = `${data.taskId}:${data.seq ?? 0}`;
      if (processedResults.has(dedupeKey)) {
        log(`[结果去重] 忽略重复上报 ${dedupeKey}`);
        return sendJson(res, 200, { status: 'ack', deduplicated: true });
      }
      processedResults.add(dedupeKey);
      const record = { ...data, receivedAt: new Date().toISOString() };
      const ts = taskStates.get(data.taskId);
      if (ts) {
        // 真实结果优先: 覆盖本地合成的取消记录; 并停止心跳回带取消指令
        if (ts.cancelRequested && data.outcome !== 'cancelled') {
          log(`[任务取消] ${data.taskId} 在取消请求后仍收到真实结果 (outcome=${data.outcome}), 以真实结果为准`);
          record.cancelRequestedEarlier = true;
        }
        ts.result = record;
        ts.cancelRequested = false;
      }
      addRecentEvent({
        deviceId: data.deviceId || 'device',
        event: 'task_result',
        detail: record,
        receivedAt: record.receivedAt,
      });
      try { fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n'); } catch (e) {}
      log(`[结果落盘] 任务 ${data.taskId}: ${data.outcome} | ${data.evidence || data.message || ''}`);

      updateAccountProfileFromDeviceResult(data);
      return sendJson(res, 200, { status: 'ack', recorded: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ---- 任务状态 ---- */
  if (pathname === '/api/tasks/state' && req.method === 'GET') {
    const list = [...taskStates.entries()].slice(-20).reverse().map(([id, s]) => ({
      taskId: id,
      mode: s.task?.mode,
      target: s.task?.target?.name,
      viewers: s.task?.target?.viewers,
      count: s.task?.target?.count,
      dispatchedAt: s.dispatchedAt,
      cancelRequested: !!s.cancelRequested,
      result: s.result ? {
        outcome: s.result.outcome,
        message: s.result.message || s.result.evidence,
        evidence: s.result.evidence,
        reason: s.result.reason,
        receivedAt: s.result.receivedAt,
      } : null,
    }));
    return sendJson(res, 200, { tasks: list, serverTime: Date.now() });
  }

  /* ---- 任务手动终止 (控制台「最近任务」的 ⛔ 按钮) ---- */
  if (pathname === '/api/tasks/cancel' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const taskId = String(body.taskId || '').trim();
      if (!taskId) return sendJson(res, 400, { error: '缺少 taskId' });
      const entry = taskStates.get(taskId);
      if (!entry) {
        // 兜底: 任务记录已被清理(只留最近 30 条), 但手机可能还在跑它 → 记一条"按设备撤销"的标记,
        // 由下一次心跳回带 cancelTaskId (2026-10-09 补: 原先这里直接 404, 导致跑着的任务撤不掉)
        const devId = String(body.deviceId || '').trim();
        let target = null;
        for (const [id, dev] of devices) {
          if (dev.currentTaskId === taskId && (!devId || id === devId)) { target = id; break; }
        }
        if (!target) return sendJson(res, 404, { error: '未找到该任务 (可能已被清理, 且没有设备在跑它)' });
        deviceCancelOverride.set(target, taskId);
        addRecentEvent({
          deviceId: target,
          event: 'task_cancel_requested',
          detail: { taskId, via: 'device-override', note: '任务记录已清理, 按设备兜底撤销' },
          receivedAt: new Date().toISOString(),
        });
        log(`[任务取消] 兜底登记 → 设备 ${target} 任务 ${taskId} (记录已清理)`);
        return sendJson(res, 200, { status: 'cancelling', scope: 'device-override', deviceId: target, taskId });
      }
      if (entry.result) return sendJson(res, 200, { status: 'already_done', taskId });
      if (entry.cancelRequested) return sendJson(res, 200, { status: 'already_cancelling', taskId });

      entry.cancelRequested = true;
      entry.cancelledAt = Date.now();
      // ★ 同步撤掉以该任务 tag 预置的击发 (彩排 armTap 把首击排在中枢时钟上,
      //   任务取消后那一发若不撤, 到点仍会打出去 —— 2026-10-10 修复)
      const armedT = armedTaps.get(taskId);
      if (armedT) {
        clearTimeout(armedT);
        armedTaps.delete(taskId);
        log(`[任务取消] 已撤销预置击发 ${taskId} (到点不再出膛)`);
      }
      addRecentEvent({
        deviceId: entry.deviceId || 'device',
        event: 'task_cancel_requested',
        detail: { taskId, mode: entry.task?.mode, target: entry.task?.target?.name },
        receivedAt: new Date().toISOString(),
      });

      // ① 还在队列里 (没下发) → 直接摘除并本地合成取消结果
      const q = taskQueues.get(entry.deviceId);
      if (q) {
        const idx = q.findIndex(t => t.taskId === taskId);
        if (idx >= 0) {
          q.splice(idx, 1);
          settleCancelled(entry, taskId, '任务尚未下发, 已在队列中取消');
          return sendJson(res, 200, { status: 'cancelled', scope: 'queued', taskId });
        }
      }

      // ② 手机此刻正实时执行它 → 等心跳回带取消指令 (最坏一个心跳周期)
      const dev = entry.deviceId ? devices.get(entry.deviceId) : null;
      const devAlive = dev && (Date.now() - dev.lastSeen < 15000);
      const running = devAlive && dev.currentTaskId === taskId;
      if (running) {
        log(`[任务取消] ${taskId} 已请求取消 (设备正在执行, 等待手机心跳取走指令)`);
        return sendJson(res, 200, { status: 'cancelling', scope: 'running', taskId });
      }

      // ③ 其他情况 (设备离线 / 空闲 / 心跳滞后): 本地立即标记取消;
      //    若手机稍后仍上报此任务, 心跳会继续回带取消指令兜底, 真实结果到达时以真实结果为准
      settleCancelled(entry, taskId, '设备当前未执行该任务, 已直接标记取消');
      return sendJson(res, 200, { status: 'cancelled', scope: 'local', taskId });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ---- 设备列表 (ADB + Agent 融合) ---- */
  if (pathname === '/api/devices' && req.method === 'GET') {
    const isLoopbackIp = ip => String(ip || '').includes('127.0.0.1') || String(ip || '') === '::1';
    const adbList = scanAdbDevices();
    const httpList = [...devices.values()];
    const mergedList = [];
    const matchedSerials = new Set();
    for (const d of httpList) {
      // ★ isAlive = "Agent(脚本) 真的在跑": 心跳新鲜 且 没被按过停止。
      //   以前这里在"USB 线插着"时会强制 isAlive=true —— 于是点了停止脚本后,
      //   只要数据线还插着, 控制台就永远显示"在线"、还能下发任务。现在拆成两个概念:
      //   isAlive = 脚本在跑;  usbAttached = 数据线插着 (两者独立)。
      const isAlive = (Date.now() - d.lastSeen < 20000) && !d.stoppingAt;
      const matchedAdb = adbList.find(a => d.deviceId.includes(a.serial) || isLoopbackIp(d.clientIp));
      if (matchedAdb) {
        matchedSerials.add(matchedAdb.serial);
        mergedList.push({ ...d, isAlive, usbAttached: true, model: matchedAdb.model || d.model });
      } else {
        mergedList.push({ ...d, isAlive, usbAttached: false });
      }
    }
    for (const a of adbList) {
      if (!matchedSerials.has(a.serial)) {
        mergedList.push({
          deviceId: `${a.model} (${a.serial})`, serial: a.serial, model: a.model,
          connectionMode: 'USB 已连接 (Agent 未运行)',
          state: 'usb-only', lastSeen: Date.now(), isAlive: true, isAdbOnly: true,
        });
      }
    }
    let hubAgentScriptSize = 0;
    try { hubAgentScriptSize = fs.statSync(AGENT_SCRIPT).size; } catch (eS) { /* 忽略 */ }
    return sendJson(res, 200, {
      devices: mergedList,
      adbDevicesCount: adbList.length,
      httpAgentsCount: httpList.length,
      hubAgentScriptSize,
      channel: resolveChannel(),   // ★ 统一通道: 控制台按它决定按钮走 USB 还是 WiFi
    });
  }

  /* ---- ADB 触摸注入 (Agent 手势失效时的可靠兜底通道) ---- */
  if (pathname === '/api/adb/tap' && req.method === 'POST') {
    try {
      const { x, y } = await readJsonBody(req);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return sendJson(res, 400, { error: '缺少 x/y' });
      const adbList = scanAdbDevices();
      if (!adbList.length) return sendJson(res, 503, { error: '此操作需要 USB 数据线（ADB input 注入）', needUsb: true, mode: resolveChannel().mode });
      // 优先走常驻 shell (≈29ms/次), 失败回落 spawn 通道 (≈210ms/次)
      if (adbWriteLines([`input tap ${Math.round(x)} ${Math.round(y)}`])) {
        return sendJson(res, 200, { status: 'ok', via: 'persist' });
      }
      runAdb(`adb -s ${adbList[0].serial} shell input tap ${Math.round(x)} ${Math.round(y)}`, 2500);
      return sendJson(res, 200, { status: 'ok', via: 'exec' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  /* ---- 诊断快照 (兜底闸门触发时留证据: 界面树 + 截图; 只为事后复盘"为什么没识别到") ---- */
  if (pathname === '/api/adb/diag-snapshot' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const tag = (String(body.tag || 'diag').replace(/[^\w.-]/g, '_').slice(0, 40)) || 'diag';
      const adbList = scanAdbDevices();
      if (!adbList.length) return sendJson(res, 503, { error: '取证快照需要 USB 数据线（uiautomator dump + screencap 只能走 ADB）', needUsb: true, mode: resolveChannel().mode });
      const serial = adbList[0].serial;
      const dir = path.join(GRAB_DIR, 'diag');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = path.join(dir, `${stamp}-${tag}`);
      const out = { tag, files: [] };
      // ① 界面树 (文字证据: 哪些节点在/不在)
      try {
        runAdb(`"${ADB_BIN}" -s ${serial} shell uiautomator dump /sdcard/qg-diag.xml`, 8000);
        const xml = runAdb(`"${ADB_BIN}" -s ${serial} exec-out cat /sdcard/qg-diag.xml`, 8000);
        if (xml && xml.length > 200) { fs.writeFileSync(base + '.xml', xml, 'utf8'); out.files.push(base + '.xml'); }
        else out.dumpError = 'dump 内容为空';
      } catch (e1) { out.dumpError = e1.message; }
      // ② 截图 (二进制: 走 shell 重定向, 避免 utf8 编码把 PNG 破坏)
      try {
        execSync(`"${ADB_BIN}" -s ${serial} exec-out screencap -p > "${base}.png"`, { timeout: 15000, stdio: 'pipe', windowsHide: true });
        if (fs.existsSync(base + '.png') && fs.statSync(base + '.png').size > 1000) out.files.push(base + '.png');
      } catch (e2) { out.shotError = e2.message; }
      log(`[诊断快照] ${tag} → ${out.files.map((f) => path.basename(f)).join(', ') || '无'}${out.dumpError ? ' (dump: ' + out.dumpError + ')' : ''}`);
      return sendJson(res, 200, { status: 'ok', ...out });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  /* ---- 抢购保活优化 (开关 + 一键恢复原状) —— USB 独占 (依赖 adb shell) ---- */
  if (pathname === '/api/device/perf-boost' && req.method === 'GET') {
    const ch = resolveChannel();
    if (!ch.usb) return sendJson(res, 200, {
      status: 'unavailable', needUsb: true, mode: ch.mode, channel: ch, steps: [],
      error: '保活优化需要 USB 数据线（电池白名单 / 后台运行 / 活动桶 / 插电常亮都只能走 adb shell）',
    });
    try { return sendJson(res, 200, { status: 'ok', channel: ch, ...perfBoostStatus() }); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (pathname === '/api/device/perf-boost' && req.method === 'POST') {
    const ch = resolveChannel();
    if (!ch.usb) return sendJson(res, 409, {
      status: 'unavailable', needUsb: true, mode: ch.mode, channel: ch,
      error: '保活优化需要 USB 数据线（依赖 adb shell，WiFi 通道做不到）',
    });
    try {
      const body = await readJsonBody(req);
      const on = !!body.on;
      const r = on ? perfBoostOn() : perfBoostOff();
      return sendJson(res, 200, { status: 'ok', on, channel: ch, ...r });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  /* ---- 计划击发: 把 T0 首击排到中枢时钟上 (避开到点那一瞬的网络抖动) ---- */
  if (pathname === '/api/adb/arm-tap' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const x = Number(body.x), y = Number(body.y), atMs = Number(body.atMs);
      const tag = String(body.tag || 'arm');
      if (!Number.isFinite(x) || !Number.isFinite(y)) return sendJson(res, 400, { error: '缺少 x/y' });
      if (!Number.isFinite(atMs)) return sendJson(res, 400, { error: '缺少 atMs (中枢时钟毫秒)' });
      const ch = resolveChannel();
      if (!ch.usb) return sendJson(res, 503, { error: '中枢预置击发需要 USB 数据线（走常驻 adb shell，3ms 级）；WiFi 通道请用手机本地击发', needUsb: true, mode: ch.mode, channel: ch });
      if (atMs - Date.now() < -2000) return sendJson(res, 400, { error: '开抢时刻已过 2 秒以上, 拒绝预置' });
      const r = armTapStrike({ tag, x, y, atMs });
      return sendJson(res, 200, { status: 'armed', tag, ...r, hubNow: Date.now() });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (pathname === '/api/adb/disarm-tap' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const tag = String(body.tag || '');
      const t = armedTaps.get(tag);
      if (t) { clearTimeout(t); armedTaps.delete(tag); }
      return sendJson(res, 200, { status: t ? 'disarmed' : 'not-armed', tag });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (pathname === '/api/adb/arm-status' && req.method === 'GET') {
    const tag = String(url.searchParams.get('tag') || '');
    const results = {};
    for (const [k, v] of armResults) if (!tag || k === tag) results[k] = v;
    return sendJson(res, 200, { hubNow: Date.now(), pending: [...armedTaps.keys()], results });
  }

  /* ---- 连发点击 (grab 连点链/提交风暴: 一次写入多枚 tap, 摊薄通道开销) ---- */
  if (pathname === '/api/adb/tap-burst' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const x = Number(body.x), y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return sendJson(res, 400, { error: '缺少 x/y' });
      const count = Math.max(1, Math.min(60, parseInt(body.count, 10) || 1));
      const gapMs = Math.max(0, Math.min(1000, parseInt(body.gapMs, 10) || 0));
      const jitter = Math.max(0, Math.min(100, parseInt(body.jitter, 10) || 0));   // 与锚点抖动上限对齐 (旧值 24 会静默夹小)
      const pressMs = Math.max(0, Math.min(400, parseInt(body.pressMs, 10) || 0));
      const adbList = scanAdbDevices();
      if (!adbList.length) return sendJson(res, 503, { error: '连发点击需要 USB 数据线（ADB input 注入）', needUsb: true, mode: resolveChannel().mode });
      const lines = [];
      for (let i = 0; i < count; i++) {
        const jx = Math.round(x + (jitter ? (Math.random() * 2 - 1) * jitter : 0));
        const jy = Math.round(y + (jitter ? (Math.random() * 2 - 1) * jitter : 0));
        lines.push(pressMs >= 30
          ? `input swipe ${jx} ${jy} ${jx} ${jy} ${Math.round(pressMs)}`
          : `input tap ${jx} ${jy}`);
        if (gapMs > 0 && i < count - 1) lines.push(`sleep ${(gapMs / 1000).toFixed(3)}`);
      }
      if (adbWriteLines(lines)) {
        return sendJson(res, 200, { status: 'ok', via: 'persist', count });
      }
      // 回落: 单次 adb 调用串行执行整串命令
      runAdb(`adb -s ${adbList[0].serial} shell "${lines.join('; ')}"`, Math.max(3000, count * (gapMs + 150)));
      return sendJson(res, 200, { status: 'ok', via: 'exec', count });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  /* ---- 深度链接打开商品页 (grab 就位专用; 2026-10-09 真机实证 damai://detail + itemId extra) ---- */
  if (pathname === '/api/adb/open-item' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const itemId = String(body.itemId || '').trim();
      // ★ 闸门顺序: 先入参/白名单 (400/403), 再通道 (503) —— 保证"非法输入"永远优先暴露
      const gate = openItemGate(itemId);
      if (!gate.ok) return sendJson(res, gate.status, { status: 'fail', error: gate.error });
      const ch = resolveChannel();
      // 只走 USB: 手机侧若已是 WiFi 通道会自己用本地 deep-link, 不该绕回中枢 (会形成回环)
      if (!ch.usb) {
        return sendJson(res, 503, {
          status: 'fail', needUsb: true, mode: ch.mode, channel: ch,
          error: '中枢没有 USB 设备 — 该接口是 ADB 专用; WiFi 通道请用 /api/phone/cmd (会下发到手机本地打开)',
        });
      }
      const r = await openItemViaAdb(itemId);
      return sendJson(res, r.ok ? 200 : (r.status || 500), { ...r, channel: ch });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  /* ---- 统一通道查询 (控制台据此决定按钮可用性) ---- */
  if (pathname === '/api/channel' && req.method === 'GET') {
    return sendJson(res, 200, { status: 'ok', channel: resolveChannel(url.searchParams.get('deviceId') || undefined), serverTime: Date.now() });
  }

  /* ---- 统一通道入口: USB 优先 → WiFi 降级, 控制台所有"依赖通道"的按钮都打这里 ---- */
  if (pathname === '/api/phone/cmd' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const op = String(body.op || '').trim();
      const params = body.params || {};
      const ch = resolveChannel(body.deviceId);
      if (ch.mode === 'none') {
        return sendJson(res, 503, { error: '手机未连接 — USB 与 WiFi 都不可达, 请先「一键连接设备」', channel: ch });
      }
      switch (op) {
        case 'open_item': {
          const itemId = String(params.itemId || '').trim();
          if (ch.mode === 'usb') {
            const r = await openItemViaAdb(itemId);
            return sendJson(res, r.ok ? 200 : (r.status || 500), { ...r, channel: ch });
          }
          // ★ 版本闸门 (2026-10-10): 旧手机脚本不认识 phone_op, 会把它当演练流水线跑掉
          const dev = ch.deviceId ? devices.get(ch.deviceId) : null;
          if (dev && dev.agentVersion) {
            const [maj, min] = String(dev.agentVersion).split('.').map((n) => parseInt(n, 10) || 0);
            if (maj < 1 || (maj === 1 && min < 1)) {
              return sendJson(res, 409, {
                error: '手机脚本过旧 (不认识 phone_op 指令) — 请先点「📦 更新手机脚本并重启 Agent」, 再重新打开商品页',
              });
            }
          }
          const r = dispatchPhoneOp('open_item', { itemId }, ch.deviceId);
          return sendJson(res, 200, {
            status: 'dispatched', via: 'wifi', taskId: r.task.taskId, channel: ch,
            note: '手机将用本地 deep-link 打开商品页 (WiFi 通道)',
          });
        }
        case 'capabilities':
          return sendJson(res, 200, { status: 'ok', channel: ch });
        default:
          return sendJson(res, 400, { error: `未知操作: ${op}` });
      }
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/adb/swipe' && req.method === 'POST') {
    try {
      const { x1, y1, x2, y2, ms } = await readJsonBody(req);
      const adbList = scanAdbDevices();
      if (!adbList.length) return sendJson(res, 503, { error: '滑动注入需要 USB 数据线（ADB input swipe）', needUsb: true, mode: resolveChannel().mode });
      runAdb(`adb -s ${adbList[0].serial} shell input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(ms || 300)}`, 3000);
      return sendJson(res, 200, { status: 'ok' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  /* ---- 一键设备连接 ---- */
  if (pathname === '/api/device/connect' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = await connectDeviceFlow(body);
      return sendJson(res, result.ok ? 200 : 500, result);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  /* ---- 更新手机端脚本 (USB: 推文件 + 让 Agent 自己换引擎重启; ★ 绝不 force-stop 应用/不碰无障碍) ---- */
  if (pathname === '/api/device/update-script' && req.method === 'POST') {
    try {
      const steps = [];
      const step = (name, ok, detail = '') => {
        steps.push({ name, ok, detail });
        log(`[更新脚本] ${ok ? '✅' : '❌'} ${name}${detail ? ': ' + detail : ''}`);
        return ok;
      };
      const adbList = scanAdbDevices();
      if (!step('检测 USB 设备', adbList.length > 0, adbList.length ? `${adbList[0].model} (${adbList[0].serial})` : '未检测到 USB 设备')) {
        return sendJson(res, 500, { ok: false, steps, error: '未检测到 USB 连接的 Android 设备' });
      }
      const serial = adbList[0].serial;
      try {
        runAdb(`adb -s ${serial} push "${AGENT_SCRIPT}" /sdcard/qg-agent/main.js`, 6000);
        step('推送 main.js', true, `${(fs.statSync(AGENT_SCRIPT).size / 1024).toFixed(1)} KB`);
      } catch (e) {
        return sendJson(res, 500, { ok: false, steps, error: '推送脚本失败: ' + e.message });
      }
      // 让 Agent 自己重启换引擎 (脚本内 forceStop 自己的引擎, 不 force-stop 应用 → 无障碍永不被触碰)
      const devId = [...devices.keys()].find((id) => {
        const d = devices.get(id);
        return d && Date.now() - d.lastSeen < 20000;
      });
      if (!devId) {
        step('Agent 未在线', false, '脚本已推送; 点「一键连接」即可拉起 (全程不触碰无障碍)');
        return sendJson(res, 500, { ok: false, steps, error: 'Agent 未在线 — 脚本已推送, 请点「一键连接」拉起 Agent' });
      }
      const beforeSize = Number(devices.get(devId).scriptSize || 0);
      devices.get(devId).restartRequested = true;
      step('下发自重启指令', true, 'Agent 将自行换引擎加载新脚本 (心跳回带, 最多 4 秒)');
      // 等重新注册: scriptSize 对账一致 + 心跳新鲜 (★ hello 现在也带 scriptSize → 新引擎一上线就能对上, 不用等下一次心跳)
      const wantSize = fs.statSync(AGENT_SCRIPT).size;
      let done = false;
      let lastSeenSize = beforeSize;
      for (let i = 0; i < 40; i++) {          // 20 秒 (原来 15 秒, 手机上换引擎有时会慢)
        await sleep(500);
        const d = devices.get(devId);
        if (d && Number(d.scriptSize) > 0) lastSeenSize = Number(d.scriptSize);
        if (d && Number(d.scriptSize) === wantSize && Date.now() - (d.lastSeen || 0) < 8000) { done = true; break; }
      }
      step('Agent 重启上线', done, done
        ? `新版已生效 (手机上报 ${(wantSize / 1024).toFixed(1)} KB, 与电脑端一致)`
        : `20s 内没等到新脚本上线 (手机最近上报 ${lastSeenSize ? (lastSeenSize / 1024).toFixed(1) + ' KB' : '未上报'} / 电脑端 ${(wantSize / 1024).toFixed(1)} KB)`);
      if (done) return sendJson(res, 200, { ok: true, steps });
      // ★ 脚本**已经推成功 + 重启指令也下发了**, 只是没在窗口内确认到 —— 不该报成"失败", 而是"待确认"
      return sendJson(res, 200, {
        ok: false, warn: true, steps,
        error: '脚本已推送、重启指令已下发, 但 20 秒内没等到新脚本上线（手机可能还在重启 / 网络慢）。'
             + '点「🔍 验证手机脚本是否最新」复核；若仍不是最新, 在手机上手动重开一次脚本即可（旧脚本不认识自重启指令）',
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  /* ---- 验证手机脚本是否为最新 (2026-10-10 用户口令: 提示要"全面", 手机与控制台都要提示) ----
   * 三源判据 (全部真实凭据, 不看页面文案):
   *   ① 体积对账: 手机心跳上报的 scriptSize  vs  电脑上 main.js 的字节数
   *   ② 版本对账: 手机 hello 上报的 agentVersion vs 电脑脚本里内嵌的 AGENT_VERSION
   *   ③ 指令能力: 手机脚本认不认 phone_op verify_script (≥1.3.0 才认 → 它自己能弹"我不是最新")
   * 手机侧提示: 优先下发 phone_op verify_script (手机本地 toast + 震动);
   *   旧脚本认不出该指令时, USB 通道尽力补一条系统通知 —— 两条都不成也如实说明(不假装成功)。
   */
  if (pathname === '/api/device/verify-script' && req.method === 'POST') {
    try {
      const TOL = 2048;                       // 体积"接近"的宽容带 (与卡片里的被动提示口径一致)
      const steps = [];
      const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); return ok; };

      let hubSize = 0;
      try { hubSize = fs.statSync(AGENT_SCRIPT).size; } catch (eS) { /* 忽略 */ }
      let hubVersion = '';
      try {
        const m = fs.readFileSync(AGENT_SCRIPT, 'utf8').match(/agent_?version\s*:\s*"([\d.]+)"/i);
        if (m) hubVersion = m[1];
      } catch (eR) { /* 忽略 */ }
      step('电脑端脚本', hubSize > 0,
        hubSize > 0 ? `${(hubSize / 1024).toFixed(1)} KB${hubVersion ? ' · v' + hubVersion : ' · 版本号未识别'}` : '读不到 main.js');

      // 2026-10-10: 支持 body.deviceId 指定校验哪一台 (多台在线时不再"只校验第一台"、结果随机)
      const body = await readJsonBody(req).catch(() => ({}));
      const wantId = String((body && body.deviceId) || '').trim();
      const live = [...devices.values()].filter(d => !d.isAdbOnly && Date.now() - (d.lastSeen || 0) < 15000);
      const agents = wantId ? live.filter(d => d.deviceId === wantId) : live;
      const dev = agents[0] || null;
      const adbList = scanAdbDevices();
      const hub = { size: hubSize, version: hubVersion };

      if (!dev) {
        step('手机 Agent 在线', false, adbList.length
          ? `${adbList[0].model || 'USB 设备'} 只插着数据线, Agent 没在跑`
          : 'USB 与 Wi-Fi 都没连上 Agent');
        const n = notifyPhoneViaAdb('QG 手机脚本校验', '手机 Agent 未在线, 控制台无法校验脚本版本 —— 请点「一键连接设备」重新部署。');
        return sendJson(res, 200, {
          status: 'ok', verdict: 'offline', steps, hub,
          headline: '无法校验：手机 Agent 不在线',
          hint: '点「⚡ 一键连接设备」把 Agent 拉起来, 再点本按钮校验。',
          phonePrompt: { delivered: !!n.ok, via: n.via, note: n.note },
        });
      }

      const phoneSize = Number(dev.scriptSize || 0);
      const phoneVersion = String(dev.agentVersion || '');
      step('手机 Agent 在线', true, `${dev.model || dev.deviceId} · ${dev.connectionMode || ''} · 状态 ${dev.state || 'idle'}`
        + (agents.length > 1 ? ` · ⚠ 在线 ${agents.length} 台, 本次只校验第一台` : ''));
      // 体积完全一致 = 同一份代码 (这是最硬的凭据, 与版本号无关)
      const sizeExact = phoneSize > 0 && hubSize > 0 && phoneSize === hubSize;
      step('手机脚本体积已上报', phoneSize > 0, phoneSize > 0
        ? `${(phoneSize / 1024).toFixed(1)} KB`
        : '未上报（心跳里没带体积 —— 设备可能刚上线, 等 4 秒再看）');
      // ★ 版本号拿不到 ≠ 旧脚本: 体积字节级一致就是同一份代码 (这是最硬的凭据)
      step('手机端版本号', !!phoneVersion || sizeExact, phoneVersion
        ? 'v' + phoneVersion
        : (sizeExact ? '未上报（但体积与电脑端字节级一致 = 同一份代码, 不影响判定）' : '未上报'));

      // 指令能力: **体积完全一致 ⇒ 就是同一份代码, 必然认识 phone_op**; 否则按版本号 (≥1.3.0) 判
      const [vmaj, vmin] = phoneVersion.split('.').map(n => parseInt(n, 10) || 0);
      const versionOk = !!phoneVersion && (vmaj > 1 || (vmaj === 1 && vmin >= 3));
      const canVerifyOp = sizeExact || versionOk;
      step('手机认识「自检版本」指令', canVerifyOp, canVerifyOp
        ? (versionOk ? '可以 (手机能自己弹出校验结果)' : '可以（体积与电脑端完全一致 = 同一份代码, 认识 phone_op）')
        : (phoneVersion ? `不能 — 端侧 v${phoneVersion} < v1.3.0, 升级后手机侧也能弹提示` : '不能 — 这台手机的脚本不是当前这一版'));

      // ---- 判定 ----
      let verdict = 'unknown', headline = '', hint = '';
      const diff = (phoneSize > 0 && hubSize > 0) ? phoneSize - hubSize : null;
      if (!phoneSize || !hubSize) {
        verdict = 'unknown';
        headline = '无法判定：有一侧的体积拿不到';
        hint = '先点「📦 更新手机脚本并重启 Agent」把脚本重新推一遍, 再回来校验。';
      } else if (diff === 0) {
        verdict = 'latest';
        headline = '✅ 手机脚本就是电脑上这一版（字节数完全一致）';
        hint = '无需操作。抢购前可直接开抢。';
        step('体积对账', true, `${phoneSize} B = ${hubSize} B（完全一致）`);
      } else if (Math.abs(diff) <= TOL) {
        verdict = 'near';
        headline = '⚠ 体积接近但不完全一致（差 ' + diff + ' B）';
        hint = '内容可能有细微差异（例如推送时被改动）。抢购前建议点「📦 更新手机脚本并重启 Agent」对齐。';
        step('体积对账', false, `手机 ${phoneSize} B / 电脑 ${hubSize} B（差 ${diff} B, 在 ±${TOL} 宽容带内）`);
      } else {
        verdict = 'stale';
        headline = '⚠ 手机脚本不是最新版（差 ' + Math.abs(diff) + ' B）';
        hint = '点「📦 更新手机脚本并重启 Agent」推送最新脚本, 再回来校验。';
        step('体积对账', false, `手机 ${(phoneSize / 1024).toFixed(1)} KB / 电脑 ${(hubSize / 1024).toFixed(1)} KB（差 ${Math.abs(diff)} B）`);
      }
      // 版本对账只作"佐证", 不改判定 (判定以体积为准: 字节数不同就是不同一份脚本)
      if (phoneVersion || hubVersion) {
        const vMatch = !!phoneVersion && !!hubVersion && phoneVersion === hubVersion;
        // ★ 体积已经字节级一致时, 版本号不一致只是"旧数据"(设备没重新注册 / 心跳还没带上新版号),
        //   不能显示成❌ —— 否则会像用户遇到的那样, 明明是最新版却一排红叉。
        const vOk = vMatch || sizeExact;
        const vDetail = vMatch
          ? `手机 v${phoneVersion} / 电脑 v${hubVersion}（一致）`
          : (sizeExact
            ? `体积字节级一致 = 同一份脚本；手机上报的 v${phoneVersion || '?'} 是旧数据（设备还没重新注册）, 以体积为准`
            : `手机 ${phoneVersion ? 'v' + phoneVersion : '未上报'} / 电脑 ${hubVersion ? 'v' + hubVersion : '未识别'}（不一致）`);
        step('版本对账', vOk, vDetail);
        if (vMatch && diff !== null && diff !== 0 && (verdict === 'stale' || verdict === 'near')) {
          headline += '（版本号却一致 —— 多半是电脑端脚本被改过但没重新推送）';
        }
      }

      // ---- 手机侧提示 ----
      let phonePrompt = { delivered: false, via: 'none', note: '' };
      if (dev.state === 'busy') {
        phonePrompt = { delivered: false, via: 'skipped-busy', note: `手机正忙（${dev.currentTaskId || '任务进行中'}）, 没打扰它 —— 跑完再点本按钮` };
      } else if (canVerifyOp) {
        try {
          const r = dispatchPhoneOp('verify_script', { hubSize, hubVersion, phoneSizeHint: phoneSize }, dev.deviceId);
          let said = null;
          for (let i = 0; i < 14; i++) {           // 最多等 ~3.5s 回收手机回执
            await sleep(250);
            const st = taskStates.get(r.task.taskId);
            if (st && st.result) { said = st.result; break; }
          }
          if (said) {
            phonePrompt = {
              delivered: said.outcome === 'success', via: 'agent-toast', taskId: r.task.taskId,
              note: (said.evidence || said.message || '手机已弹出校验结果') + '（手机侧已 toast + 震动）',
              phoneSaid: said.data || null,
            };
          } else {
            phonePrompt = { delivered: false, via: 'no-ack', taskId: r.task.taskId, note: '已下发但 3.5 秒内没收到手机回执（可能刚掉线）' };
          }
        } catch (eP) {
          phonePrompt = { delivered: false, via: 'error', note: '下发手机提示失败: ' + eP.message };
        }
      } else {
        const n = notifyPhoneViaAdb('QG 手机脚本校验', `手机脚本不是最新版（手机 ${phoneSize} B / 电脑 ${hubSize} B），请在控制台点「更新手机脚本并重启 Agent」。`);
        phonePrompt = { delivered: !!n.ok, via: n.via, note: n.note };
      }

      log(`[脚本校验] ${verdict} | 手机 ${phoneSize}B v${phoneVersion || '?'} / 电脑 ${hubSize}B v${hubVersion || '?'} | 手机提示: ${phonePrompt.via}`);
      return sendJson(res, 200, {
        status: 'ok', verdict, headline, hint, steps, hub,
        phone: { deviceId: dev.deviceId, model: dev.model, size: phoneSize, version: phoneVersion, state: dev.state || 'idle' },
        size: { phone: phoneSize, hub: hubSize, diff, exact: diff === 0 },
        version: { phone: phoneVersion, hub: hubVersion, match: phoneVersion === hubVersion },
        phonePrompt,
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  /* ---- 探针库 / 配置 / 账号 ---- */
  if (pathname === '/api/catalog' && req.method === 'GET') {
    return sendJson(res, 200, loadDamaiCatalog());
  }

  if (pathname === '/api/probe' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const targetId = String(body.itemId || body.keyword || '').trim();
      if (!targetId) return sendJson(res, 400, { error: '请提供演出 ID 或链接' });
      const { probeItem, loadCatalog, saveCatalog, mergeIntoCatalog } = await import('../platforms/damai/probe-damai.mjs');
      const item = await probeItem(targetId);
      if (item) {
        const cat = loadCatalog();
        const touched = mergeIntoCatalog(cat, item);
        saveCatalog(cat);
        return sendJson(res, 200, { status: 'ok', item, touched, catalog: cat });
      }
      return sendJson(res, 404, { error: '未探测到演出信息' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/config/damai' && req.method === 'GET') {
    return sendJson(res, 200, { status: 'ok', config: loadDamaiConfig() || {} });
  }
  if (pathname === '/api/config/damai' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const merged = { ...(loadDamaiConfig() || {}), ...body };
      saveDamaiConfig(merged);
      return sendJson(res, 200, { status: 'saved', config: merged });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/account/profile' && req.method === 'GET') {
    return sendJson(res, 200, { status: 'ok', profile: loadAccountProfile() });
  }

  if (pathname === '/api/account/add-viewer' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { name, idCard, bypassValidation } = body;
      if (!name?.trim()) return sendJson(res, 400, { error: '观演人姓名不能为空' });
      if (!idCard?.trim()) return sendJson(res, 400, { error: '身份证号不能为空' });
      if (!bypassValidation) {
        const check = validateIdCard(idCard.trim());
        if (!check.valid) return sendJson(res, 400, { error: '身份证校验未通过: ' + check.message, detail: check });
      }
      const task = {
        taskId: `t-add-viewer-${Date.now()}`,
        platform: 'damai', mode: 'add_viewer',
        data: { name: name.trim(), idCard: idCard.trim() },
      };
      const result = dispatchTask(task, body.deviceId);
      return sendJson(res, 200, { status: 'dispatched', ...result, task });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/account/add-address' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { name, phone, detailAddress, region } = body;
      if (!name?.trim()) return sendJson(res, 400, { error: '收货人姓名不能为空' });
      if (!phone?.trim()) return sendJson(res, 400, { error: '手机号不能为空' });
      if (!detailAddress || detailAddress.trim().length < 4) return sendJson(res, 400, { error: '详细地址不少于4个字' });
      const check = validatePhone(phone.trim());
      if (!check.valid) return sendJson(res, 400, { error: '手机号校验未通过: ' + check.message });
      const task = {
        taskId: `t-add-addr-${Date.now()}`,
        platform: 'damai', mode: 'add_address',
        data: { name: name.trim(), phone: phone.trim(), detailAddress: detailAddress.trim(), region: (region && region.trim()) || '浙江省杭州市西湖区' },
      };
      const result = dispatchTask(task, body.deviceId);
      return sendJson(res, 200, { status: 'dispatched', ...result, task });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if ((pathname === '/api/agent/script' || pathname === '/agent.js') && req.method === 'GET') {
    if (fs.existsSync(AGENT_SCRIPT)) {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Content-Disposition': 'inline; filename="main.js"',
      });
      return res.end(fs.readFileSync(AGENT_SCRIPT, 'utf8'));
    }
    return sendJson(res, 404, { error: '未找到 main.js 脚本' });
  }

  /* ---- 任务派发 ---- */
  if (pathname === '/api/tasks/dispatch' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const incomingTask = body.task || {};
      const config = loadDamaiConfig() || {};
      const profile = loadAccountProfile() || {};
      const fallbackViewer = (profile.viewers && profile.viewers[0]?.name) || '';

      const rawViewers = (incomingTask.target?.viewers?.length > 0)
        ? incomingTask.target.viewers
        : [incomingTask.target?.viewer || config.identity?.primaryAttendee || fallbackViewer];
      const ticketCount = parseInt(incomingTask.target?.count || config.selection?.ticketCount || 1, 10);

      const mode = incomingTask.mode || 'test';
      const VALID_MODES = ['test', 'dryrun', 'buy', 'monitor', 'add_viewer', 'add_address', 'grab', 'phone_op'];
      if (!VALID_MODES.includes(mode)) return sendJson(res, 400, { error: `未知任务模式: ${mode}` });
      const fireAt = Number(incomingTask.timing?.fireAtEpochMs || 0) || 0;
      if (mode === 'grab') {
        // 闸门(副作用之前): grab 必须带合法 itemId 与开抢时间
        const grabItemId = String(incomingTask.target?.itemId || '').trim();
        if (!/^\d{6,}$/.test(grabItemId)) return sendJson(res, 400, { error: 'grab 模式必须提供纯数字 itemId' });
        if (!(fireAt > 0)) return sendJson(res, 400, { error: 'grab 模式必须提供开抢时间 fireAtEpochMs' });
      }

      const task = {
        taskId: incomingTask.taskId || `t-${mode}-${Date.now()}`,
        platform: 'damai',
        mode,
        target: {
          name: incomingTask.target?.name || config.project?.name || '大麦演练项目',
          itemId: incomingTask.target?.itemId || (config.project?.projectId ? String(config.project.projectId) : ''),
          session: incomingTask.target?.session || config.selection?.sessionTarget || '',
          priceText: incomingTask.target?.priceText || config.selection?.priceTierTarget || '',
          viewer: rawViewers[0] || '',
          viewers: rawViewers,
          count: ticketCount,
          expectKeywords: Array.isArray(incomingTask.target?.expectKeywords)
            ? incomingTask.target.expectKeywords.map((k) => String(k).trim().slice(0, 24)).filter(Boolean).slice(0, 6)
            : [],
        },
        timing: {
          fireAtEpochMs: fireAt,
          leadMs: incomingTask.timing?.leadMs || config.timingEngine?.leadMs || 40,
          highFreqLeadMs: clampInt(incomingTask.timing?.highFreqLeadMs, 300, 10000, 1000),
        },
      };
      if (mode === 'grab') {
        // 白名单 + clamp: 控制台能调的全部点击参数在这里落闸 (未提供则给默认)
        const ig = incomingTask.grab || {};
        const calib = (ig.calibScreen && Number.isFinite(Number(ig.calibScreen.w)) && Number.isFinite(Number(ig.calibScreen.h)))
          ? { w: Math.round(Number(ig.calibScreen.w)), h: Math.round(Number(ig.calibScreen.h)) }
          : null;
        const gapMin = clampInt(ig.gapMinMs, 0, 1000, 55);   // 间隔可到 0 (由节拍反解得出)
        const pressMin = clampInt(ig.pressMinMs, 0, 300, 38);
        const rateMin = clampInt(ig.rateMin, 1, 50, 8);      // 节拍下限 (击/秒) —— 上限 50, 不做风控硬约束
        task.grab = {
          dryRun: !!ig.dryRun,                 // 测试按钮 (跳过变化检测, 到点直接出手)
          selfTest: !!ig.selfTest,
          button: validXY(ig.button),
          submit: validXY(ig.submit),
          popup: validXY(ig.popup),   // 「继续尝试」弹窗按钮 (2026-10-10; 缺省由手机端按提交锚点推算)
          calibScreen: calib,
          rateMin,
          rateMax: Math.max(rateMin, clampInt(ig.rateMax, 1, 50, 12)),
          chainMs: clampInt(ig.chainMs, 3000, 60000, 12000),
          gapMinMs: gapMin,
          gapMaxMs: Math.max(gapMin, clampInt(ig.gapMaxMs, 0, 2000, 85)),
          pressMinMs: pressMin,
          pressMaxMs: Math.max(pressMin, clampInt(ig.pressMaxMs, 0, 400, 56)),
          // 抖动上限 = 统一锚点三键交集的几何余量 (X ±100 / Y ±40, 2026-10-10 实测); 超界必出按钮
          // ★ 默认值/范围与控制台、手机端(applyClickCfg)三处必须完全一致: X 默认 30 / Y 默认 12
          jitterPx: clampInt(ig.jitterPx, 0, 100, 30),
          jitterXPx: clampInt(ig.jitterXPx !== undefined ? ig.jitterXPx : ig.jitterPx, 0, 100, 30),
          jitterYPx: clampInt(ig.jitterYPx !== undefined ? ig.jitterYPx : ig.jitterPx, 0, 40, 12),
          autoRefresh: !!ig.autoRefresh,   // 开售前自动刷新 (默认关)
          firstTapTries: clampInt(ig.firstTapTries, 1, 5, 1),   // 默认不重试 (2026-10-10 用户口径: 等超时票就没了)
          firstTapTimeoutMs: clampInt(ig.firstTapTimeoutMs, 30, 3000, 50),   // 50ms 超过即认为卡住 → 立即 Shizuku
          // ↓↓↓ 2026-10-10 新增 (控制台可调; 范围/默认值三处一致)
          doubleReadMs: clampInt(ig.doubleReadMs, 0, 500, 50),      // 双读确认延迟
          blindFire: !!ig.blindFire,                                // 到点盲点一发开关
          popupDelayMs: clampInt(ig.popupDelayMs, 0, 3000, 300),    // 弹窗处置起始延迟
          popupPollMs: clampInt(ig.popupPollMs, 10, 1000, 50),      // 弹窗探测间隔
          watchPollMs: clampInt(ig.watchPollMs, 50, 5000, 400),     // 终态看护间隔
        };
      }
      const result = dispatchTask(task, body.deviceId);
      return sendJson(res, 200, { status: 'dispatched', ...result, task });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ---- 手机「退场告知」(2026-10-10 用户口径): 脚本真退**之前**回报, 中枢据此立刻刷新状态 ---- */
  if (pathname === '/api/device/stopping' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) return sendJson(res, 400, { error: '缺少 deviceId' });
      const r = markStopConfirmed(deviceId, body.reason);
      const rec = {
        event: 'agent_stopping', at: Date.now(), taskId: null,
        detail: { deviceId, reason: String(body.reason || '').slice(0, 80), version: String(body.version || ''), confirmed: r.ok },
        receivedAt: new Date().toISOString(),
      };
      addRecentEvent(rec);
      try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(rec) + '\n'); } catch (e) {}
      return sendJson(res, 200, {
        status: r.ok ? 'ok' : 'ignored', channel: resolveChannel(deviceId),
        note: r.ok ? '中枢已确认, 状态已即时刷新为"未在线"' : r.note,
      });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  /* ---- 停止手机端脚本 (USB/WiFi 均可: 走心跳下发, 不用碰手机) ----
   * 职责单一: 只停脚本。若当时有任务在跑, 由**手机端**退出前自行上报 cancelled (见 runner.stopAgentNow)。
   * ★ 2026-10-10 用户口径: 中枢不"假设"它停了 —— 先尽力即时送达指令, 等手机回报「退场告知」才刷新状态。 */
  if (pathname === '/api/device/stop-agent' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const devId = String(body.deviceId || '').trim() || [...devices.keys()][0];
      const dev = devices.get(devId);
      if (!dev) return sendJson(res, 404, { error: '设备不在线（可能已经停掉了）', channel: resolveChannel() });
      // 设备本来就没心跳了 → 直接判定已停止, 不必等手机回报
      if (Date.now() - (dev.lastSeen || 0) >= 20000) {
        markStopConfirmed(devId, '设备本身已离线, 直接判定停止');
        return sendJson(res, 200, {
          status: 'offline_stopped', deviceId: devId, channel: resolveChannel(devId),
          note: '这台设备本来就不在线, 已直接标记为已停止',
        });
      }
      // 先试"即时送达"(手机闲着时通常正挂在长轮询上 → 秒级收到)
      dev.stopRequested = true;
      dev.stopPushedAt = Date.now();
      dev.stopPushCount = (dev.stopPushCount || 0) + 1;
      const delivered = deliverControlNow(devId, { stopAgent: true });
      if (delivered) dev.stopRequested = false;
      log(`[停止指令] → 设备 ${devId} (${delivered ? '经长轮询即时送达' : '下一次心跳下发, 最多 4 秒'})`);
      return sendJson(res, 200, {
        status: 'pending', deviceId: devId, runningTaskId: dev.currentTaskId || null,
        channel: resolveChannel(devId), delivered,
        note: delivered ? '指令已即时送到手机；它退出前会回报，届时状态立刻刷新'
                        : '手机最多 4 秒内收到；它退出前会回报，届时状态立刻刷新（不用等心跳超时）',
      });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  /* ---- 局域网更新手机脚本 (免数据线: 手机自己从 /agent/main.js 下载并覆盖) ---- */
  if (pathname === '/api/device/update-script-lan' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const devId = String(body.deviceId || '').trim() || [...devices.keys()][0];
      const dev = devices.get(devId);
      if (!dev) return sendJson(res, 404, { error: '设备不在线（手机浏览器也可直接打开 /agent/main.js 下载）' });
      let localSize = 0;
      try { localSize = fs.statSync(AGENT_SCRIPT).size; } catch (eS) { /* 忽略 */ }
      dev.selfUpdateRequested = true;
      log(`[自更新] 已登记 → 设备 ${devId}（电脑端脚本 ${Math.round(localSize / 1024)}KB）`);
      // ★ 2026-10-10 修: 这里原来只回 {status:'pending'} 没有 ok 字段 → 控制台按 r.ok 判成功,
      //   于是**一定**走"更新未完成"分支 (明明已经下发成功)。现在明确回 ok:true + pending:true,
      //   由控制台随后用"手机上报体积 vs 电脑体积"的真实凭据复核。
      return sendJson(res, 200, {
        ok: true, pending: true, status: 'pending', deviceId: devId, localSize,
        note: '手机最多 4 秒内开始下载并覆盖本地脚本, 随后自动重启',
      });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }

  /* ---- 手机脚本下载（局域网更新用：手机浏览器打开 /agent/main.js 即可下载） ---- */
  if (pathname === '/agent/main.js' && req.method === 'GET') {
    try {
      const js = fs.readFileSync(AGENT_SCRIPT);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="main.js"',
      });
      return res.end(js);
    } catch (e) {
      return sendJson(res, 500, { error: '缺少手机脚本文件：' + e.message });
    }
  }

  /* ---- 控制台静态页 ---- */
  if ((pathname === '/' || pathname === '/devices' || pathname === '/console') && req.method === 'GET') {
    try {
      let html = fs.readFileSync(CONSOLE_HTML, 'utf8');
      html = html.replace(/\$\{PORT\}/g, String(PORT)).replace(/\$\{LAN_IP\}/g, primaryLanIp());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('控制台页面缺失: ' + e.message);
    }
  }

  sendJson(res, 404, { error: 'Not found' });
});

/* ============ USB 插入自动一键连接 (2026-10-09 新增; 2026-10-10 补自愈) ============
 * 用户诉求: "USB 一连接，手机 Agent 就该自动跑起来，为什么还要我手点按钮?"
 * 行为: 每隔 5s 看一眼 USB 设备 ——
 *   ① 出现新 serial 且没有 Agent 在线 → 自动跑一遍 connectDeviceFlow (reverse → 配置 → 脚本 → 拉起 → 验证)
 *   ② ★ 同一 serial 但 Agent 掉线超 30s → 也自动重连 (脚本被系统杀掉后自愈,
 *      2026-10-10 补: 原来同一 serial 直接 return, 手机脚本被杀后永远没人管)
 * 防呆: 60s 熔断 (两次自动连接至少间隔 60s); 有 Agent 在线不重复连; 正在连不叠加;
 *       开关存 data/grab/device-hub.conf.json (autoConnectUsb, 默认开)。
 */
const HUB_CONF_FILE = path.join(GRAB_DIR, 'device-hub.conf.json');
const autoConnectState = { busy: false, lastSerial: null, lastAt: 0 };

function loadHubConf() {
  try { return JSON.parse(fs.readFileSync(HUB_CONF_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

function autoConnectEnabled() {
  return loadHubConf().autoConnectUsb !== false;   // 默认开
}

async function usbAutoConnectLoop() {
  setInterval(async () => {
    if (autoConnectState.busy || !autoConnectEnabled()) return;
    let adbList = [];
    try { adbList = scanAdbDevices(); } catch (e) { return; }
    if (!adbList.length) { autoConnectState.lastSerial = null; return; }
    const serial = adbList[0].serial;
    const isNewSerial = serial !== autoConnectState.lastSerial;
    // Agent 已在线就不必再连 (插着数据线充电、脚本已在跑的场景)
    const agentAlive = [...devices.values()].some(d => !d.isAdbOnly && Date.now() - d.lastSeen < 20000);
    if (agentAlive) { autoConnectState.lastSerial = serial; return; }
    // 同一 serial: Agent 却掉线 —— 30s 宽限 (避免重启间隙误判) + 60s 熔断; 新 serial: 60s 熔断仍生效
    if (!isNewSerial && Date.now() - autoConnectState.lastAt < 60000) return;
    const agentGoneMs = Date.now() - Math.max(...[...devices.values()].map(d => d.lastSeen || 0), 0);
    if (!isNewSerial && agentGoneMs < 30000) return;
    autoConnectState.busy = true;
    autoConnectState.lastAt = Date.now();
    autoConnectState.lastSerial = serial;
    log(`[自动连接] USB ${isNewSerial ? '新设备' : 'Agent 掉线'} ${serial} → 自动执行一键连接`);
    addRecentEvent({ event: 'usb_auto_connect', detail: { serial, phase: 'start', reason: isNewSerial ? 'new-serial' : 'agent-offline' }, receivedAt: new Date().toISOString() });
    try {
      const r = await connectDeviceFlow({ source: 'auto' });
      addRecentEvent({
        event: 'usb_auto_connect',
        detail: { serial, ok: r.ok, error: r.error || null, steps: (r.steps || []).map(s => `${s.ok ? '✓' : '✗'}${s.name}`) },
        receivedAt: new Date().toISOString(),
      });
      log(`[自动连接] ${r.ok ? '✅ 完成' : '❌ 失败: ' + (r.error || '')}`);
    } catch (e) {
      log(`[自动连接] 异常: ${e.message}`);
      addRecentEvent({ event: 'usb_auto_connect', detail: { serial, ok: false, error: e.message }, receivedAt: new Date().toISOString() });
    } finally {
      autoConnectState.busy = false;
    }
  }, 5000);
}

server.listen(PORT, HOST, () => {
  writePidFile();
  usbAutoConnectLoop();
  const ips = getLocalIps();
  log(`==================================================================`);
  log(`🚀 QG 设备中枢已就绪 (v9)`);
  log(`   - 电脑浏览器访问: http://localhost:${PORT}`);
  ips.forEach(ip => log(`   - 手机/局域网直连: http://${ip.address}:${PORT}`));
  log(`   - USB (adb reverse): http://127.0.0.1:${PORT}`);
  log(`==================================================================`);
});

/* ---- 体面退出 (2026-10-10 修复僵尸进程): 有挂起的长轮询连接时, server.close 的回调
 *      永远不会触发 → 进程僵死、端口显示被占。主动断掉全部连接 + 1.2s 兜底强退。 ---- */
function gracefulShutdown() {
  removePidFile();
  try { server.close(); } catch (e) { /* 忽略 */ }
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch (e) { /* 忽略 */ }
  setTimeout(() => process.exit(0), 1200);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
