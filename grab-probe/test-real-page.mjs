/**
 * 在真实华为商品页上跑 huawei.user.js，抓真机上的实际报错与卡点。
 * 只读页面、不提交订单；配置 enabled=false 也不会点到购买。
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
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

const logs = [];
const reqs = [];
page.on('console', (m) => {
  const t = m.text();
  if (/WebGL|first input delay|GPU stall|\[table\]|\[clear\]|Array\(\d+\)/i.test(t)) return;
  if (/vmallres\.com|chunk-|openapi\.vmall/i.test(t) && !/华为抢购/.test(t)) return;
  logs.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.exposeFunction('__gmFetch', async ({ method, url, headers, data }) => {
  reqs.push(`${method} ${url}`);
  try {
    const r = await fetch(url, { method, headers, body: data });
    return { ok: true, status: r.status, responseText: await r.text() };
  } catch (e) { return { ok: false, error: e.message }; }
});

await page.addInitScript(() => {
  const store = {};
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = (o) => {
    window.__gmFetch({ method: o.method || 'GET', url: o.url, headers: o.headers, data: o.data })
      .then((r) => { if (r.ok) o.onload && o.onload({ status: r.status, responseText: r.responseText }); else o.onerror && o.onerror(new Error(r.error)); });
  };
});

let navOk = true;
try {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
} catch (e) {
  navOk = false;
  logs.push(`[NAV_FAIL] ${e.message}`);
}

// 注入脚本（等价油猴 document-idle）
try {
  await page.evaluate(`(async () => { ${body} })()`);
} catch (e) { logs.push(`[EVAL_THROW] ${e.message}`); }

await page.waitForTimeout(6000);

const probe = await page.evaluate(() => {
  const p = document.querySelector('#qp-huawei-grab-panel');
  const txt = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
  const scope = document.querySelector('#prd-detail');
  return {
    pageTitle: document.title,
    finalUrl: location.href,
    panel: p ? { phase: p.querySelector('#qp-phase')?.textContent, logs: [...p.querySelectorAll('#qp-log div')].map((d) => d.textContent) } : null,
    domFacts: {
      hasPrdDetail: !!scope,
      hasRecommendItem: !!document.querySelector('#recommendItem'),
      hasBuyButton: /立即购买|立即申购|加入购物车|马上抢|立即抢购/.test(txt),
      textLen: txt.length,
      mentionsCaptcha: /安全验证|滑动验证|人机验证|请完成验证|拖动滑块|验证码/.test(txt),
      mentionsLogin: /请登录|立即登录|账号登录|登录后查看/.test(txt),
      mentionsLoggedIn: /我的商城|退出|欢迎|个人中心/.test(txt),
      mentionsOutOfStock: /已售罄|售罄|暂时缺货|无货|到货通知|补货中/.test(txt),
      // 挑战检测的第二个条件：短文本页 + slider 元素
      shortPage: txt.length < 600,
      hasSliderEl: !!document.querySelector('[class*="slider"],[class*="captcha"],[id*="captcha"],[class*="verify"]'),
    },
    // 主价格探测（复刻脚本的 readPrice 选法）
    priceProbe: (() => {
      const collect = (root) => Array.from(root.querySelectorAll('*')).filter((el) => {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 24) return false;
        if (el.children.length > 2) return false;
        if (!/^[¥￥]?\s*[\d,]{4,}(?:\.\d{1,2})?$/.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).map((el) => ({
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        v: parseFloat((el.innerText || el.textContent || '').replace(/[¥￥,\s]/g, '')),
        fs: parseFloat(getComputedStyle(el).fontSize) || 0,
        inDetail: !!el.closest('#prd-detail'),
        inRec: !!el.closest('#recommendItem'),
      })).filter((x) => Number.isFinite(x.v) && x.v >= 50);
      const inDetail = collect(scope || document.createElement('div'));
      return { pickedFromDetail: inDetail.length, sample: inDetail.slice(0, 6) };
    })(),
  };
});

const out = { navOk, target: TARGET, ...probe, requests: reqs, pageLogs: logs };
mkdirSync(join(__dirname, 'output'), { recursive: true });
writeFileSync(join(__dirname, 'output/real-page.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

await browser.close();
