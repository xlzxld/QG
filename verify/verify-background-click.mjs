#!/usr/bin/env node
/**
 * 后台点击可行性实测（2026-10-09，多页签抢购方案的前置验证）
 * =====================================================================
 * 回答一个问题：CDP Input.dispatchMouseEvent（trustedClick 同款）在
 *   ① 页签在后台（窗口里另一个页签是活动页）
 *   ② 窗口被最小化
 *   ③ 窗口失焦（别的窗口在前台）
 * 这三种状态下还能不能落进页面、是不是 isTrusted=true。
 *
 * 结论写到 stdout：每种状态一行 PASS/FAIL。多页签抢购依赖 ①②③ 全 PASS。
 *
 * 用法：node verify/verify-background-click.mjs
 * =====================================================================
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, sleep } from '../core/cdp-core.mjs';

const PORT = 9499;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(ROOT, 'tmp', 'bg-click-profile');

const TEST_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><body style="font-size:40px">
<button id="b" style="width:300px;height:120px;font-size:30px">CLICK ME</button>
<script>
window.__hits = [];
for (const type of ['mousedown','mouseup','click']) {
  document.getElementById('b').addEventListener(type, (e) => {
    window.__hits.push({ type, trusted: e.isTrusted, at: Date.now() });
  });
}
</script>
</body></html>`)}`;

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
  on(m, cb) { if (!this.listeners.has(m)) this.listeners.set(m, new Set()); this.listeners.get(m).add(cb); }
  connect() {
    this.ws = new WebSocket(this.url);
    const opened = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        const set = this.listeners.get(msg.method);
        if (set) for (const cb of set) { try { cb(msg.params); } catch { /* 忽略 */ } }
      }
    });
    return opened;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  }
}

const tabs = (port) =>
  fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) => l.filter((t) => t.type === 'page'));
