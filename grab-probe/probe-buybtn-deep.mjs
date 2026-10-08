/**
 * 深挖「立即购买」为什么没被 findBuyButton 命中。
 *
 * findBuyButton 的两道门槛：
 *   1) textOf(el) 长度 <= 12
 *   2) BUY 关键词命中
 * 页面全文确实有「立即购买」，但命中数为 0 —— 说明承载文字的元素
 * 文本长度超过 12（把周边文案一起包进来了）。
 * 本脚本找出所有含该文字的元素，打印文本长度与结构，定位到具体是哪个。
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
  const nodes = Array.from(document.querySelectorAll('*'));

  // 所有 innerText 含「立即购买」的元素，按文本长度升序（最"窄"的排前面）
  const carriers = nodes
    .filter((el) => clean(el.innerText || el.textContent || '').includes('立即购买'))
    .map((el) => {
      const t = clean(el.innerText || el.textContent || '');
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        文本长度: t.length,
        文本: t.length > 60 ? t.slice(0, 60) + '…' : t,
        id: el.id || '',
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
        子元素数: el.children.length,
        尺寸: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        自身无文本子节点: Array.from(el.childNodes).filter((n) => n.nodeType === 3 && clean(n.nodeValue)).length,
      };
    })
    .sort((a, b) => a.文本长度 - b.文本长度);

  // script 选择器只查 a,button,div,span —— 单独看这批
  const inScope = carriers.filter((c) => ['A', 'BUTTON', 'DIV', 'SPAN'].includes(c.tag));

  return {
    '所有含该词元素数': carriers.length,
    'script选择器范围内': inScope.length,
    '最短的8个（含标签/长度/是否超12）': carriers.slice(0, 8).map((c) => ({
      tag: c.tag, 文本长度: c.文本长度, 子元素数: c.子元素数, 尺寸: c.尺寸,
      判定: c.文本长度 > 12 ? `被 t.length>12 挡掉 ✗` : '长度合格 ✓',
      文本: c.文本,
    })),
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
