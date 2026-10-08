/**
 * queryUserInfo —— 登录态判据验证（2026-10-07）
 *
 * 已知：会员页请求 openapi.vmall.com/mcp/queryUserInfo，已登录返回
 *   {"code":"0","success":true,"userInfo":{"authCust":true,"custGrad":3,"nickName":"...","uid":"..."}}
 *   （custGrad=3 正好对应页面上的"V3 等级"）
 *
 * 本脚本验证三件事：
 *   1. 这个接口的完整 URL / 方法（从会员页抓）
 *   2. 在**商品页**调用它，已登录时能否拿到 userInfo
 *   3. 未登录时它返回什么（无头新 profile）
 * 前两条成立 → 它就是可用的响应判据（不依赖跨站 Cookie 可见性）。
 *
 * 用法：node grab-probe/verify-userinfo-api.mjs
 */
import { chromium } from 'playwright-core';
import { CDP } from '../grab/cdp-core.mjs';

const PORT = 9401;

/* ── 1. 从 acc1 会员页抓 queryUserInfo 的完整请求 ── */
async function grabRequest() {
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('https://www.vmall.com/member/index.html')}`, { method: 'PUT' }).then((r) => r.json());
  const m = new CDP(created.webSocketDebuggerUrl);
  await m.connect();
  await m.send('Network.enable');
  let hit = null;
  m.on('Network.requestWillBeSent', (p) => {
    if (/queryUserInfo/i.test(p.request.url)) hit = { url: p.request.url, method: p.request.method, headers: p.request.headers };
  });
  for (let i = 0; i < 24 && !hit; i++) await new Promise((r) => setTimeout(r, 500));
  await fetch(`http://127.0.0.1:${PORT}/json/close/${created.id}`).catch(() => {});
  try { m.ws.close(); } catch { /* 收尾 */ }
  return hit;
}

/* ── 2/3. 在指定环境的页面里调用它 ── */
const CALL = (url) => `(async () => {
  try {
    const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    const t = await r.text();
    return JSON.stringify({ status: r.status, body: t.slice(0, 400) });
  } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
})()`;

async function callInAcc1ProductPage(url) {
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const tab = tabs.find((t) => t.type === 'page' && /comdetail/.test(t.url));
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  const r = await cdp.eval(CALL(url));
  try { cdp.ws.close(); } catch { /* 收尾 */ }
  return JSON.parse(r);
}

async function callAnon(url) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto('https://item.vmall.com/product/comdetail/index.html?prdId=10086683896486&sbomCode=2601010634026', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const r = await page.evaluate(CALL(url));
  await browser.close();
  return JSON.parse(r);
}

const req = await grabRequest();
if (!req) { console.log('✘ 没抓到 queryUserInfo 请求'); process.exit(1); }
console.log('【接口】');
console.log(`  ${req.method} ${req.url}`);
console.log(`  请求头（部分）：${Object.keys(req.headers).filter((k) => /cookie|auth|token|content/i.test(k)).join(', ') || '（无鉴权类头）'}`);

const full = req.url.startsWith('http') ? req.url : `https://openapi.vmall.com${req.url}`;

console.log('\n【已登录 · 在 acc1 商品页调用】');
const b = await callInAcc1ProductPage(full);
console.log(`  HTTP ${b.status || '?'}  ${b.error || b.body}`);

console.log('\n【未登录 · 无头新 profile 商品页调用】');
const a = await callAnon(full);
console.log(`  HTTP ${a.status || '?'}  ${a.error || a.body}`);

const bIn = /"userInfo"|authCust|nickName/i.test(b.body || '');
const aIn = /"userInfo"|authCust|nickName/i.test(a.body || '');
console.log('\n【结论】');
if (bIn && !aIn) console.log('  ✅ 可用作响应判据：已登录返回 userInfo，未登录没有');
else if (bIn && aIn) console.log('  ⚠️ 两边都有 userInfo —— 不能作判据');
else console.log('  ❓ 需要人工看上面原始响应');