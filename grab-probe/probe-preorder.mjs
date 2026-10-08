/**
 * 核实两件事：
 *  1) 预售页到底被 readStockState 判成什么状态（上一轮我凭推测说有 bug，需验证）
 *  2) 页面上「立即购买」究竟在不在（上一轮已确认不在）
 * 顺带把 readStockState 的两条正则原样跑一遍，看哪条命中。
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
await page.waitForTimeout(6000);

const r = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const t = clean(document.body.innerText);

  const OUT_RE = /已售罄|售罄|暂时缺货|无货|到货通知|补货中/;
  const PRE_RE = /即将开始|即将开售|未开售|倒计时|敬请期待/;
  const BUY = ['立即购买', '立即申购', '加入购物车', '立即预订', '马上抢', '立即抢购'];

  const nodes = document.querySelectorAll('a,button,div,span');
  const hits = [];
  for (const el of nodes) {
    const x = clean(el.innerText || el.textContent || '');
    if (!x || x.length > 12) continue;
    if (!BUY.some((k) => x.includes(k))) continue;
    hits.push({ tag: el.tagName, 文本: x });
  }

  return {
    'OUT_OF_STOCK正则命中': OUT_RE.test(t),
    'OUT_OF_STOCK命中词': (t.match(OUT_RE) || [])[0] || null,
    'PREORDER正则命中': PRE_RE.test(t),
    'PREORDER命中词': (t.match(PRE_RE) || [])[0] || null,
    '页面上是否含「敬请期待」': t.includes('敬请期待'),
    '页面上是否含「无货」': t.includes('无货'),
    'findBuyButton命中数': hits.length,
    购买按钮候选: hits,
    readStockState实际返回: OUT_RE.test(t) ? 'OUT_OF_STOCK' : (PRE_RE.test(t) ? 'PREORDER' : (hits.length ? 'IN_STOCK' : 'UNKNOWN')),
    'giveUpAfterMs': 1800000,
    'giveUp换算分钟': 1800000 / 60000,
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
