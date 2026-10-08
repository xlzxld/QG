/**
 * 登录态判据 · 实测（2026-10-07 第三版）
 *
 * 判据定稿（grab/huawei.user.js / cdp-core.mjs）：
 *   ① 页面自己流量里的"登录已过期"硬信号（60 秒内）→ 未登录
 *   ② GET openapi.vmall.com/mcp/queryUserInfo（主判据，带 Cookie 问服务端）
 *        已登录 → {"userInfo":{"authCust":true,"custGrad":3,"nickName":"..."}}
 *        未登录 → {"data":"user not login.","resultCode":"200916"}
 *   ③ 本地可见的会话 Cookie（跨站通常看不到）
 *   ④ 页面登录标记（最后兜底，等水合 + 多拍）
 *   ⑤ 都不行 → unknown（不猜、不拦、继续跑）
 *
 * 四个场景：
 *   S1 未登录（接口返回 200916）                    → 期望 未登录
 *   S2 已登录（接口返回 userInfo）+ 页面显示"请登录"  → 期望 已登录（接口压过页面文案）
 *   S3 已登录但接口报"登录已过期"                    → 期望 未登录（过期信号压过一切）
 *   S4 ★用户实测场景★ 跨站 Cookie 读不到 + 页面无标记
 *      → 接口返回 userInfo 时必须判"已登录"（旧版在这里误判成未登录）
 *
 * 用法：node grab-probe/verify-login-detect.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const cfg = JSON.parse(readFileSync(ROOT + 'data/grab/huawei.config.json', 'utf8'));
const PAGE = cfg.products[2].url; // 列表内商品（Pura X View）
const userJs = readFileSync(ROOT + 'grab/huawei.user.js', 'utf8');

const USER_INFO = '{"code":"0","success":true,"userInfo":{"authCust":true,"custGrad":3,"experience":9150,"isBindPhone":"true","nickName":"Always","uid":"260086000252356047","userAccount":"hw96784124"}}';
const NOT_LOGIN = '{"data":"user not login.","info":"用户未登录","resultCode":"200916"}';
const EXPIRED = '{"info":"登录已过期，请重新登录","resultCode":"200916"}';

async function run(browser, opts) {
  const { sessionCookies = false, userInfoReply = 'out', fakeLoginText = null, injectExpired = false } = opts;
  // 复用同一个浏览器实例，每个场景单独开 context（每个场景仍完全隔离）
  const ctx = await browser.newContext();

  // 注意：S4 故意**不放**任何 Cookie —— 这正是用户浏览器里"跨站读不到"的情形
  if (sessionCookies) {
    await ctx.addCookies([
      { name: 'sid', value: 'S'.repeat(84), domain: '.id1.cloud.huawei.com', path: '/' },
      { name: 'hwid_cas_sid', value: 'C'.repeat(84), domain: '.id1.cloud.huawei.com', path: '/' },
    ]);
  }

  // GM_cookie 垫片：模拟油猴"读不到跨站 Cookie"——只回 vmall 域下能看到的
  await ctx.exposeFunction('__gmCookieList', async (details) => {
    const all = await ctx.cookies();
    const want = String(details.domain || '').replace(/^\./, '');
    return all
      .filter((c) => c.domain.replace(/^\./, '').endsWith('vmall.com'))
      .filter((c) => !want || c.domain.replace(/^\./, '').endsWith(want))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
  });

  await ctx.addInitScript(`
    window.__gm = {};
    window.GM_getValue = (k, d) => (k in window.__gm ? window.__gm[k] : d);
    window.GM_setValue = (k, v) => { window.__gm[k] = v; };
    window.GM_registerMenuCommand = () => {};
    window.GM_cookie = {
      list: (details, cb) => window.__gmCookieList(details || {}).then((cs) => cb(cs, null)).catch((e) => cb([], String(e))),
    };
    window.GM_xmlhttpRequest = (o) => {
      const ctl = { abort(){} };
      fetch(o.url, { method: o.method || 'GET', headers: o.headers, body: o.data })
        .then((r) => r.text().then((t) => o.onload && o.onload({ status: r.status, responseText: t })))
        .catch((e) => o.onerror && o.onerror({ error: String(e) }));
      return ctl;
    };
    document.addEventListener('DOMContentLoaded', () => {
      ${fakeLoginText ? `
      const d = document.createElement('div');
      d.id = 'fake-login-tip';
      d.textContent = '${fakeLoginText}';
      document.body.appendChild(d);
      ` : ''}
    });
  `);

  const page = await ctx.newPage();

  // 桥接代理（真实 GM_xmlhttpRequest 绕过 CORS，垫片用页面 fetch）
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

  // ★ queryUserInfo：登录态主判据 —— 按场景返回
  // ⚠ 跨域带凭据的请求不能用 `Access-Control-Allow-Origin: *`：
  //   必须回显具体来源并声明 allow-credentials，否则浏览器直接拦掉
  //   （实测被这个卡了一轮）。真实服务器就是这么返回的，所以正式环境能通。
  const corsFor = (req) => ({
    'access-control-allow-origin': req.headers()['origin'] || 'https://item.vmall.com',
    'access-control-allow-credentials': 'true',
  });
  await page.route('**/queryUserInfo**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...corsFor(req), 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': '*' } });
    if (userInfoReply === 'error') return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsFor(req),
      body: userInfoReply === 'in' ? USER_INFO : NOT_LOGIN,
    });
  });

  // 页面自身流量里的"登录已过期"（模拟会话中途失效）
  if (injectExpired) {
    await page.route('**/probe-expired**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': route.request().headers()['origin'] || 'https://item.vmall.com',
          'access-control-allow-credentials': 'true',
        },
        body: EXPIRED,
      }));
    await ctx.addInitScript(`
      window.addEventListener('DOMContentLoaded', () => {
        let n = 0;
        const t = setInterval(() => {
          if (++n > 22) return clearInterval(t);
          fetch('https://openapi.vmall.com/mcp/probe-expired?n=' + n).catch(() => {});
        }, 700);
      });
    `);
  }

  await page.addInitScript(userJs);

  const logs = [];
  page.on('console', (m) => logs.push(m.text()));

  console.log('    …加载页面');
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log('    …等 11 秒采集日志');
  await page.waitForTimeout(11000);

  const joined = logs.join('\n');
  // 取**最后一次**判定（状态会被后续信号刷新）
  const marks = [
    { re: /登录态：已登录/g, v: '已登录' },
    { re: /未登录（/g, v: '未登录' },
    { re: /登录态无法确认/g, v: 'unknown' },
  ];
  let verdict = '（未判定）';
  let lastIdx = -1;
  for (const m of marks) {
    let hit;
    while ((hit = m.re.exec(joined)) !== null) {
      if (hit.index > lastIdx) { lastIdx = hit.index; verdict = m.v; }
    }
  }

  const relevant = logs.filter((l) => /登录|凭据|queryUserInfo/.test(l)).map((l) => l.slice(0, 150));
  console.log('    …关闭上下文');
  // ⚠ 必须先卸路由再关：脚本的登录等待循环每 2 秒打一次 queryUserInfo，
  //   路由处理器挂着时关闭会一直等（实测卡死在这一步）。
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 10000))]);
  console.log('    …已关闭');
  return { verdict, relevant };
}

const cases = [
  ['S1 未登录（接口 200916）', { userInfoReply: 'out' }, '未登录'],
  ['S2 已登录 + 页面显示"请登录"', { sessionCookies: true, userInfoReply: 'in', fakeLoginText: '请登录' }, '已登录'],
  ['S3 已登录但接口报"登录已过期"', { sessionCookies: true, userInfoReply: 'in', injectExpired: true }, '未登录'],
  ['S4 ★跨站读不到 Cookie + 页面无标记（用户实测场景）', { sessionCookies: false, userInfoReply: 'in' }, '已登录'],
];

let allPass = true;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [label, opts, expect] of cases) {
  console.log(`════════ ${label} → 期望：${expect} ════════`);
  const r = await run(browser, opts);
  const ok = r.verdict === expect;
  allPass = allPass && ok;
  console.log(`  判定结果：${r.verdict}　${ok ? '✅ 通过' : '❌ 失败'}`);
  r.relevant.slice(-4).forEach((l) => console.log(`    ${l}`));
  console.log('');
}

await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 10000))]).catch(() => {});
console.log(allPass ? '===== 四个场景全通过 =====' : '===== 有失败项 =====');
process.exit(allPass ? 0 : 1);