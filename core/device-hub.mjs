/**
 * 设备中枢守护进程 (Device Hub)
 * =====================================================================
 * 职责：
 *   1. 手机设备发现、注册（hello）与状态心跳监测（heartbeat）
 *   2. 双模通信支持：既支持局域网 Wi-Fi 直连（0.0.0.0），又支持 USB（127.0.0.1）
 *   3. HTTP 长轮询任务队列（poll-task，挂起 ≤25s）
 *   4. 任务结果接收、幂等去重（taskId+seq）并沉降至 data/grab/
 *   5. 与既有桥接服务（:3100）保持单向解耦：通过既有接口交互，华为 Web 线零侵入
 *
 * 启动：node core/device-hub.mjs
 * 默认端口 3120，监听 0.0.0.0。
 * =====================================================================
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRAB_DIR = path.join(ROOT, 'data', 'grab');
const PORT = Number(process.env.DEVICE_HUB_PORT || 3120);
const HOST = '0.0.0.0';

if (!fs.existsSync(GRAB_DIR)) {
  fs.mkdirSync(GRAB_DIR, { recursive: true });
}

const PID_PATH = path.join(GRAB_DIR, 'device-hub.pid');
const RESULTS_FILE = path.join(GRAB_DIR, 'app.results.jsonl');
const EVENTS_FILE = path.join(GRAB_DIR, 'device-events.jsonl');

function writePidFile() {
  try {
    fs.writeFileSync(PID_PATH, String(process.pid), 'utf8');
  } catch (e) {
    console.error('写入 PID 失败:', e.message);
  }
}

function removePidFile() {
  try {
    if (fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_PATH);
    }
  } catch {
    // 忽略
  }
}

const log = (...args) => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  console.log(`[Hub ${ts}]`, ...args);
};

// 内存设备注册表: deviceId -> { info, lastSeen, state, ip, connectionMode }
const devices = new Map();

// 待分发任务队列: deviceId -> [tasks]
const taskQueues = new Map();

// 挂起的长轮询请求: deviceId -> { res, timer }
const waitingPolls = new Map();

// 已处理结果去重集合: Set<`${taskId}:${seq}`>
const processedResults = new Set();

// 启动时预热去重集（从已有结果文件读取）
if (fs.existsSync(RESULTS_FILE)) {
  try {
    const lines = fs.readFileSync(RESULTS_FILE, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.taskId) {
        processedResults.add(`${r.taskId}:${r.seq ?? 0}`);
      }
    }
    log(`已载入历史结果去重记录 ${processedResults.size} 条`);
  } catch (e) {
    log('解析历史结果文件异常:', e.message);
  }
}

/**
 * 响应 JSON 辅助函数
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

/**
 * 解析请求体 JSON
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * 分发任务给指定设备（或首个空闲设备）
 */
function dispatchTask(task, targetDeviceId = null) {
  const deviceId = targetDeviceId || [...devices.keys()].find(id => {
    const dev = devices.get(id);
    return dev && (dev.state === 'idle' || !dev.state);
  }) || [...devices.keys()][0];

  if (!deviceId) {
    throw new Error('当前无任何在线或注册的 Android 设备');
  }

  // 检查是否有挂起的长轮询
  if (waitingPolls.has(deviceId)) {
    const { res, timer } = waitingPolls.get(deviceId);
    clearTimeout(timer);
    waitingPolls.delete(deviceId);
    log(`[任务派发] 唤醒挂起的长轮询 -> 设备 ${deviceId}, 任务 ${task.taskId}`);
    sendJson(res, 200, { status: 'task', task });
    return { deviceId, dispatchedImmediately: true };
  }

  // 否则入队等待下一次轮询
  if (!taskQueues.has(deviceId)) {
    taskQueues.set(deviceId, []);
  }
  taskQueues.get(deviceId).push(task);
  log(`[任务入队] 设备 ${deviceId} 队列深度: ${taskQueues.get(deviceId).length}`);
  return { deviceId, dispatchedImmediately: false };
}

