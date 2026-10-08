/**
 * SPA 站内跳转闸门 · 浏览器实测（2026-10-07）
 *
 * 验的是最隐蔽的一条：vmall 是 Next.js 单页应用，站内点推荐位跳转
 * **不重新加载文档** → 油猴脚本不重启 → 修复前的 checkTarget 只在
 * 启动时跑一次，会继续盯着**新商品**抢（还绑着上一个商品的规格和价格上限）。
 *
 * 做法：先打开列表内商品页让脚本接管，再用 history.pushState 模拟
 * 站内跳到列表外商品（和 Next.js 路由同样的机制），看脚本是否立刻停手：
 *   · 面板被撤掉（teardownPanel）
 *   · 页面 DOM 上不再有脚本痕迹
 *
 * 用法：node verify/verify-spa-gate.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const cfg = JSON.parse(readFileSync(new URL('data/grab/huawei.config.json', ROOT), 'utf8'));
const IN_LIST = cfg.products[2]; // Pura X View
const OTHER = '10086751595085';  // 列表外

console.log(`起点：列表内商品 ${IN_LIST.id}（prdId=${(IN_LIST.url.match(/prdId=(\d+)/) || [])[1]}）`);
console.log(`跳往：列表外商品 prdId=${OTHER}\n`);

const userJs = readFileSync(new URL('platforms/huawei/huawei.user.js', ROOT), 'utf8');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext();
await ctx.exposeFunction('__gmCookieList', async (details) => {
  const all = await ctx.cookies();
  const want = String(details.domain || '').replace(/^\./, '');
  return all
    .filter((c) => !want || c.domain.replace(/^\./, '').endsWith(want))
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
});
await ctx.addInitScript(`
  window.__net = [];
  window.__gm = {};   // 空缓存：列表从控制台读
  window.GM_getValue = (k, d) => (k in window.__gm ? window.__gm[k] : d);
  window.GM_setValue = (k, v) => { window.__gm[k] = v; };
  window.GM_registerMenuCommand = () => {};
  window.GM_cookie = {
    list: (details, cb) => window.__gmCookieList(details || {}).then((cs) => cb(cs, null)).catch((e) => cb([], String(e))),
  };
  window.GM_xmlhttpRequest = (o) => {
    // ★ 必须真的回调，否则脚本永远卡在等桥接响应上（这一版就是踩了这个坑）
    const ctl = { abort(){} };
    fetch(o.url, { method: o.method || 'GET', headers: o.headers, body: o.data })
      .then((r) => r.text().then((t) => o.onload && o.onload({ status: r.status, responseText: t })))
      .catch((e) => o.onerror && o.onerror({ error: String(e) }));
    return ctl;
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { window.__net.push(String(u)); return oo.call(this, m, u, ...r); };
`);
const page = await ctx.newPage();
// 桥接代理（同 verify-list-gate：真实 GM_xmlhttpRequest 绕过 CORS，垫片用页面 fetch）
await page.route('**/127.0.0.1:3100/**', async (route) => {
  const req = route.request();
  try {
    const res = await fetch(req.url(), {
      method: req.method(),
      headers: req.postData() ? { 'content-type': 'application/json' } : undefined,
      body: req.postData() || undefined,
    });
    const body = await res.text();
    await route.fulfill({ status: res.status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body });
  } catch (e) {
    await route.fulfill({ status: 502, headers: { 'access-control-allow-origin': '*' }, body: String(e) });
  }
});
await page.addInitScript(userJs);
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 200)));

await page.goto(IN_LIST.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(10000);

const before = await page.evaluate(() => !!document.getElementById('qp-huawei-grab-panel'));
console.log(`跳之前：面板 ${before ? '✅ 已插入（脚本已接管）' : '❌ 未插入，测不了'}`);
if (!before) { console.log('浏览器日志：\n' + logs.slice(-10).join('\n')); await browser.close(); process.exit(1); }

// 模拟 Next.js 站内跳转：走 history.pushState + 换DOM，**不重载文档**
await page.evaluate((prdId) => {
  history.pushState({}, '', `/product/comdetail/index.html?prdId=${prdId}&sbomCode=2601010648113`);
  document.title = '（模拟跳转后的商品）';
  // 换掉商品标题，模拟换页
  const h = document.querySelector('h1, .prd-title, [class*=title]');
  if (h) h.textContent = '一个不在商品列表里的商品';
}, OTHER);

// 哨兵是 500ms 一轮 + pushState 立即触发，给 2.5s 足够
await page.waitForTimeout(2500);

const after = await page.evaluate(() => ({
  panel: !!document.getElementById('qp-huawei-grab-panel'),
  url: location.href.slice(0, 90),
}));
const stopLogs = logs.filter((l) => /已停止一切动作|已离开|列表之外/.test(l));

console.log('');
console.log('跳之后：');
console.log(`  页面 URL：${after.url}`);
console.log(`  面板 DOM：${after.panel ? '❌ 仍在（脚本还在页面上运作）' : '✅ 已撤掉'}`);
if (stopLogs.length) console.log(`  脚本自述：${stopLogs[stopLogs.length - 1]}`);

const pass = !after.panel;
console.log('');
console.log(pass ? '===== 通过：SPA 跳到列表外商品后脚本已停手 =====' : '===== 失败：脚本仍在新商品页上运作 =====');
await browser.close();
process.exit(pass ? 0 : 1);