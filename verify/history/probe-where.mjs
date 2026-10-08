/**
 * 定位「立即购买」在页面上的真实位置。
 *
 * 已确认：
 *   - #prd-detail 内没有任何购买按钮
 *   - 全页没有任何元素 innerText 严格等于「立即购买」
 *   - 全页含「立即购买」的元素里，最短的是 87 字的购买区评论
 * 说明这个商品当前很可能处于「不可购买」状态（未开售/需选规格/下架），
 * 页面上根本没有真正的购买按钮，那句「立即购买」只存在于买家评价里。
 *
 * 本脚本把「立即购买」每个出现位置的上下文打出来，并判断购买区在哪。
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

  // 逐个文本节点找「立即购买」，看它落在哪个容器里
  const hits = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const v = n.nodeValue || '';
    if (!v.includes('立即购买')) continue;
    let el = n.parentElement;
    const chain = [];
    let cur = el;
    for (let i = 0; i < 5 && cur; i++) {
      const t = clean(cur.innerText || '');
      chain.push(`${cur.tagName} len=${t.length} "${t.slice(0, 24)}"`);
      cur = cur.parentElement;
    }
    hits.push({ 原始文本: v.trim().slice(0, 40), 祖先链: chain });
  }

  // 页面上与购买/库存相关的所有短文本（判断当前售卖状态）
  const kw = /立即购买|立即申购|加入购物车|马上抢|立即抢购|已售罄|售罄|暂时缺货|无货|到货通知|补货中|即将开始|即将开售|未开售|倒计时|敬请期待|选择.*配置|请选择/;
  const stateEls = Array.from(document.querySelectorAll('a,button,span,div,li'))
    .map((el) => ({ el, t: clean(el.innerText || '') }))
    .filter((x) => x.t && x.t.length <= 24 && kw.test(x.t))
    .slice(0, 20)
    .map((x) => {
      const rect = x.el.getBoundingClientRect();
      return {
        文本: x.t,
        tag: x.el.tagName,
        可见: rect.width > 0 && rect.height > 0,
        尺寸: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        在prdDetail内: !!x.el.closest('#prd-detail'),
        id: x.el.id || '',
        cls: (typeof x.el.className === 'string' ? x.el.className : '').slice(0, 50),
      };
    });

  return {
    '「立即购买」出现次数': hits.length,
    每次出现的上下文: hits.slice(0, 6),
    '购买/库存相关短文本': stateEls,
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
