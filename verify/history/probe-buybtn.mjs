/**
 * 定位「立即购买」按钮为什么没被脚本认成可点。
 * 复刻脚本的 findBuyButton / isActionable 逻辑，逐条打印淘汰原因。
 */
import { chromium } from 'playwright';

const TARGET = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(5000);

const r = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => clean(el && (el.innerText || el.textContent || ''));
  const BUY = ['立即购买', '立即申购', '加入购物车', '立即预订', '马上抢', '立即抢购'];

  // 脚本原版 findBuyButton
  const nodes = document.querySelectorAll('a,button,div,span');
  const hits = [];
  for (const el of nodes) {
    const t = textOf(el);
    if (!t || t.length > 12) continue;
    if (!BUY.some((k) => t.includes(k))) continue;
    hits.push(el);
  }

  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const reasons = [];
    if (rect.width <= 0 || rect.height <= 0) reasons.push(`尺寸为0 (${Math.round(rect.width)}x${Math.round(rect.height)})`);
    if (st.visibility === 'hidden') reasons.push('visibility:hidden');
    if (st.display === 'none') reasons.push('display:none');
    if (st.opacity === '0') reasons.push('opacity:0');
    if (el.hasAttribute('disabled')) reasons.push('有 disabled 属性');
    if (typeof el.className === 'string' && /disabled|is-disabled|btn-disabled/.test(el.className)) reasons.push(`class 含 disabled: ${el.className.slice(0, 60)}`);
    if (el.getAttribute('aria-disabled') === 'true') reasons.push('aria-disabled=true');
    return {
      tag: el.tagName,
      text: textOf(el),
      id: el.id || '',
      cls: typeof el.className === 'string' ? el.className.slice(0, 70) : '',
      rect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) },
      display: st.display,
      visibility: st.visibility,
      opacity: st.opacity,
      offsetParent: el.offsetParent ? el.offsetParent.tagName : null,
      verdict: reasons.length ? `不可点：${reasons.join(' / ')}` : '可点 ✓',
    };
  };

  // 页面全文里到底有没有这些词
  const txt = clean(document.body.innerText);
  const wordHits = BUY.filter((k) => txt.includes(k));

  return {
    全文命中的购买词: wordHits,
    'findBuyButton 命中数': hits.length,
    命中元素详情: hits.map(describe),
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
