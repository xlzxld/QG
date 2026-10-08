/**
 * 用真实 Chromium 模拟油猴环境跑 huawei.user.js，抓运行时报错。
 *
 * 关键：GM_xmlhttpRequest 在油猴里不受 CORS 限制，而页面内 fetch 会被 CORS 拦掉。
 * 所以这里把请求交给 Node 侧（exposeFunction）真实发出，忠实还原 GM_xmlhttpRequest 行为，
 * 否则脚本会在"桥接不可达"处短路，看不到下游的真实报错。
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const SCRIPT = join(ROOT, 'grab/huawei.user.js');
const BRIDGE = 'http://127.0.0.1:3100';

// ── 仿真商品页：照华为真实页面特征搭（#prd-detail 主容器 + #recommendItem 推荐位干扰）──
const FAKE_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>华为商城 - Mate 90 Pro Max 典藏版 16GB+512GB 翡冷翠 官方商城</title>
<style>
 #prd-detail { padding:20px; }
 .price-main { font-size:30px; color:#cf0a2a; display:inline-block; }
 #recommendItem .rec-price { font-size:20px; display:inline-block; }
 #recommendItem .rec-item { display:inline-block; margin:4px; }
 .btn-buy { display:inline-block; padding:10px 30px; background:#cf0a2a; color:#fff; }
 .spec { display:inline-block; padding:6px 12px; margin:2px; border:1px solid #ccc; }
</style></head><body>
<div id="header"><a href="#">我的商城</a><span>退出</span></div>
<div id="prd-detail">
  <h1>Mate 90 Pro Max 16GB+512GB 典藏版 翡冷翠</h1>
  <div class="price-main">¥10999</div>
  <div class="spec-group"><span>颜色</span><span class="spec">翡冷翠</span><span class="spec">曜石灰</span></div>
  <div class="spec-group"><span>版本</span><span class="spec">16GB+512GB 典藏版</span><span class="spec">16GB+1TB</span></div>
  <a class="btn-buy" href="#">立即购买</a>
</div>
<div id="recommendItem">
  <div class="rec-item">推荐机型 A <span class="rec-price">6499</span></div>
  <div class="rec-item">推荐机型 B <span class="rec-price">9999</span></div>
  <div class="rec-item">推荐机型 C <span class="rec-price">12999</span></div>
</div>
<div id="footer">以旧换新可抵扣 ¥950805</div>
</body></html>`;

const userJs = readFileSync(SCRIPT, 'utf8');
const body = userJs.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const logs = [];
const reqs = [];
page.on('console', (m) => {
  const t = m.text();
  if (/vmallres\.com|WebGL|first input delay/i.test(t)) return; // 过滤站点自身的 Next.js 噪音
  logs.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`));

// Node 侧真实 HTTP —— 等价于 GM_xmlhttpRequest（无 CORS 限制）
await page.exposeFunction('__gmFetch', async ({ method, url, headers, data }) => {
  reqs.push(`${method} ${url}`);
  try {
    const r = await fetch(url, { method, headers, body: data });
    return { ok: true, status: r.status, responseText: await r.text() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

await page.addInitScript(() => {
  const store = {};
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = (opts) => {
    window.__gmFetch({ method: opts.method || 'GET', url: opts.url, headers: opts.headers, data: opts.data })
      .then((res) => {
        if (!res.ok) return opts.onerror && opts.onerror(new Error(res.error));
        opts.onload && opts.onload({ status: res.status, responseText: res.responseText });
      });
  };
});

await page.goto('https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446');
await page.setContent(FAKE_PAGE, { waitUntil: 'domcontentloaded' });

// 记录脚本点过哪些按钮，验证选择器准不准
await page.evaluate(() => {
  window.__clicks = [];
  document.addEventListener('click', (e) => {
    const el = e.target.closest('a,button,div,span');
    if (el) window.__clicks.push((el.innerText || el.textContent || '').trim().slice(0, 30));
  }, true);
});

try {
  await page.evaluate(`(async () => { ${body} })()`);
} catch (e) {
  logs.push(`[EVAL_THROW] ${e.message}`);
}

await page.waitForTimeout(7000);

const result = await page.evaluate(() => {
  const p = document.querySelector('#qp-huawei-grab-panel');
  return {
    panel: p ? {
      phase: p.querySelector('#qp-phase')?.textContent,
      logs: [...p.querySelectorAll('#qp-log div')].map((d) => d.textContent),
    } : null,
    clicks: window.__clicks || [],
  };
});

const out = { panel: result.panel, clicks: result.clicks, requests: reqs, pageLogs: logs };
mkdirSync(join(__dirname, 'output'), { recursive: true });
writeFileSync(join(__dirname, 'output/userscript-env.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

await browser.close();
