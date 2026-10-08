/**
 * 商品列表闸门 · 浏览器实测（2026-10-07）
 *
 * 验证脚本在真实 vmall 页面上的行为。**关键：必须先 seed 配置缓存**——
 * 没有缓存时脚本会因「无法确认本页是否在列表内」而提前退出，
 * 那样测的就不是商品列表闸门，而是「无缓存退出」了（第一版就踩了这个坑）。
 *
 * 判定口径（只看脚本自己的动作，不看页面自身的 vmall 流量）：
 *   · 发往 127.0.0.1:3100 的请求 = 脚本动作
 *   · #qp-huawei-grab-panel 存在 = 脚本插了面板
 *   · GM 缓存被写入 = 脚本改了持久状态
 *
 * 用法：node grab-probe/verify-list-gate.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const cfg = JSON.parse(readFileSync(new URL('data/grab/huawei.config.json', ROOT), 'utf8'));
const pidOf = (p) => String(p.prdId ?? (p.url || '').match(/prdId=(\d+)/)?.[1] ?? '');
const inList = cfg.products.map(pidOf);

const IN_LIST = cfg.products[2]; // Pura X View（列表内）
// 对照组：随便一个不在列表里的商品编号。取不到页面也没关系——
// checkTarget 靠 URL 里的 prdId 判定，页面即 404 也照样能验闸门。
const OUT_OF_LIST = {
  id: '不在列表的对照商品',
  url: 'https://item.vmall.com/product/comdetail/index.html?prdId=10086751595085&sbomCode=2601010648113',
};

console.log('商品列表 prdId：', inList.join('、'));
console.log('对照组 prdId：', pidOf(OUT_OF_LIST), '（不在列表内）');
console.log('（对照页面可能 404 —— 不影响：闸门靠 URL 里的 prdId 判定）\n');

const userJs = readFileSync(new URL('grab/huawei.user.js', ROOT), 'utf8');

async function probe(label, url, expectActive) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext();
  // GM 垫片。关键：GM_xmlhttpRequest 必须**真的发请求**——
  // 脚本现在会从控制台（桥接服务）读商品列表，垫片若不实现回调，
  // 脚本会永远卡在等桥接响应上，测出来的是"卡住"而不是闸门。
  await ctx.exposeFunction('__gmCookieList', async (details) => {
    const all = await ctx.cookies();
    const want = String(details.domain || '').replace(/^\./, '');
    return all
      .filter((c) => !want || c.domain.replace(/^\./, '').endsWith(want))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
  });
  await ctx.addInitScript(`
    window.__net = [];
    window.__gm = {};   // ★ 故意留空：证明列表是从控制台读的，不是靠本地缓存
    window.GM_getValue = (k, d) => (k in window.__gm ? window.__gm[k] : d);
    window.GM_setValue = (k, v) => { window.__gm[k] = v; window.__wrote = (window.__wrote||0)+1; };
    window.GM_registerMenuCommand = () => {};
    window.GM_cookie = {
      list: (details, cb) => {
        window.__gmCookieList(details || {})
          .then((cs) => cb(cs, null))
          .catch((e) => cb([], String(e)));
      },
    };
    window.GM_xmlhttpRequest = (o) => {
      window.__net.push(String(o.url));
      const ctl = { aborted: false, abort(){ this.aborted = true; } };
      fetch(o.url, { method: o.method || 'GET', headers: o.headers, body: o.data })
        .then((r) => r.text().then((t) => {
          if (ctl.aborted) return;
          o.onload && o.onload({ status: r.status, responseText: t });
        }))
        .catch((e) => { if (!ctl.aborted && o.onerror) o.onerror({ error: String(e) }); });
      return ctl;
    };
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...r) {
      window.__net.push(String(u));
      return oo.call(this, m, u, ...r);
    };
  `);
  const page = await ctx.newPage();
  // 桥接请求代理到本机真实控制台（真实 GM_xmlhttpRequest 绕过 CORS，测试垫片用
  // 的是页面 fetch，不加这层会卡在读不到列表上，测出来是 CORS 而不是闸门）。
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
  await page.addInitScript(userJs); // 注入真实脚本

  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`.slice(0, 220)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);

  const r = await page.evaluate(() => ({
    panel: !!document.getElementById('qp-huawei-grab-panel'),
    // 脚本流量 = 指向本机桥接（页面自己那些 openapi.vmall.com 不算）
    scriptNet: (window.__net || []).filter((u) => /127\\.0\\.0\\.1:3100|localhost:3100/.test(u)),
    wroteCount: window.__wrote || 0,
    pageUrl: location.href.slice(0, 90),
  }));

  // 面板/DOM 是主要判据；"向桥接发请求"现在是**正常**行为（读控制台列表），
  // 所以列表外页面只否定"面板"和"写缓存"两件事。
  const active = r.panel || r.wroteCount > 0;
  const pass = active === expectActive;

  console.log(`──── ${label} ────`);
  console.log(`期望 ${expectActive ? '脚本接管' : '脚本零动作'}　实际 ${active ? '有动作' : '零动作'}　→ ${pass ? '✅ 通过' : '❌ 失败'}`);
  console.log(`  落点页面：${r.pageUrl}`);
  console.log(`  面板 DOM：${r.panel ? '❌ 已插入' : '✅ 未插入'}`);
  console.log(`  脚本网络请求：${r.scriptNet.length ? '❌ ' + JSON.stringify(r.scriptNet) : '✅ 无'}`);
  console.log(`  GM 缓存写入：${r.wroteCount ? `❌ ${r.wroteCount} 次` : '✅ 未写'}`);
  const note = logs.filter((l) => /抢购脚本/.test(l)).slice(0, 3);
  if (note.length) console.log(`  脚本自述：\n     ${note.join('\n     ')}`);
  if (errors.length) console.log(`  ⚠ 页面报错：${errors.join(' | ')}`);
  console.log('');

  await browser.close();
  return pass;
}

const a = await probe('A. 不在列表的商品页（必须零动作）', OUT_OF_LIST.url, false);
const b = await probe('B. 列表内商品页（应正常接管）', IN_LIST.url, true);
console.log(a && b ? '===== 两项全通过 =====' : '===== 有失败项 =====');
process.exit(a && b ? 0 : 1);