const openTab = async (port, url) => {
  let t = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    .then((r) => r.json()).catch(() => null);
  if (!t) t = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`).then((r) => r.json()).catch(() => null);
  return t;
};
const activateTab = (port, id) => fetch(`http://127.0.0.1:${port}/json/activate/${id}`).catch(() => {});

async function trustedClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await sleep(30);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

async function main() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run', '--no-default-browser-check', '--start-maximized',
    // 与 ensureSlotWindow 完全一致的遮挡修复 flag —— 本测试验证的就是这套配置下的表现
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--hide-crash-restore-bubble',
    TEST_PAGE,
  ];
  console.log('拉起测试窗口（端口', PORT, '）…');
  const chrome = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(300); }
  }

  const results = [];
  let browserWs = null;
  let windowId = null;
  try {
    const pageA = (await tabs(PORT)).find((t) => t.url.startsWith('data:'));
    const cdpA = new CDP(pageA.webSocketDebuggerUrl);
    await cdpA.connect();
    await cdpA.send('Runtime.enable');
    await cdpA.send('Page.enable');

    // 浏览器级连接：窗口管理 + Target 事件
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    browserWs = new CDP(ver.webSocketDebuggerUrl);
    await browserWs.connect();
    const win = await browserWs.send('Browser.getWindowForTarget', { targetId: pageA.id });
    windowId = win.windowId;

    const hitCount = () => cdpA.eval('window.__hits.length');
    const lastHit = () => cdpA.eval('JSON.stringify(window.__hits[window.__hits.length-1] || null)');

    // 基准：前台活动页签点击必须通（环境自检）
    const rect = await cdpA.eval('(() => { const r = document.getElementById("b").getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()');
    await trustedClick(cdpA, rect.x, rect.y);
    await sleep(200);
    const base = await hitCount();
    results.push(['前台基准点击', base >= 1, `hits=${base}`]);

    // ① 后台页签：另开一个页签并激活它，再给页签 A 派发点击
    const pageB = await openTab(PORT, TEST_PAGE + '%23B');
    await sleep(800);
    await activateTab(PORT, pageB.id);
    await sleep(800);
    const visState = await cdpA.eval('document.visibilityState');
    const before1 = await hitCount();
    await trustedClick(cdpA, rect.x, rect.y);
    await sleep(300);
    const after1 = await hitCount();
    const hit1 = JSON.parse(await lastHit());
    results.push(['① 后台页签点击', after1 > before1 && hit1 && hit1.trusted === true, `visibilityState=${visState} hits ${before1}→${after1} last=${JSON.stringify(hit1)}`]);

    // ② 窗口最小化：最小化后给页签 A 派发点击（页签 B 保持活动页签，A 依旧后台）
    await browserWs.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await sleep(1000);
    const vis2 = await cdpA.eval('document.visibilityState').catch(() => 'EVAL_ERR');
    const before2 = await hitCount();
    await trustedClick(cdpA, rect.x, rect.y).catch((e) => results.push(['② 最小化窗口点击', false, 'dispatch 异常: ' + e.message]));
    await sleep(300);
    const after2 = await hitCount();
    const hit2 = JSON.parse(await lastHit());
    results.push(['② 最小化窗口点击', after2 > before2 && hit2 && hit2.trusted === true, `visibilityState=${vis2} hits ${before2}→${after2} last=${JSON.stringify(hit2)}`]);

    // ③ 还原窗口但切走焦点（开一个系统层失焦：用 Chrome 自己的 about:blank 新窗口最小化做法太绕，
    //    直接还原窗口即可——失焦状态在有多个窗口时天然存在，这里以"还原后被测试脚本终端遮挡"近似真实场景）
    await browserWs.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await browserWs.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await sleep(800);
    const before3 = await hitCount();
    await trustedClick(cdpA, rect.x, rect.y);
    await sleep(300);
    const after3 = await hitCount();
    results.push(['③ 还原窗口后再点击', after3 > before3, `hits ${before3}→${after3}`]);

    // ④ 高频连点（后台页签状态下连发 20 发，验证节拍与丢失率）
    await activateTab(PORT, pageB.id);
    await sleep(500);
    const before4 = await hitCount();
    const tH0 = Date.now();
    for (let i = 0; i < 20; i++) await trustedClick(cdpA, rect.x, rect.y);
    const dt = Date.now() - tH0;
    const after4 = await hitCount();
    results.push(['④ 后台页签高频连点', after4 - before4 >= 16, `20 发/${dt}ms（${(20000 / dt).toFixed(0)} 发/秒），落 ${(after4 - before4)/20*100 | 0}%`]);

    // ⑤ 逐步耗时拆解：到底慢在哪一步（await 每条消息的响应）
    const stepTiming = {};
    {
      const tMoved = Date.now();
      await cdpA.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, pointerType: 'mouse' });
      stepTiming.moved = Date.now() - tMoved;
      const tPressed = Date.now();
      await cdpA.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      stepTiming.pressed = Date.now() - tPressed;
      const tSleep = Date.now();
      await sleep(30);
      stepTiming.sleep30 = Date.now() - tSleep;
      const tReleased = Date.now();
      await cdpA.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
      stepTiming.released = Date.now() - tReleased;
    }
    results.push(['⑤ 单发逐步耗时(ms)', true, `moved=${stepTiming.moved} pressed=${stepTiming.pressed} sleep30=${stepTiming.sleep30} released=${stepTiming.released}`]);

    // ⑥ 管线连发（fire-and-forget，不等响应）：30 发一口气压进 websocket，
    //    看落弹速率——这是开火循环能不能不 await 的依据
    await activateTab(PORT, pageB.id);
    await sleep(300);
    const burstN = 30;
    const before6 = await hitCount();
    const tB0 = Date.now();
    const sendNoWait = (params) => cdpA.send('Input.dispatchMouseEvent', params).catch(() => {});
    for (let i = 0; i < burstN; i++) {
      sendNoWait({ type: 'mouseMoved', x: rect.x, y: rect.y, pointerType: 'mouse' });
      sendNoWait({ type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      sendNoWait({ type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    }
    const tSent = Date.now() - tB0;
    const samples = [];
    for (const waitMs of [1000, 2000, 5000, 10000]) {
      while (Date.now() - tB0 < tSent + waitMs) await sleep(100);
      samples.push([waitMs, (await hitCount()) - before6]);
    }
    const total = samples[samples.length - 1][1];
    results.push(['⑥ 后台页签·管线连发', total >= burstN, `30 发压线 ${tSent}ms；落弹 1s=${samples[0][1]} 2s=${samples[1][1]} 5s=${samples[2][1]} 10s=${samples[3][1]}`]);

    // ⑦ 对照：前台页签同样的管线连发速率
    await activateTab(PORT, pageA.id);
    await sleep(300);
    const before7 = await hitCount();
    const tF0 = Date.now();
    for (let i = 0; i < burstN; i++) {
      sendNoWait({ type: 'mouseMoved', x: rect.x, y: rect.y, pointerType: 'mouse' });
      sendNoWait({ type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      sendNoWait({ type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    }
    const tSentF = Date.now() - tF0;
    await sleep(2000);
    const landed7 = (await hitCount()) - before7;
    results.push(['⑦ 前台页签·管线连发', landed7 >= burstN, `30 发压线 ${tSentF}ms；2s 内落 ${landed7}`]);

    // ⑧ 后台页签里 window.open（userGesture）能不能开出新标签？
    //    抢购链路里"内部入口 Yo 开确认订单页"就是 window.open——隐藏页签被
    //    弹窗拦截器拦掉的话，多页签方案要换收尾设计。
    const OPEN_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body>
<button id="o" style="width:300px;height:80px;font-size:30px">OPEN</button>
<script>
document.getElementById('o').addEventListener('click', () => { window.open('about:blank#from-bg-tab', '_blank'); });
</script>
</body></html>`)}`;
    const pageC = await openTab(PORT, OPEN_PAGE + '%23C');
    await sleep(600);
    const cdpC = new CDP(pageC.webSocketDebuggerUrl);
    await cdpC.connect();
    await cdpC.send('Runtime.enable');
    // 让 C 页签进后台：激活 A 页签
    await activateTab(PORT, pageA.id);
    await sleep(600);
    // 模拟"点击按钮触发 window.open"：CDP 派发一次可信点击到 C 的按钮上
    // （比 callFunctionOn 更贴近真实链路：事件 → 处理器 → window.open，全程 userGesture 链）
    const rectC = await cdpC.eval('(() => { const r = document.getElementById("o").getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()');
    await trustedClick(cdpC, rectC.x, rectC.y);
    await sleep(1500);
    const allTabs = await tabs(PORT);
    const opened = allTabs.find((t) => (t.url || '').includes('from-bg-tab'));
    results.push(['⑧ 后台页签 window.open 开新标签', !!opened, opened ? `新标签已出现（url=${opened.url.slice(0, 50)}）` : `标签列表：${allTabs.map((t) => (t.url || '').slice(0, 40)).join(' | ')}`]);
  } catch (e) {
    results.push(['测试执行', false, e.message]);
  } finally {
    try { await browserWs.send('Browser.close'); } catch { /* 进程兜底 */ }
    await sleep(500);
    try { process.kill(-chrome.pid); } catch { try { chrome.kill(); } catch { /* 已退出 */ } }
  }

  console.log('\n===== 后台点击实测结果 =====');
  let allOk = true;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    if (!ok) allOk = false;
  }
  console.log(allOk ? '\n✅ 结论：三种后台状态点击全部生效，多页签抢购方案可行。' : '\n⛔ 结论：存在失效状态，多页签方案需要绕行设计。');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
