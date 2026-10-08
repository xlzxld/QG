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
import { execSync, exec as execAsync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateIdCard, validatePhone, loadAccountProfile, saveAccountProfile } from '../platforms/damai/account-manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRAB_DIR = path.join(ROOT, 'data', 'grab');
const PORT = Number(process.env.DEVICE_HUB_PORT || 3120);
const HOST = '0.0.0.0';
const AGENT_SCRIPT = path.join(ROOT, 'platforms', 'app', 'agent', 'main.js');
const REGIONS_FILE = path.join(GRAB_DIR, 'regions.json');
const CONSOLE_HTML = path.join(ROOT, 'web', 'hub-console.html');
const AUTOJS_PKG = 'org.autojs.autojs6';
const AUTOJS_ACC_SERVICE = 'org.autojs.autojs.core.accessibility.AccessibilityServiceUsher';

/* ============ ADB 设备探测 (2s 缓存) ============ */
let lastAdbScanTime = 0;
let cachedAdbDevices = [];

function runAdb(cmd, timeoutMs = 4000) {
  return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: 'pipe' });
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
  try {
    const output = runAdb('adb devices -l', 1500);
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
setInterval(() => {
  execAsync('adb devices -l', { timeout: 2000 }, (err, stdout) => {
    if (err) { cachedAdbDevices = []; lastAdbScanTime = Date.now(); return; }
    const list = parseAdbDevices(stdout);
    lastAdbScanTime = Date.now();
    cachedAdbDevices = list;
    for (const d of list) {
      execAsync(`adb -s ${d.serial} reverse tcp:${PORT} tcp:${PORT}`, { timeout: 1500 }, () => {});
    }
    if (list.length) log(`[USB 隧道] 已自动维持 ${list.length} 台设备的 tcp:${PORT} 反向代理`);
  });
}, 5000).unref();

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

  addRecentEvent({
    deviceId,
    event: 'task_dispatched',
    detail: {
      taskId: task.taskId,
      mode: task.mode,
      target: task.target?.name,
      session: task.target?.session,
      price: task.target?.priceText,
      viewers: task.target?.viewers || [task.target?.viewer || ''],
      count: task.target?.count || 1,
    },
    receivedAt: new Date().toISOString(),
  });
  taskStates.set(task.taskId, { task, dispatchedAt: Date.now(), result: null });
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

/* ============ 一键设备连接 (核心流程) ============ */
async function connectDeviceFlow(options = {}) {
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

  // 6. (重启模式) 停止旧 Agent 并恢复无障碍
  const agentWasOnline = [...devices.values()].some(d => Date.now() - d.lastSeen < 20000);
  if (options.restart || agentWasOnline) {
    try {
      runAdb(`adb -s ${serial} shell am force-stop ${AUTOJS_PKG}`, 3000);
      await sleep(800);
      // force-stop 会清掉无障碍绑定, 必须立即恢复
      runAdb(`adb -s ${serial} shell "settings put secure enabled_accessibility_services ${AUTOJS_PKG}/${AUTOJS_ACC_SERVICE}; settings put secure accessibility_enabled 1"`, 3000);
      step('重启 Agent (恢复无障碍服务)', true);
    } catch (e) {
      step('重启 Agent', false, e.message);
    }
  }

  // 7. 拉起 Agent 运行
  try {
    runAdb(`adb -s ${serial} shell am start -n ${AUTOJS_PKG}/org.autojs.autojs.external.open.RunIntentActivity -a android.intent.action.VIEW -d "file:///sdcard/qg-agent/main.js" -t "application/x-javascript"`, 4000);
    step('拉起 AutoJs6 运行 Agent', true);
  } catch (e) {
    step('拉起 AutoJs6 运行 Agent', false, e.message);
    return { ok: false, steps, error: '无法启动手机端脚本 (请确认手机已安装 AutoJs6)' };
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

  return { ok: online, steps, error: online ? null : 'Agent 未能上线 (可能无障碍服务未授权, 请在手机上检查 AutoJs6)' };
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
      uptimeSec: Math.floor(process.uptime()),
      onlineDevices: devices.size,
      lanIps: getLocalIps(),
      serverTime: Date.now(),
    });
  }
  if (pathname === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      uptimeSec: Math.floor(process.uptime()),
      onlineDevices: [...devices.values()].map(d => ({ ...d, isAlive: Date.now() - d.lastSeen < 15000 })),
      lanIps: getLocalIps(),
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
      return sendJson(res, 200, { status: 'registered', deviceId, connectionMode: connMode, serverTime: Date.now() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/device/heartbeat' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      if (!data.deviceId) return sendJson(res, 400, { error: '缺少 deviceId' });
      const dev = devices.get(data.deviceId) || {
        deviceId: data.deviceId, registeredAt: Date.now(),
        clientIp: isLoopback ? '127.0.0.1' : clientIp,
        connectionMode: isLoopback ? 'USB (adb reverse)' : `Wi-Fi (${clientIp})`,
      };
      dev.lastSeen = Date.now();
      dev.state = data.state || dev.state || 'idle';
      dev.battery = data.battery ?? dev.battery;
      dev.charging = data.charging ?? dev.charging;
      dev.accessibility = data.accessibility ?? dev.accessibility;
      dev.currentTaskId = data.taskId ?? null;
      devices.set(data.deviceId, dev);
      return sendJson(res, 200, { status: 'ok', serverTime: Date.now() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/device/poll-task' && req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) return sendJson(res, 400, { error: '缺少 deviceId' });
    if (devices.has(deviceId)) devices.get(deviceId).lastSeen = Date.now();

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
      addRecentEvent({
        deviceId: data.deviceId || 'device',
        event: 'task_result',
        detail: record,
        receivedAt: record.receivedAt,
      });
      try { fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n'); } catch (e) {}
      log(`[结果落盘] 任务 ${data.taskId}: ${data.outcome} | ${data.evidence || data.message || ''}`);

      const ts = taskStates.get(data.taskId);
      if (ts) ts.result = record;
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

  /* ---- 设备列表 (ADB + Agent 融合) ---- */
  if (pathname === '/api/devices' && req.method === 'GET') {
    const isLoopbackIp = ip => String(ip || '').includes('127.0.0.1') || String(ip || '') === '::1';
    const adbList = scanAdbDevices();
    const httpList = [...devices.values()];
    const mergedList = [];
    const matchedSerials = new Set();
    for (const d of httpList) {
      const isAlive = Date.now() - d.lastSeen < 20000;
      const matchedAdb = adbList.find(a => d.deviceId.includes(a.serial) || isLoopbackIp(d.clientIp));
      if (matchedAdb) {
        matchedSerials.add(matchedAdb.serial);
        mergedList.push({ ...d, isAlive: true, usbAttached: true, model: matchedAdb.model || d.model });
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
    return sendJson(res, 200, { devices: mergedList, adbDevicesCount: adbList.length, httpAgentsCount: httpList.length });
  }

  /* ---- ADB 触摸注入 (Agent 手势失效时的可靠兜底通道) ---- */
  if (pathname === '/api/adb/tap' && req.method === 'POST') {
    try {
      const { x, y } = await readJsonBody(req);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return sendJson(res, 400, { error: '缺少 x/y' });
      const adbList = scanAdbDevices();
      if (!adbList.length) return sendJson(res, 503, { error: '无 USB 设备' });
      runAdb(`adb -s ${adbList[0].serial} shell input tap ${Math.round(x)} ${Math.round(y)}`, 2500);
      return sendJson(res, 200, { status: 'ok' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (pathname === '/api/adb/swipe' && req.method === 'POST') {
    try {
      const { x1, y1, x2, y2, ms } = await readJsonBody(req);
      const adbList = scanAdbDevices();
      if (!adbList.length) return sendJson(res, 503, { error: '无 USB 设备' });
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

  /* ---- 更新手机端脚本 (推送 + 重启 Agent) ---- */
  if (pathname === '/api/device/update-script' && req.method === 'POST') {
    try {
      const result = await connectDeviceFlow({ restart: true });
      return sendJson(res, result.ok ? 200 : 500, result);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  /* ---- 探针库 / 配置 / 账号 ---- */
  if (pathname === '/api/catalog' && req.method === 'GET') {
    return sendJson(res, 200, loadDamaiCatalog());
  }

  if (pathname === '/api/probe' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const targetId = body.itemId || body.keyword || '';
      if (!targetId) return sendJson(res, 400, { error: '请提供演出 ID 或关键词' });
      const { probeItem, loadCatalog, saveCatalog } = await import('../platforms/damai/probe-damai.mjs');
      const item = await probeItem(targetId);
      if (item) {
        const cat = loadCatalog();
        const idx = cat.items.findIndex(i => i.id === item.id || i.itemId === item.itemId);
        if (idx >= 0) cat.items[idx] = item; else cat.items.push(item);
        saveCatalog(cat);
        return sendJson(res, 200, { status: 'ok', item, catalog: cat });
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
      const fallbackViewer = (profile.viewers && profile.viewers[0]?.name) || '薛凌志';

      const rawViewers = (incomingTask.target?.viewers?.length > 0)
        ? incomingTask.target.viewers
        : [incomingTask.target?.viewer || config.identity?.primaryAttendee || fallbackViewer];
      const ticketCount = parseInt(incomingTask.target?.count || config.selection?.ticketCount || 1, 10);

      const task = {
        taskId: incomingTask.taskId || `t-${incomingTask.mode || 'test'}-${Date.now()}`,
        platform: 'damai',
        mode: incomingTask.mode || 'test',
        target: {
          name: incomingTask.target?.name || config.project?.name || '大麦演练项目',
          itemId: incomingTask.target?.itemId || (config.project?.projectId ? String(config.project.projectId) : ''),
          session: incomingTask.target?.session || config.selection?.sessionTarget || '',
          priceText: incomingTask.target?.priceText || config.selection?.priceTierTarget || '',
          viewer: rawViewers[0] || '薛凌志',
          viewers: rawViewers,
          count: ticketCount,
        },
        timing: {
          fireAtEpochMs: incomingTask.timing?.fireAtEpochMs || 0,
          leadMs: incomingTask.timing?.leadMs || config.timingEngine?.leadMs || 40,
        },
      };
      const result = dispatchTask(task, body.deviceId);
      return sendJson(res, 200, { status: 'dispatched', ...result, task });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
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

server.listen(PORT, HOST, () => {
  writePidFile();
  const ips = getLocalIps();
  log(`==================================================================`);
  log(`🚀 QG 设备中枢已就绪 (v9)`);
  log(`   - 电脑浏览器访问: http://localhost:${PORT}`);
  ips.forEach(ip => log(`   - 手机/局域网直连: http://${ip.address}:${PORT}`));
  log(`   - USB (adb reverse): http://127.0.0.1:${PORT}`);
  log(`==================================================================`);
});

process.on('SIGINT', () => { removePidFile(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { removePidFile(); server.close(() => process.exit(0)); });
