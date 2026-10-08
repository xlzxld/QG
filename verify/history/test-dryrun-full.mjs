/**
 * 演练链路全流程验证。
 *
 * 上一轮实测卡在「等待登录」——因为测试浏览器没有华为登录态。
 * 真实使用场景里，用户本来就已经在浏览器里登录好了，所以登录检测本身没问题。
 * 但这挡住了后面几步（选规格 → 价格校验 → 点购买 → 演练收尾）的验证。
 *
 * 这里不改脚本，而是在页面里临时把登录态文字改掉，让流程继续往下走，
 * 专���检验「enabled 打开之后，剩下的步骤是不是真的通」。
 *
 * 安全阀：
 *   - dryRun=true，脚本只点「立即购买」不提交订单；
 *   - 拦截所有导航，点完购买就地冻结，不跳结算页；
 *   - 价格上限 12000，页面价 10999，不会误判超限。
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const body = readFileSync(join(ROOT, 'grab/huawei.user.js'), 'utf8')
  .replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

const TARGET = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

const logs = [];
const reqs = [];
page.on('console', (m) => {
  const t = m.text();
  if (/WebGL|first input delay|GPU stall|\[table\]|\[clear\]|Array\(\d+\)/i.test(t)) return;
  if (/vmallres\.com|chunk-|openapi\.vmall/i.test(t) && !/华为抢购/.test(t)) return;
  logs.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.exposeFunction('__gmFetch', async ({ method, url, headers, data }) => {
  reqs.push(`${method} ${url}`);
  try {
    const r = await fetch(url, { method, headers, body: data });
    return { ok: true, status: r.status, responseText: await r.text() };
  } catch (e) { return { ok: false, error: e.message }; }
});

await page.addInitScript(() => {
  const store = {};
  window.GM_getValue = (k, d) => (k in store ? store[k] : d);
  window.GM_setValue = (k, v) => { store[k] = v; };
  window.GM_registerMenuCommand = () => {};
  window.GM_xmlhttpRequest = (o) => {
    window.__gmFetch({ method: o.method || 'GET', url: o.url, headers: o.headers, data: o.data })
      .then((r) => { if (r.ok) o.onload && o.onload({ status: r.status, responseText: r.responseText }); else o.onerror && o.onerror(new Error(r.error)); });
  };
});

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(4500);

// ── 记录点击，并阻断离开本页（演练不应跳到结算页）──
await page.evaluate(() => {
  window.__clicks = [];
  document.addEventListener('click', (e) => {
    const el = e.target.closest('a,button,div,span');
    if (el) window.__clicks.push((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30));
  }, true);
  // 点购买会触发 <a href> 跳转，这里冻结导航，保留页面现状供检查
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && /立即购买|立即申购|加入购物车/.test(a.innerText || '')) e.preventDefault();
  }, true);
});

// ── 模拟已登录：把登录按钮文案换成已登录特征词 ──
// 只为让脚本走完流程，不改动页面结构与商品信息
await page.evaluate(() => {
  const kill = /请登录|立即登录|账号登录|登录后查看/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (kill.test(walker.currentNode.nodeValue || '')) nodes.push(walker.currentNode);
  nodes.forEach((n) => { n.nodeValue = (n.nodeValue || '').replace(kill, '我的商城'); });
  // 补一个已登录标志
  const d = document.createElement('div');
  d.style.display = 'none';
  d.textContent = '我的商城 退出';
  document.body.appendChild(d);
});

try {
  await page.evaluate(`(async () => { ${body} })()`);
} catch (e) { logs.push(`[EVAL_THROW] ${e.message}`); }

// 主循环轮询 3s + 点击后 2.5s 收尾，给足时间
await page.waitForTimeout(12000);

const probe = await page.evaluate(() => {
  const p = document.querySelector('#qp-huawei-grab-panel');
  return {
    phase: p ? p.querySelector('#qp-phase')?.textContent : null,
    panelLogs: p ? [...p.querySelectorAll('#qp-log div')].map((d) => d.textContent) : [],
    clicks: window.__clicks || [],
    url: location.href,
  };
});

const out = { ...probe, requests: reqs, pageLogs: logs };
mkdirSync(join(__dirname, 'output'), { recursive: true });
writeFileSync(join(__dirname, 'output/dryrun-full.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

await browser.close();
