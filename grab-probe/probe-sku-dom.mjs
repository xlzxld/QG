/**
 * 页面内嵌数据探针（只读）
 * =====================================================================
 * 目的：确认「SKU 规格名（颜色 / 版本）」和「延长宝 / 保障服务」到底从哪来。
 *      接口响应里只有 sbomCode，没有规格文字，所以必须看页面内嵌数据。
 *
 * 用法：node grab-probe/probe-sku-dom.mjs [url]
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

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(4500);

const r = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = { finalUrl: location.href, title: document.title };

  // 1. 扫描 window 上的全局变量，找含 sbomCode 的
  const globals = [];
  for (const k of Object.getOwnPropertyNames(window)) {
    let v;
    try {
      v = window[k];
    } catch {
      continue;
    }
    if (v === null || typeof v !== 'object') continue;
    if (k === 'window' || k === 'document') continue;
    let s = '';
    try {
      s = JSON.stringify(v);
    } catch {
      continue;
    }
    if (!s || s.length > 8_000_000) continue;
    if (/\d{15,}|sbomCode|skuCode|attrList|extendService|保障服务|延长宝/.test(s)) {
      globals.push({ key: k, bytes: s.length, hasSbom: /sbomCode|"26\d{12}"/.test(s) });
    }
  }
  out.windowGlobals = globals.slice(0, 40);

  // 2. 找内嵌 <script> 里的 JSON 数据
  const scripts = [];
  for (const s of document.querySelectorAll('script')) {
    const t = s.textContent || '';
    if (t.length < 200) continue;
    if (!/sbomCode|attrList|skuCode|延长宝|保障服务|10086384648661/.test(t)) continue;
    scripts.push({ id: s.id || null, type: s.type || null, bytes: t.length, head: t.slice(0, 300) });
  }
  out.inlineScripts = scripts;

  // 3. 规格按钮：华为详情页规格区
  const specSelectors = [
    '.choose-btn-attr', '.choose-attr', '[class*="attr"]', '[class*="sku-item"]',
    '[class*="spec-item"]', '[class*="value-item"]', '.c-attr-item', '[class*="attrItem"]',
  ];
  const specNodes = [];
  for (const sel of specSelectors) {
    for (const el of document.querySelectorAll(sel)) {
      const t = clean(el.innerText);
      if (!t || t.length > 120) continue;
      const cls = typeof el.className === 'string' ? el.className : '';
      specNodes.push({
        sel,
        cls: cls.slice(0, 80),
        text: t.slice(0, 60),
        attrs: Object.fromEntries(
          Array.from(el.attributes || []).map((a) => [a.name, String(a.value).slice(0, 80)]),
        ),
      });
    }
  }
  out.specNodes = specNodes.slice(0, 120);

  // 4. 找承载 "延长宝" / "保障服务" 的 DOM 块
  const addon = [];
  for (const kw of ['延长宝', '保障服务', '碎屏', '意外', '服务包']) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.includes(kw)) continue;
      let el = node.parentElement;
      for (let up = 0; up < 4 && el; up++, el = el.parentElement) {
        const t = clean(el.innerText);
        if (t && t.length <= 300) {
          addon.push({ kw, tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 90), text: t.slice(0, 260) });
          break;
        }
      }
    }
  }
  out.addonBlocks = addon.slice(0, 40);

  // 5. 页面所有 <a href> 里的 sbomCode 链接（规格切换链接）
  out.sbomLinks = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => a.href)
    .filter((h) => /sbomCode=\d{10,}/.test(h))
    .slice(0, 60);

  return out;
});

mkdirSync(join(__dirname, 'output'), { recursive: true });
const f = join(__dirname, `output/sku-dom-${Date.now()}.json`);
writeFileSync(f, JSON.stringify(r, null, 2));

console.log('=== window 全局（含商品数据）===');
for (const g of r.windowGlobals) console.log('  ', g.key, g.bytes, 'bytes', g.hasSbom ? '含SKU码' : '');
console.log('\n=== 内嵌 script ===');
for (const s of r.inlineScripts) console.log('  ', s.id || '(no id)', s.type, s.bytes);
console.log('\n=== 规格节点', r.specNodes.length, '个 ===');
for (const s of r.specNodes.slice(0, 40)) console.log('  ', s.sel, '|', s.text, '|', JSON.stringify(s.attrs).slice(0, 160));
console.log('\n=== 延长宝/保障服务块', r.addonBlocks.length, '个 ===');
for (const a of r.addonBlocks.slice(0, 12)) console.log('  [' + a.kw + ']', a.tag, a.cls, '→', a.text.slice(0, 160));
console.log('\n=== 带 sbomCode 的链接', r.sbomLinks.length, '条 ===');
r.sbomLinks.slice(0, 10).forEach((h) => console.log('  ', h.slice(0, 130)));
console.log('\n落盘:', f);

await browser.close();
