/**
 * 价格元素 DOM 侦察
 *
 * 目的：找出主商品价在页面上到底挂在哪个容器里，
 * 以便用「容器特征 + 与标题/规格的邻近关系」定位，而不是扫全页文字靠量级猜。
 *
 * 只读页面结构，不点击。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'grab', 'huawei.config.json'), 'utf8'));

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();
await page.goto(cfg.target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => window.scrollTo(0, 800));
await page.waitForTimeout(1000);

const recon = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /** 提取一个元素的可读定位信息 */
  function describe(el) {
    const chain = [];
    let cur = el;
    for (let i = 0; i < 5 && cur && cur !== document.body; i++) {
      chain.push(`${cur.tagName.toLowerCase()}${cur.id ? '#' + cur.id : ''}${cur.className && typeof cur.className === 'string' ? '.' + cur.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : ''}`);
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return {
      text: clean(el.innerText || el.textContent).slice(0, 60),
      chain: chain.join('  ←  '),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      fontSize: st.fontSize,
      color: st.color,
      fontWeight: st.fontWeight,
      childCount: el.children.length,
      childTags: Array.from(el.children).slice(0, 6).map((c) => c.tagName.toLowerCase() + (c.className && typeof c.className === 'string' ? '.' + c.className.split(/\s+/)[0] : '')),
    };
  }

  /** 找所有"看起来是价格"的叶子元素 */
  const priceEls = [];
  for (const el of document.querySelectorAll('*')) {
    const t = clean(el.innerText || el.textContent);
    if (!t || t.length > 30) continue;
    // 只认叶子级：自身文本短，且要么带货币符号，要么纯数字
    if (!/[¥￥]/.test(t) && !/^\d[\d,]*(\.\d{1,2})?$/.test(t)) continue;
    if (el.children.length > 2) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const st = getComputedStyle(el);
    // 价格类元素通常字号偏大
    const fs = parseFloat(st.fontSize);
    if (!Number.isFinite(fs) || fs < 14) continue;
    priceEls.push({ el, t, fs, top: r.top });
    if (priceEls.length > 400) break;
  }

  // 去重 + 按字号排序
  const seen = new Set();
  const uniq = [];
  for (const p of priceEls) {
    if (seen.has(p.el)) continue;
    seen.add(p.el);
    uniq.push(p);
  }
  uniq.sort((a, b) => b.fs - a.fs || a.top - b.top);

  const detailed = uniq.slice(0, 14).map((p) => ({
    ...describe(p.el),
    fontSizePx: p.fs,
  }));

  // 页面纵向结构：把文本块按 top 排序，看价格周围是什么
  const blocks = [];
  for (const el of document.querySelectorAll('h1, h2, [class*="title"], [class*="name"], [class*="price"], [class*="Price"]')) {
    const t = clean(el.innerText || el.textContent);
    if (!t || t.length > 60) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    blocks.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || '').split(/\s+/).slice(0, 4).join('.'),
      text: t,
      top: Math.round(r.top),
      left: Math.round(r.left),
    });
  }
  blocks.sort((a, b) => a.top - b.top);

  // 页面是否有 JSON-LD 或 meta 里的价格（属于公开结构化信息）
  const metas = {};
  for (const m of document.querySelectorAll('meta[property],meta[name]')) {
    const k = m.getAttribute('property') || m.getAttribute('name');
    if (/price|product|og:/i.test(k || '')) metas[k] = clean(m.getAttribute('content')).slice(0, 120);
  }
  const ld = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const o = JSON.parse(s.textContent || 'null');
      if (o) ld.push(JSON.stringify(o).slice(0, 300));
    } catch {}
  }

  return { priceElements: detailed, blocks: blocks.slice(0, 40), metas, ldCount: ld.length, ldSample: ld.slice(0, 2) };
});

console.log('='.repeat(78));
console.log('价格元素侦察（按字号从大到小）');
console.log('='.repeat(78));
for (const p of recon.priceElements) {
  console.log(`「${p.text}」  字号=${p.fontSizePx}px  颜色=${p.color}  权重=${p.fontWeight}`);
  console.log(`   位置: x=${p.rect.x} y=${p.rect.y} ${p.rect.w}×${p.rect.h}   子元素: ${p.childTags.join(', ') || '(无)'}`);
  console.log(`   祖先链: ${p.chain}`);
  console.log('');
}

console.log('='.repeat(78));
console.log('页面纵向文本块（title / name / price 类容器）');
console.log('='.repeat(78));
for (const b of recon.blocks) {
  console.log(`  y=${String(b.top).padStart(5)}  x=${String(b.left).padStart(5)}  ${b.tag}.${b.cls}  「${b.text}」`);
}

console.log('');
console.log('='.repeat(78));
console.log('公开结构化信息（meta / JSON-LD）');
console.log('='.repeat(78));
console.log('meta:', JSON.stringify(recon.metas, null, 2));
console.log(`JSON-LD 块数: ${recon.ldCount}`);
for (const s of recon.ldSample) console.log('  样例:', s);

await ctx.close();
await browser.close();
