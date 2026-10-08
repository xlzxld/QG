/**
 * 绕开油猴，用 Chrome 自身的调试协议注入脚本。
 *
 * 上一轮用 page.evaluate 注入时脚本能跑（面板出现、演练链路通）。
 * 但真机上油猴完全不执行任何脚本（连 5 行的自检脚本都没有反应）。
 * 说明问题 100% 在油猴/浏览器侧，与脚本体无关。
 *
 * 这里再补一个证据：用 CDP 的 Page.addScriptToEvaluateOnNewDocument
 * 在文档创建阶段注入（等价于油猴 document-idle 的最早时机），
 * 确认脚本在该页面确实能执行并建出面板。
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const TARGET = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

// 最小的自检脚本内容（与 tm-selftest.user.js 的 IIFE 部分一致）
const selfTest = `
(function () {
  var t = document.createElement('div');
  t.id = 'cdp-selftest';
  t.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;background:#0a0;color:#fff;font:14px monospace;padding:6px 10px;';
  t.textContent = 'CDP 注入自检: 已执行 @ ' + new Date().toLocaleTimeString();
  (document.body || document.documentElement).appendChild(t);
  console.log('[CDP-SELFTEST] executed');
})();
`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (/CDP-SELFTEST|华为抢购/.test(t)) logs.push(`[${m.type()}] ${t}`);
});
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));

// 在文档创建阶段注入
await page.addInitScript(selfTest);

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3000);

const r = await page.evaluate(() => ({
  selftestPresent: !!document.querySelector('#cdp-selftest'),
  selftestText: document.querySelector('#cdp-selftest')?.textContent || null,
  url: location.href,
}));

console.log('=== 文档创建阶段注入（等价油猴最早时机）===');
console.log('  自检标记出现:', r.selftestPresent ? '是 ✓' : '否 ✗');
console.log('  标记内容    :', r.selftestText);
console.log('  页面地址    :', r.url);
console.log('');
console.log('=== 控制台 ===');
console.log(logs.length ? logs.join('\n') : '(无)');
console.log('');
console.log(r.selftestPresent
  ? '⇒ 脚本本身在该页面完全可执行。油猴不执行 = 油猴/浏览器侧问题，与脚本无关。'
  : '⇒ 连 CDP 注入都没执行，需另找原因。');

await browser.close();
