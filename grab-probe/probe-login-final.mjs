/**
 * 登录态判据·终局探针（2026-10-07）
 *
 * 已知：queryRecommendConfig 主动请求两边都返回 200916 → 不是判据。
 * 但页面「是否请求它」两边不同 → 页面从别处知道登录态。
 * 本轮：抓**所有域名**的请求 + 取**全部 cookie（含 HttpOnly）**做差异。
 *
 * 用法：node grab-probe/probe-login-final.mjs
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const PAGE = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086683896486&sbomCode=2601010634026';
const PORT = 9401;
const AUTHISH = /login|user|member|account|passport|auth|uc\b|sso|token|nick/i;

/* ── 未登录 ── */
async function anon() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const urls = new Set();
  page.on('request', (r) => urls.add(r.url()));
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);
  const cookies = await ctx.cookies();
  await browser.close();
  return { urls: [...urls], cookies };
}

/* ── 已登录 ── */
async function acc1() {
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const tab = tabs.find((t) => t.type === 'page' && /comdetail/.test(t.url)) || tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0; const pending = new Map(); const urls = new Set();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') urls.add(m.params.request.url);
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Network.enable', { maxResourceBufferSize: 20 * 1024 * 1024 });
  await send('Page.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 12000));
  const all = await send('Network.getAllCookies', {});
  try { ws.close(); } catch { /* 收尾 */ }
  return { urls: [...urls], cookies: (all.cookies || []).map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly, size: (c.value || '').length })) };
}

const strip = (u) => u.replace(/^https?:\/\//, '').split('?')[0];
const hostOf = (u) => { try { return new URL(u).host; } catch { return '?'; } };

const A = await anon();
console.log('=========== A. 未登录 ===========');
console.log(`  请求域名：${[...new Set(A.urls.map(hostOf))].join(', ')}`);
console.log(`  Cookie 数：${A.cookies.length}`);
for (const c of A.cookies.filter((c) => AUTHISH.test(c.name))) console.log(`    ★ ${c.name} @${c.domain} len=${c.value.length}`);

const B = await acc1();
console.log('\n=========== B. 已登录 acc1 ===========');
console.log(`  请求域名：${[...new Set(B.urls.map(hostOf))].join(', ')}`);
console.log(`  Cookie 数：${B.cookies.length}`);
for (const c of B.cookies.filter((c) => AUTHISH.test(c.name))) console.log(`    ★ ${c.name} @${c.domain} len=${c.size} ${c.httpOnly ? '(HttpOnly)' : ''}`);

/* Cookie 差异 */
const an = new Set(A.cookies.map((c) => `${c.domain}|${c.name}`));
const bn = new Set(B.cookies.map((c) => `${c.domain}|${c.name}`));
console.log('\n=========== 只在「已登录」存在的 Cookie ★★★ ===========');
const bOnly = B.cookies.filter((c) => !an.has(`${c.domain}|${c.name}`));
if (!bOnly.length) console.log('  （无）');
for (const c of bOnly) console.log(`  ${c.name} @${c.domain} len=${c.size} ${c.httpOnly ? '(HttpOnly)' : ''}`);

console.log('\n=========== 只在「未登录」存在的 Cookie ===========');
const aOnly = A.cookies.filter((c) => !bn.has(`${c.domain}|${c.name}`));
if (!aOnly.length) console.log('  （无）');
for (const c of aOnly) console.log(`  ${c.name} @${c.domain} len=${c.value.length}`);

/* 请求差异（看路径） */
const ap = new Set(A.urls.map(strip));
const bp = new Set(B.urls.map(strip));
console.log('\n=========== 只在「已登录」发出的请求 ===========');
const bOnlyReq = [...bp].filter((u) => !ap.has(u) && !/OPTIONS|\/hmi\/log/i.test(u));
if (!bOnlyReq.length) console.log('  （无）');
for (const u of bOnlyReq.slice(0, 30)) console.log(`  ${u}`);
console.log(`  （共 ${bOnlyReq.length} 条）`);

console.log('\n=========== 只在「未登录」发出的请求 ===========');
const aOnlyReq = [...ap].filter((u) => !bp.has(u));
if (!aOnlyReq.length) console.log('  （无）');
for (const u of aOnlyReq.slice(0, 30)) console.log(`  ${u}`);