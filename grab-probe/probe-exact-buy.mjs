/**
 * 精确定位真正的「立即购买」按钮。
 *
 * 上一步发现：页面里含「立即购买」的元素，最短的居然是用户评价里的评论（87字），
 * 真正的购买按钮反而没进 a/button/div/span 的 short-text 命中。
 * 推测按钮文案被拆进了 <span>/<em> 等子节点，或用了非文本节点。
 *
 * 这里直接搜所有标签（不限 a/button/div/span），只要自身文本 == 「立即购买」就报出来。
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
await page.waitForTimeout(5500);

const r = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // 1) 自身文本严格等于「立即购买」的所有元素（不限标签）
  const exact = Array.from(document.querySelectorAll('*'))
    .filter((el) => clean(el.innerText || el.textContent || '') === '立即购买')
    .map((el) => {
      const rect = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      // 往上爬 4 层，看祖先链，判断哪个才是可点的容器
      const chain = [];
      let cur = el;
      for (let i = 0; i < 4 && cur; i++) {
        const cr = cur.getBoundingClientRect();
        const cs = getComputedStyle(cur);
        chain.push({
          tag: cur.tagName,
          id: cur.id || '',
          cls: (typeof cur.className === 'string' ? cur.className : '').slice(0, 50),
          尺寸: `${Math.round(cr.width)}x${Math.round(cr.height)}`,
          display: cs.display,
          cursor: cs.cursor,
          '在prd-detail内': !!cur.closest('#prd-detail'),
        });
        cur = cur.parentElement;
      }
      return {
        tag: el.tagName,
        尺寸: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        display: st.display,
        cursor: st.cursor,
        祖先链: chain,
      };
    });

  // 2) 页面上真正"看起来是按钮"的大块可点击区域（含购买/加入购物车字样的短元素）
  const btnLike = Array.from(document.querySelectorAll('a,button,[role="button"],div[class*="btn"],[class*="buy"],[class*="purchase"]'))
    .map((el) => {
      const t = clean(el.innerText || el.textContent || '');
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        文本: t.length > 30 ? t.slice(0, 30) + '…' : t,
        文本长度: t.length,
        尺寸: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        可见: rect.width > 0 && rect.height > 0,
        cursor: getComputedStyle(el).cursor,
        '在prd-detail内': !!el.closest('#prd-detail'),
      };
    })
    .filter((x) => x.可见 && x.文本长度 > 0 && x.文本长度 <= 20)
    .slice(0, 15);

  return {
    '自身文本严格等于「立即购买」的元素数': exact.length,
    精确命中详情: exact,
    '页面上像按钮的元素（前15）': btnLike,
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