const server = http.createServer(async (req, res) => {
  const clientIp = req.socket.remoteAddress || '';
  const isLoopback = clientIp.includes('127.0.0.1') || clientIp === '::1';

  // 跨域 OPTIONS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. 健康检查
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'device-hub',
      uptimeSec: Math.floor(process.uptime()),
      onlineDevices: devices.size,
      serverTime: Date.now()
    });
  }

  // 2. 手机上线握手 (hello)
  if (pathname === '/api/device/hello' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const deviceId = data.deviceId || `dev-${Math.random().toString(36).slice(2, 8)}`;
      const connMode = isLoopback ? 'USB (adb reverse)' : `Wi-Fi (${clientIp})`;

      devices.set(deviceId, {
        ...data,
        deviceId,
        clientIp,
        connectionMode: connMode,
        state: 'idle',
        lastSeen: Date.now(),
        registeredAt: Date.now()
      });

      log(`[设备上线] ${deviceId} [${connMode}] AutoX:${data.autoX || '未知'} 分辨率:${JSON.stringify(data.screen || [])}`);
      return sendJson(res, 200, {
        status: 'registered',
        deviceId,
        connectionMode: connMode,
        serverTime: Date.now()
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 3. 手机心跳 (heartbeat)
  if (pathname === '/api/device/heartbeat' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const deviceId = data.deviceId;
      if (!deviceId) return sendJson(res, 400, { error: '缺少 deviceId' });

      const dev = devices.get(deviceId) || {
        deviceId,
        registeredAt: Date.now(),
        connectionMode: isLoopback ? 'USB' : 'Wi-Fi'
      };

      dev.lastSeen = Date.now();
      dev.state = data.state || dev.state || 'idle';
      dev.battery = data.battery ?? dev.battery;
      dev.charging = data.charging ?? dev.charging;
      dev.accessibility = data.accessibility ?? dev.accessibility;
      dev.currentTaskId = data.taskId ?? null;

      devices.set(deviceId, dev);
      return sendJson(res, 200, { status: 'ok', serverTime: Date.now() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 4. 手机长轮询取任务 (poll-task)
  if (pathname === '/api/device/poll-task' && req.method === 'GET') {
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId) return sendJson(res, 400, { error: '缺少 deviceId' });

    // 更新心跳
    if (devices.has(deviceId)) {
      devices.get(deviceId).lastSeen = Date.now();
    }

    // 若队列中有积压任务，立即返回
    const queue = taskQueues.get(deviceId);
    if (queue && queue.length > 0) {
      const task = queue.shift();
      log(`[立即下发] 从队列拉取任务给 ${deviceId} -> ${task.taskId}`);
      return sendJson(res, 200, { status: 'task', task });
    }

    // 否则挂起长轮询（最长 25 秒）
    const timer = setTimeout(() => {
      waitingPolls.delete(deviceId);
      sendJson(res, 200, { status: 'idle', serverTime: Date.now() });
    }, 25000);

    // 清理可能遗留的旧挂起
    if (waitingPolls.has(deviceId)) {
      clearTimeout(waitingPolls.get(deviceId).timer);
    }
    waitingPolls.set(deviceId, { res, timer });

    req.on('close', () => {
      if (waitingPolls.has(deviceId) && waitingPolls.get(deviceId).res === res) {
        clearTimeout(timer);
        waitingPolls.delete(deviceId);
      }
    });
    return;
  }

  // 5. 手机事件上报 (event)
  if (pathname === '/api/device/event' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      log(`[设备事件] ${data.deviceId || '未知'}: [${data.event}] ${JSON.stringify(data.detail || {})}`);
      fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ...data, receivedAt: new Date().toISOString() }) + '\n');
      return sendJson(res, 200, { status: 'ok' });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 6. 任务结果上报 (result)
  if (pathname === '/api/device/result' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const { taskId, seq = 0, outcome, orderNo } = data;
      const dedupeKey = `${taskId}:${seq}`;

      if (processedResults.has(dedupeKey)) {
        log(`[结果去重] 忽略重复上报 ${dedupeKey}`);
        return sendJson(res, 200, { status: 'ack', deduplicated: true });
      }

      processedResults.add(dedupeKey);
      const record = {
        ...data,
        receivedAt: new Date().toISOString()
      };

      fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n');
      log(`[结果落盘] 任务 ${taskId} 结果: ${outcome} 订单号: ${orderNo || '无'}`);

      // 尝试转发给现有桥接服务（如果在线）
      try {
        const platform = data.platform || 'damai';
        const bridgeReq = http.request({
          hostname: '127.0.0.1',
          port: 3100,
          path: `/api/results/${platform}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 2000
        });
        bridgeReq.on('error', () => {}); // 忽略桥接不在线的错误
        bridgeReq.write(JSON.stringify(record));
        bridgeReq.end();
      } catch {
        // 桥接未启动不阻塞
      }

      return sendJson(res, 200, { status: 'ack', recorded: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 7. 查询所有设备列表 (api)
  if (pathname === '/api/devices' && req.method === 'GET') {
    const list = [...devices.values()].map(d => ({
      ...d,
      isAlive: Date.now() - d.lastSeen < 15000 // 15秒内有心跳算存活
    }));
    return sendJson(res, 200, { devices: list });
  }

  // 8. 派发任务 (api)
  if (pathname === '/api/tasks/dispatch' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const task = body.task || {
        taskId: `t-manual-${Date.now()}`,
        platform: 'damai',
        mode: 'rush',
        target: {
          name: '测试演出',
          url: 'https://detail.damai.cn/item.htm?id=12345678',
          session: '2026-10-15 周四 19:30',
          priceText: '内场 980',
          viewers: ['测试人员']
        },
        timing: {
          fireAtEpochMs: Date.now() + 60000, // 1分钟后
          leadMs: 40
        }
      };

      const result = dispatchTask(task, body.deviceId);
      return sendJson(res, 200, { status: 'dispatched', ...result, task });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 9. 设备控制台看板 (HTML)
  if ((pathname === '/devices' || pathname === '/') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>APP端抢购设备中枢 (Device Hub :3120)</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #30363d; padding-bottom: 16px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 20px; color: #58a6ff; }
    .badge { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: bold; background: #238636; color: white; }
    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; font-weight: bold; }
    .prop-row { display: flex; justify-content: space-between; font-size: 13px; margin: 6px 0; color: #8b949e; }
    .prop-val { color: #f0f6fc; }
    .status-online { color: #3fb950; font-weight: bold; }
    .status-offline { color: #f85149; font-weight: bold; }
    .actions { margin-top: 16px; padding-top: 12px; border-top: 1px solid #21262d; }
    button { background: #238636; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold; }
    button:hover { background: #2ea043; }
    .empty { color: #8b949e; text-align: center; padding: 48px; border: 1px dashed #30363d; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>📱 APP端抢购设备中枢 (Device Hub)</h1>
    <div>
      <span class="badge" id="hub-status">端口 :3120 · 运行中</span>
      <button onclick="dispatchDamaiTest()" style="margin-left: 12px; background: #1f6feb;">一键下发大麦测试任务</button>
    </div>
  </div>

  <h2>已连接设备 (<span id="dev-count">0</span>)</h2>
  <div class="card-grid" id="devices-container">
    <div class="empty">暂无手机上线。<br>请在手机 AutoX 运行 Agent，或通过 Wi-Fi 访问本 PC 局域网 IP。</div>
  </div>

  <script>
    async function loadDevices() {
      try {
        const res = await fetch('/api/devices');
        const data = await res.json();
        const container = document.getElementById('devices-container');
        document.getElementById('dev-count').textContent = data.devices.length;

        if (data.devices.length === 0) {
          container.innerHTML = '<div class="empty">暂无手机上线。<br>请在手机 AutoX 运行 Agent 脚本。</div>';
          return;
        }

        container.innerHTML = data.devices.map(d => \`
          <div class="card">
            <div class="card-header">
              <span>\${d.deviceId}</span>
              <span class="\${d.isAlive ? 'status-online' : 'status-offline'}">
                \${d.isAlive ? '● 在线' : '○ 失联'}
              </span>
            </div>
            <div class="prop-row"><span>连接通道:</span><span class="prop-val">\${d.connectionMode || '未知'}</span></div>
            <div class="prop-row"><span>工作状态:</span><span class="prop-val">\${d.state || 'idle'}</span></div>
            <div class="prop-row"><span>电量 / 充电:</span><span class="prop-val">\${d.battery ?? '--'}% (\${d.charging ? '充电中' : '放电'})</span></div>
            <div class="prop-row"><span>无障碍服务:</span><span class="prop-val" style="color: \${d.accessibility ? '#3fb950' : '#f85149'}">\${d.accessibility ? '已开启' : '未开启'}</span></div>
            <div class="prop-row"><span>AutoX 版本:</span><span class="prop-val">\${d.autoX || 'v7'}</span></div>
            <div class="prop-row"><span>最近心跳:</span><span class="prop-val">\${Math.floor((Date.now() - d.lastSeen) / 1000)}秒前</span></div>
          </div>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function dispatchDamaiTest() {
      try {
        const res = await fetch('/api/tasks/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task: {
              taskId: 't-damai-' + Date.now(),
              platform: 'damai',
              mode: 'rush',
              target: {
                name: '大麦演练项目',
                url: 'https://detail.damai.cn/item.htm?id=sample',
                session: '2026-10-15 周四 19:30',
                priceText: '内场 980',
                viewers: ['张三']
              },
              timing: {
                fireAtEpochMs: Date.now() + 30000,
                leadMs: 40
              }
            }
          })
        });
        const ret = await res.json();
        alert('派发成功: ' + JSON.stringify(ret));
        loadDevices();
      } catch (err) {
        alert('派发失败: ' + err.message);
      }
    }

    setInterval(loadDevices, 3000);
    loadDevices();
  </script>
</body>
</html>`;
    return res.end(html);
  }

  // 404
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  writePidFile();
  log(`==================================================================`);
  log(`🚀 设备中枢已就绪: http://${HOST}:${PORT}`);
  log(`   - 局域网访问: http://<本机局域网IP>:${PORT}/devices`);
  log(`   - 本地内环/USB: http://127.0.0.1:${PORT}/devices`);
  log(`==================================================================`);
});

process.on('SIGINT', () => {
  log('收到 SIGINT，关闭服务...');
  removePidFile();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  log('收到 SIGTERM，关闭服务...');
  removePidFile();
  server.close(() => process.exit(0));
});
