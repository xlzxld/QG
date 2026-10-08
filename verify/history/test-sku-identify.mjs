/**
 * 油猴脚本真机验证（只读，dryRun）
 * =====================================================================
 * 目的：验证脚本能否
 *   1. 认出当前页面是配置里的哪个商品（不靠关键字）
 *   2. 从 __NEXT_DATA__ 读出目标 SKU 的真实信息
 *   3. 判断是否需要切换规格
 *   4. 读对价格（切规格前后各读一次，验证顺序）
 *
 * 做法：伪造登录态 → 注入脚本 → 采集面板日志与页面状态。
 *       不点任何购买按钮。
 *
 * 用法：node grab-probe/test-sku-identify.mjs
 * =====================================================================
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const body = readFileSync(join(ROOT, 'grab/huawei.user.js'), 'utf8')
  .replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

const TARGET = process.argv[2]
  || 'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

const reports = [];
await page.exposeFunction('__gmFetch', async ({ method, url, headers, data }) => {
  try {
    const r = await fetch(url, { method, headers, body: data });
    const text = await r.text();
    if (url.includes('/api/results/')) {
      try { reports.push(JSON.parse(text)); } catch {}
    }
    return { ok: true, status: r.status, responseText: text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 注入 GM_* 垫片，并伪造登录态（isLoggedIn 靠"我的商城/退出"这些文字判断）
await page.addInitScript(() => {
  const store = {};
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = (o) => {
    window.__gmFetch({ method: o.method || 'GET', url: o.url, headers: o.headers, data: o.data })
      .then((r) => { if (r.ok) o.onload && o.onload({ status: r.status, responseText: r.responseText }); else o.onerror && o.onerror(new Error(r.error)); });
  };
  // 伪造"已登录"标记（页面顶部导航里会出现这些文字）
  const fake = () => {
    const h = document.querySelector('#header, .header, header') || document.body;
    if (h && !document.getElementById('__fake-login')) {
      const d = document.createElement('div');
      d.id = '__fake-login';
      d.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;display:none';
      d.textContent = '我的商城 退出';
      h.appendChild(d);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fake);
  else fake();
});

console.log('打开', TARGET);
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(4000);

try {
  await page.evaluate(`(async () => { ${body} })()`);
} catch (e) {
  console.log('注入异常:', e.message);
}
await page.waitForTimeout(7000);

const probe = await page.evaluate(() => {
  const p = document.querySelector('#qp-huawei-grab-panel');
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // 直接读 __NEXT_DATA__ 里所有 SKU，验证脚本读到的是不是同一个
  let skus = [];
  try {
    const pp = JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps;
    const base = pp.mainData.current.base || {};
    const rush = pp.extData?.skuRushbuyInfo?.skuRushBuyInfoList || [];
    skus = Object.keys(base).map((code) => {
      const r = rush.find((x) => String(x.sbomCode) === code);
      return {
        code,
        name: base[code].name,
        price: base[code].price,
        buttonMode: base[code].buttonMode,
        startTime: r ? r.startTime : null,
      };
    });
  } catch (e) { /* ignore */ }

  return {
    finalUrl: location.href,
    title: document.title,
    panel: p
      ? {
          phase: p.querySelector('#qp-phase')?.textContent?.trim(),
          logs: [...p.querySelectorAll('#qp-log div')].map((d) => clean(d.textContent)),
        }
      : null,
    hasBuyButton: /立即购买|立即申购|加入购物车|马上抢|立即抢购/.test(clean(document.body?.innerText)),
    textLen: clean(document.body?.innerText).length,
    skuCount: skus.length,
    skuSample: skus.slice(0, 4),
  };
});

const out = { target: TARGET, ...probe, reports };
mkdirSync(join(__dirname, 'output'), { recursive: true });
const f = join(__dirname, `output/sku-identify.json`);
writeFileSync(f, JSON.stringify(out, null, 2));

console.log('\n=== 面板 ===');
console.log('阶段:', probe.panel?.phase);
console.log('日志:');
(probe.panel?.logs || []).forEach((l) => console.log('  ', l));
console.log('\n=== 页面 ===');
console.log('最终 URL:', probe.finalUrl);
console.log('有购买按钮:', probe.hasBuyButton);
console.log('\n=== 页面上的 SKU（共', probe.skuCount, '个）===');
probe.skuSample.forEach((s) => console.log('  ', s.code, '¥' + s.price, 'bm=' + s.buttonMode, s.startTime ? new Date(s.startTime).toISOString().slice(5, 16) : ''));
console.log('\n=== 脚本回报 ===');
console.log(reports.length ? JSON.stringify(reports, null, 1) : '(无)');
console.log('\n落盘:', f);

await browser.close();