/**
 * 一次性核查：初始 HTML（禁用 JS）里到底有没有库存信号
 * 目的：判断华为商城把库存状态放在服务端 HTML 里，还是靠客户端脚本注入。
 *
 * 方法：同一 URL 各取两份"用户可见文本"——
 *   A. 禁用 JS  → 等价于一个普通 HTTP 客户端能拿到的东西
 *   B. 启用 JS  → 浏览器渲染后用户看到的东西
 * 只读 body.innerText，不拦截、不解析任何响应体。
 *
 * 用法: node check-render-diff.mjs
 */
import { chromium } from 'playwright';

const URLS = [
  ['Mate80', 'https://www.vmall.com/product/10086133363559.html'],
  ['麦芒9(旧)', 'https://www.vmall.com/product/10086741488253.html'],
];

const SIGNALS = [
  ['加入购物车', 'in_stock'],
  ['立即购买', 'in_stock'],
  ['售罄', 'out_of_stock'],
  ['已下架', 'out_of_stock'],
  ['暂时缺货', 'out_of_stock'],
  ['到货通知', 'out_of_stock'],
  ['订金', 'preorder'],
  ['接受预购', 'preorder'],
  ['即将开售', 'preorder'],
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const browser = await chromium.launch({ channel: 'chromium', headless: true });

async function visibleText(url, jsEnabled) {
  const ctx = await browser.newContext({
    javaScriptEnabled: jsEnabled,
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();
  const out = { text: '', url: null, status: null, htmlBytes: 0, error: null };
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
      out.error = e.message.split('\n')[0];
      return null;
    });
    out.status = resp ? resp.status() : null;
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    out.url = page.url();
    const r = await page.evaluate(() => ({
      text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim(),
      bytes: (document.documentElement.outerHTML || '').length,
    }));
    out.text = r.text;
    out.htmlBytes = r.bytes;
  } catch (e) {
    out.error = out.error || e.message.split('\n')[0];
  } finally {
    await ctx.close().catch(() => {});
  }
  return out;
}

function findSignals(text) {
  return SIGNALS.filter(([w]) => text.includes(w)).map(([w, k]) => `${w}(${k})`);
}

for (const [name, url] of URLS) {
  console.log(`\n${'='.repeat(72)}\n${name}\n${url}\n${'='.repeat(72)}`);

  const noJs = await visibleText(url, false);
  const withJs = await visibleText(url, true);

  console.log(`[A] 禁用 JS（≈纯 HTTP 客户端）`);
  console.log(`    HTTP ${noJs.status}  可见文本 ${noJs.text.length} 字  DOM ${noJs.htmlBytes} 字符`);
  console.log(`    库存信号: ${findSignals(noJs.text).join(', ') || '✗ 无'}`);
  if (noJs.error) console.log(`    err: ${noJs.error}`);

  console.log(`[B] 启用 JS（浏览器渲染）`);
  console.log(`    HTTP ${withJs.status}  可见文本 ${withJs.text.length} 字  DOM ${withJs.htmlBytes} 字符`);
  console.log(`    库存信号: ${findSignals(withJs.text).join(', ') || '✗ 无'}`);
  console.log(`    落地: ${withJs.url}`);
  if (withJs.error) console.log(`    err: ${withJs.error}`);

  const a = findSignals(noJs.text).length;
  const b = findSignals(withJs.text).length;
  console.log(
    `\n    结论: ${b === 0 ? '渲染后也读不到 → 该页不可监控' : a > 0 ? '纯 HTTP 即可判定 → 可省掉浏览器资源' : '必须渲染才能判定 → 需要共享浏览器会话'}`,
  );
}

await browser.close();
