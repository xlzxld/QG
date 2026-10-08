#!/usr/bin/env node
/**
 * 独立保活守护（2026-10-08）：驱动停了也续命
 * =====================================================================
 * 根因实测：vmall 服务端会话约 30 分钟无活动就失效（Cookie 还在也没用）；
 * 之前保活挂在驱动里，驱动一停就没人续。本进程独立常驻：每轮间隔 4~6 分钟随机
 * （固定整点节拍=机器人指纹，2026-10-08 加抖动），对每个在跑的槽位窗口发一次
 * 轻请求（www.vmall.com 续 cluster + queryUserInfo 验活），多窗口错开发。
 * 日志：data/grab/keepalive.log（掉线会明确写出来）。
 * 由 grab-bridge.mjs 开机自动拉起（PID 文件防重复）；也可手动跑。
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, listTabs, judgeVmallLoginBody } from '../grab/cdp-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG = path.join(ROOT, 'data', 'grab', 'keepalive.log');
const PID = path.join(ROOT, 'data', 'grab', 'keepalive.pid');
const INTERVAL_MS = 5 * 60 * 1000;
const ONCE = process.argv.includes('--once');

// 2026-10-08 加抖动：固定 5:00 一跳（keepalive.log 里整点不差的节拍）= 机器人指纹。
// 每轮间隔 = 基准 ×(0.8~1.2)，即 4~6 分钟随机；两个窗口错开 2~8 秒、发起前再等 0.5~2.5 秒。
// 安全边界：服务端会话 30 分钟失活、cluster 窗口 15 分钟，最长 6 分钟续一次离两个红线都很远。
const jitter = (min, max) => Math.round(min + Math.random() * (max - min));

// 单实例：PID 文件里是活进程就退出（--once 测试轮不占实例）
if (!ONCE) {
  try {
    const old = Number(fs.readFileSync(PID, 'utf8').trim());
    if (old && old !== process.pid) { process.kill(old, 0); console.log('保活守护已在运行（pid ' + old + '），退出'); process.exit(0); }
  } catch { /* 没有旧实例 */ }
  fs.writeFileSync(PID, String(process.pid));
}
const log = (msg) => {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* 忽略 */ }
};
const slotsPorts = () => {
  try { return (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'grab', 'rush-slots.huawei.json'), 'utf8')).slots || []).map((s) => s.port).filter(Boolean); }
  catch { return []; }
};

async function pingOnce() {
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
      if (verdict === 'out') log(`端口 ${port}：⚠️ 掉线了（服务端会话失效）——需要人工重新登录｜响应头：${head}`);
      else if (verdict === 'err') log(`端口 ${port}：探测出错（网络抖动，下轮再看）`);
      else if (verdict === null) log(`端口 ${port}：响应读不懂（不当掉线，下轮再看）：${head}`);
      else log(`端口 ${port}：已续命`);
    } catch (e) {
      log(`端口 ${port}：检查异常（${e.message}）`);
    }
    // 多窗口时错开几秒，别同一秒齐射（两个端口日志总在同一秒=太整齐）
    if (ports.indexOf(port) < ports.length - 1) await new Promise((r) => setTimeout(r, jitter(2000, 8000)));
  }
}

log(`${ONCE ? '测试轮' : '保活守护启动（pid ' + process.pid + '，每轮 4~6 分钟随机，带抖动）'}`);
await pingOnce();
if (ONCE) process.exit(0);
// 递归 setTimeout（不用 setInterval）：每轮间隔都重新摇
const scheduleNext = () => {
  const gap = Math.round(INTERVAL_MS * (0.8 + Math.random() * 0.4));
  log(`下一轮 ${new Date(Date.now() + gap).toLocaleTimeString('zh-CN', { hour12: false })}（间隔 ${Math.round(gap / 1000)} 秒）`);
  setTimeout(async () => { await pingOnce(); scheduleNext(); }, gap);
};
scheduleNext();
// PID 文件随退出清理
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { try { fs.unlinkSync(PID); } catch {} process.exit(0); }); } catch { /* 忽略 */ }
}
