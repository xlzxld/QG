/**
 * 打印「立即购买」按钮区域的原始 DOM。
 *
 * 已确认：没有任何元素 innerText 严格等于「立即购买」，findBuyButton 命中数为 0。
 * 说明按钮文案被拆进了子节点（如 <span>「立即」</span><span>「购买」</span>），
 * 或按钮当前处于不可购状态（灰态/需选择规格）。
 * 本脚本直接吐出按钮区 HTML，看真实结构。
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

  // 找到离「立即购买」文字最近的、在 #prd-detail 内的小容器
  const detail = document.querySelector('#prd-detail');
  const walkers = [];
  if (detail) {
    const w = document.createTreeWalker(detail, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = w.nextNode())) {
      const t = clean(n.innerText || '');
      if (/立即购买|立即申购|加入购物车|马上抢|立即抢购/.test(t) && t.length <= 30) {
        const rect = n.getBoundingClientRect();
        walkers.push({
          tag: n.tagName,
          id: n.id || '',
          cls: (typeof n.className === 'string' ? n.className : '').slice(0, 80),
          文本: t,
          文本长度: t.length,
          尺寸: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          display: getComputedStyle(n).display,
          cursor: getComputedStyle(n).cursor,
          HTML: n.outerHTML.slice(0, 500),
        });
      }
    }
  }

  // 也看看 #prd-detail 里 class 含 btn/buy 的
  const btns = detail
    ? Array.from(detail.querySelectorAll('[class*="btn"],[class*="buy"],[class*="Btn"]'))
        .slice(0, 12)
        .map((el) => {
          const t = clean(el.innerText || '');
          const rect = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
            文本: t.slice(0, 30),
            尺寸: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
            display: getComputedStyle(el).display,
            HTML: el.outerHTML.slice(0, 300),
          };
        })
    : [];

  return { prdDetail内短文本购买词: walkers, prdDetail内btn类元素: btns };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
