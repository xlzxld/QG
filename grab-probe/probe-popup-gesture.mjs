#!/usr/bin/env node
/** 最小复现：trustedClick 触发 window.open 还灵不灵 + 抓弹窗拦截的控制台消息 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CDP, listTabs, sleep, trustedClick } from '../grab/cdp-core.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT_HTTP = 9471, PORT_CDP = 9472;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-probe-'));

const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/target')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>target</title>TARGET'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<div id="log"></div><button id="b" onclick="try{ const w = window.open('/target'); document.title = w ? 'OPENED' : 'BLOCKED'; }catch(e){ document.title='ERR:'+e.message }" style="width:200px;height:60px">BUY</button>
  <script>['mousedown','mouseup','click','pointerdown'].forEach(t=>document.addEventListener(t,e=>{document.getElementById('log').textContent += t+'@'+e.target.id+' ';},true));</script>`);
}).listen(PORT_HTTP);

const child = spawn(CHROME, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT_CDP}`, '--no-first-run', '--no-default-browser-check', '--window-size=1100,800', '--disable-features=CalculateNativeWinOcclusion', `http://127.0.0.1:${PORT_HTTP}/`], { stdio: 'ignore' });
let tab;
for (let i = 0; i < 100 && !tab; i++) { await sleep(200); tab = (await listTabs(PORT_CDP).catch(() => [])).find((t) => (t.url || '').includes(String(PORT_HTTP))); }
const cdp = new CDP(tab.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');
const con = [];
cdp.on('Runtime.consoleAPICalled', (p) => con.push((p.args || []).map((a) => a.value || a.description || '').join(' ')));
cdp.on('Page.javascriptDialogOpening', () => con.push('DIALOG'));

await sleep(1000);
await cdp.send('Page.enable').catch(()=>{});
// 试验0：浏览器级查窗口状态并强制 normal 前台
try {
  const v = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/version`)).json();
  const bws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.addEventListener('open', res, { once: true }); bws.addEventListener('error', rej, { once: true }); });
  let bid = 0; const pend = new Map();
  bws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  const bsend = (method, params = {}) => new Promise((res) => { const i = ++bid; pend.set(i, res); bws.send(JSON.stringify({ id: i, method, params })); });
  const win = await bsend('Browser.getWindowForTarget', { targetId: tab.id });
  console.log('窗口状态:', JSON.stringify(win.bounds));
  await bsend('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
  await sleep(300);
  await bsend('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'maximized' } });
  await bsend('Target.activateTarget', { targetId: tab.id });
  await sleep(800);
  bws.close();
} catch (e) { console.log('浏览器级操作失败:', e.message); }
console.log('强制前台后 visibility:', await cdp.eval('document.visibilityState').catch(()=>'?'));
const pos = await cdp.eval(`(() => { const el = document.getElementById('b'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
await trustedClick(cdp, pos.x, pos.y);
await sleep(2000);
let evlog = await cdp.eval("document.getElementById('log').textContent").catch(() => '?');
console.log('试验1(bringToFront+click) 事件:', evlog || '（无）');
// 试验2：不带 pointerType 的原始三连
if (!evlog) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(1200);
  evlog = await cdp.eval("document.getElementById('log').textContent").catch(() => '?');
  console.log('试验2(无pointerType) 事件:', evlog || '（无）');
}
// 试验3：触摸事件模拟
if (!evlog) {
  try {
    await cdp.send('Input.dispatchTouchEvent', { touchPoints: [{ x: pos.x, y: pos.y }] });
    await sleep(800);
    await cdp.send('Input.dispatchTouchEvent', { touchPoints: [] });
  } catch (e) { console.log('触摸不可用:', e.message); }
  await sleep(800);
  evlog = await cdp.eval("document.getElementById('log').textContent").catch(() => '?');
  console.log('试验3(触摸) 事件:', evlog || '（无）');
}
await sleep(1500);
const evlog0 = await cdp.eval("document.getElementById('log').textContent").catch(() => '?');
console.log('页面收到的事件:', evlog0 || '（无——事件根本没到达）');
const focus = await cdp.eval("JSON.stringify({hasFocus: document.hasFocus(), dpr: devicePixelRatio, vis: document.visibilityState})").catch(()=>'?');
console.log('页面状态:', focus);
const title = await cdp.eval('document.title').catch(() => '?');
const tabs = await listTabs(PORT_CDP);
console.log('按钮 title（OPENED=弹窗放行 / BLOCKED=被拦）:', title);
console.log('标签列表:', tabs.map((t) => (t.url || '').slice(0, 60)).join(' | '));
console.log('控制台消息:', con.length ? con.join(' / ') : '（无）');
try { child.kill(); } catch {}
await sleep(600);
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
srv.close();
process.exit(0);
