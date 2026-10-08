/**
 * 第二轮侦察：锁定主价格容器的可定位特征
 *
 * 已知（第一轮）：
 *   主商品价 10999 → 字号 30px，祖先含 div#AGGIZ1HMYA9HCFGU（y≈228，首屏）
 *   推荐位价格     → 字号 20px，祖先含 div#recommendItem
 *
 * 本轮要问清楚：
 *   1. 主价格容器有什么稳定的 id / class 特征？
 *   2. 它和标题、规格按钮在 DOM 上的相对位置关系？
 *   3. 字号阈值能不能作为可靠的筛选条件（30px vs 20px）？
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

const out = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /** 判断元素是否位于推荐位内 */
  function inRecommend(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const id = cur.id || '';
      const cls = typeof cur.className === 'string' ? cur.className : '';
      if (/recommend|Recommend/.test(id) || /recommend/i.test(cls)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // 收集所有"数字类"叶子元素，带字号与归属
  const items = [];
  for (const el of document.querySelectorAll('*')) {
    const t = clean(el.innerText || el.textContent);
    if (!t) continue;
    if (el.children.length > 2) continue;
    const m = t.match(/^[¥￥]?\s*([\d,]{3,}(?:\.\d{1,2})?)$/);
    if (!m) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const st = getComputedStyle(el);
    const fs = parseFloat(st.fontSize);
    if (!Number.isFinite(fs) || fs < 16) continue;
    items.push({
      el,
      text: t,
      value: parseFloat(m[1].replace(/,/g, '')),
      fs,
      top: Math.round(r.top + window.scrollY),
      left: Math.round(r.left),
      inRecommend: inRecommend(el),
    });
  }

  // 主价格候选：不在推荐位、字号最大、位置最靠前
  const mainPool = items.filter((i) => !i.inRecommend && i.value >= 100);
  mainPool.sort((a, b) => b.fs - a.fs || a.top - b.top);
  const main = mainPool[0] || null;

  // 主价格元素所在的、带 id 的最近祖先
  let anchorChain = [];
  if (main) {
    let cur = main.el;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      if (cur.id) anchorChain.push({ level: i, tag: cur.tagName.toLowerCase(), id: cur.id, cls: String(cur.className || '').split(/\s+/).slice(0, 3).join('.') });
      cur = cur.parentElement;
    }
  }

  // 规格按钮的容器特征
  const specEl = Array.from(document.querySelectorAll('*')).find((el) => {
    const t = clean(el.innerText || el.textContent);
    return t === '16GB+512GB 典藏版' && el.children.length <= 1;
  });
  let specChain = [];
  if (specEl) {
    let cur = specEl;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      if (cur.id || (typeof cur.className === 'string' && /spec|sku|version|item/i.test(cur.className)))
        specChain.push({ level: i, tag: cur.tagName.toLowerCase(), id: cur.id, cls: String(cur.className || '').split(/\s+/).slice(0, 3).join('.') });
      cur = cur.parentElement;
    }
  }

  // 标题元素
  const h1 = document.querySelector('h1');

  // 统计：各字号档位的候选数量
  const byFont = {};
  for (const i of items) {
    const k = `${i.fs}px${i.inRecommend ? '(推荐位)' : ''}`;
    byFont[k] = (byFont[k] || 0) + 1;
  }

  return {
    主价格: main
      ? { text: main.text, value: main.value, fontSize: main.fs, top: main.top, left: main.left }
      : null,
    主价格祖先链: anchorChain,
    规格元素祖先链: specChain,
    标题: h1 ? { text: clean(h1.innerText), top: Math.round(h1.getBoundingClientRect().top + window.scrollY) } : null,
    字号分布: byFont,
    非推荐位候选: mainPool.slice(0, 8).map((i) => ({ text: i.text, value: i.value, fs: i.fs, top: i.top })),
    推荐位候选数: items.filter((i) => i.inRecommend).length,
  };
});

console.log('='.repeat(76));
console.log('第二轮侦察结果');
console.log('='.repeat(76));
console.log('主价格:', JSON.stringify(out.主价格, null, 2));
console.log('');
console.log('主价格的带 id 祖先（从近到远）:');
for (const a of out.主价格祖先链) console.log(`  L${a.level}  <${a.tag}> id="${a.id}" class="${a.cls}"`);
console.log('');
console.log('规格元素的祖先特征:');
for (const a of out.规格元素祖先链) console.log(`  L${a.level}  <${a.tag}> id="${a.id}" class="${a.cls}"`);
console.log('');
console.log('页面标题:', JSON.stringify(out.标题));
console.log('');
console.log('字号分布:', JSON.stringify(out.字号分布, null, 2));
console.log('');
console.log('非推荐位候选（前 8）:');
for (const c of out.非推荐位候选) console.log(`  「${c.text}」 字号=${c.fs}px  y=${c.top}`);
console.log(`推荐位内候选数: ${out.推荐位候选数}`);

await ctx.close();
await browser.close();
