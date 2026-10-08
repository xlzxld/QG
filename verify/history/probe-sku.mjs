/**
 * SKU 探针（只读）
 * =====================================================================
 * 目的：把商品页上出现的**所有** JSON 响应原样落盘，用来定位
 *      「SKU 规格列表」「延长宝/保障服务」这些字段到底在哪个接口里。
 *
 * 这个脚本不解析、不筛选、不做业务判断 —— 只如实记录。
 * 跑完之后人工看 output/sku-dump-*.json 决定要抽什么。
 *
 * 用法：node grab-probe/probe-sku.mjs [url]
 * =====================================================================
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET =
  process.argv[2] ||
  'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

/** 深搜：找出所有含指定 key 的路径 */
function findPaths(node, keys, out = [], p = '', depth = 0) {
  if (depth > 14 || node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findPaths(v, keys, out, `${p}[${i}]`, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (keys.includes(k)) out.push({ path: `${p}.${k}`, value: v });
    if (v && typeof v === 'object') findPaths(v, keys, out, `${p}.${k}`, depth + 1);
  }
  return out;
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

const captured = [];
await page.exposeFunction('__sink', (rec) => {
  captured.push(rec);
});
await page.addInitScript(() => {
  window.__qpCap = [];
  const isData = (ct) => /json|javascript|text\/plain/i.test(ct || '');
  const rec = (via, url, status, text) => {
    if (!text) return;
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      return;
    }
    window.__qpCap.push({ via, url, status, bytes: text.length, at: Date.now(), body });
  };
  const of = window.fetch;
  window.fetch = async function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : a[0]?.url || '';
    const r = await of.apply(this, a);
    try {
      const ct = r.headers.get('content-type') || '';
      if (isData(ct) && u && /vmall/.test(u)) r.clone().text().then((t) => rec('fetch', u, r.status, t)).catch(() => {});
    } catch {}
    return r;
  };
  const OO = XMLHttpRequest.prototype.open;
  const OS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) {
    this.__u = u;
    return OO.call(this, m, u, ...r);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', function () {
      try {
        const ct = this.getResponseHeader && this.getResponseHeader('content-type');
        if (!isData(ct)) return;
        const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
        rec('xhr', this.__u, this.status, t);
      } catch {}
    });
    return OS.apply(this, a);
  };
});

console.log('打开', TARGET);
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(4000);

// 像人一样往下滑，触发懒加载的规格区 / 附加服务区
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => window.scrollBy(0, 800));
  await page.waitForTimeout(900 + Math.random() * 600);
}
// 滚回顶部，触发顶部区域
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1500);

const dom = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const scope = document.querySelector('#prd-detail') || document.body;
  return {
    finalUrl: location.href,
    title: clean(document.title),
    textLen: clean(document.body?.innerText).length,
    // 规格按钮：华为详情页规格区通常在 .choose-btn-attr / [class*="attr"]
    specBlocks: Array.from(scope.querySelectorAll('[class*="attr"],[class*="choose"],[class*="spec"]'))
      .slice(0, 30)
      .map((el) => ({
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90),
        text: clean(el.innerText).slice(0, 200),
      }))
      .filter((x) => x.text),
    // 附加服务 / 延长宝相关文本块
    addonHits: (() => {
      const t = clean(document.body?.innerText);
      const kws = ['延长宝', '保障服务', '碎屏', '保���', '服务', '礼包', '权益'];
      return kws
        .map((k) => ({ k, i: t.indexOf(k), around: t.indexOf(k) >= 0 ? t.slice(Math.max(0, t.indexOf(k) - 60), t.indexOf(k) + 120) : null }))
        .filter((x) => x.i >= 0);
    })(),
  };
});

const recs = await page.evaluate(() => {
  const c = window.__qpCap || [];
  window.__qpCap = [];
  return c;
});

// 只保留 vmall 业务接口
const biz = recs.filter((r) => /vmall\.com/.test(r.url) && !/dap\.vmall|serverTime|getRegionTree|getHotCity|batchReport|cacheUrl|tipInfo|gd_bs_atk/i.test(r.url));

// 在所有响应里搜 SKU 相关关键词
const LOOK = [
  'sbomCode', 'skuCode', 'skuId', 'attrList', 'attrValue', 'specList', 'skuList',
  'sbomList', 'skuAttr', 'valueList', 'skuStock', 'extend', 'giftList', 'serviceList',
  'protect', 'insurance', 'accident', 'sbomGiftList', 'skuName', 'attrName',
];
const hits = [];
for (const r of biz) {
  const found = findPaths(r.body, LOOK);
  if (found.length) hits.push({ url: r.url.split('?')[0], query: r.url.split('?')[1] || '', count: found.length, sample: found.slice(0, 60) });
}

const out = {
  probedAt: new Date().toISOString(),
  target: TARGET,
  dom,
  endpoints: biz.map((r) => ({ url: r.url, status: r.status, bytes: r.bytes, topKeys: r.body && typeof r.body === 'object' ? Object.keys(r.body) : null })),
  skuHits: hits,
  fullResponses: biz,
};
mkdirSync(join(__dirname, 'output'), { recursive: true });
const f = join(__dirname, `output/sku-dump-${Date.now()}.json`);
writeFileSync(f, JSON.stringify(out, null, 2));

console.log('\n=== 端点清单 (' + biz.length + ') ===');
for (const e of out.endpoints) console.log(' ', e.status, String(e.bytes).padStart(7), e.url.split('?')[0].replace('https://', ''), '|', (e.topKeys || []).slice(0, 8).join(','));
console.log('\n=== SKU 关键词命中 ===');
for (const h of hits) console.log(' ', h.count, h.url.replace('https://', '').split('?')[0], '?', h.query.slice(0, 60));
console.log('\nDOM 规格块', dom.specBlocks.length, '个；附加服务命中', dom.addonHits.map((x) => x.k).join(','));
console.log('\n落盘:', f);

await browser.close();
