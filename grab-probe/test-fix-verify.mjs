/**
 * 单独验证修复后的 huawei.user.js（不带任何其他注入）。
 *
 * 在 document-start 时机注入，此时 document.body 仍为 null ——
 * 正是上一轮报 "Cannot read properties of null (reading 'appendChild')" 的条件。
 * 期望：面板能建出来、脚本自身零错误。
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const body = readFileSync(ROOT + '/grab/huawei.user.js', 'utf8')
  .replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

const TARGET = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.exposeFunction('__gmFetch', async ({ method, url, headers, data }) => {
  try {
    const r = await fetch(url, { method, headers, body: data });
    return { ok: true, status: r.status, responseText: await r.text() };
  } catch (e) { return { ok: false, error: e.message }; }
});

await page.addInitScript(`const s={};
window.GM_getValue=(k,d)=>(k in s?s[k]:d);
window.GM_setValue=(k,v)=>{s[k]=v};
window.GM_registerMenuCommand=()=>{};
window.GM_xmlhttpRequest=o=>{
  window.__gmFetch({method:o.method||'GET',url:o.url,headers:o.headers,data:o.data})
    .then(r=>{if(r.ok)o.onload&&o.onload({status:r.status,responseText:r.responseText});
              else o.onerror&&o.onerror(new Error(r.error));});
};`);

// ★ 只注入 huawei.user.js，时机 = document-start
await page.addInitScript(body);

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(5000);

const r = await page.evaluate(() => {
  const q = document.querySelector('#qp-huawei-grab-panel');
  return {
    panel: !!q,
    phase: q?.querySelector('#qp-phase')?.textContent || null,
    logs: q ? [...q.querySelectorAll('#qp-log div')].map((d) => d.textContent) : [],
  };
});

const real = errs.filter((e) => !/vmallres|chunk-|removeChild|updateHead/i.test(e));

console.log('只注入 huawei.user.js，document-start 时机（body 为 null）：');
console.log('  面板出现  :', r.panel ? '是 ✓' : '否 ✗');
console.log('  当前阶段  :', r.phase);
console.log('  脚本自身错误:', real.length ? real.map((e) => '  ✗ ' + e).join('\n') : '  无 ✓');
console.log('');
console.log('面板日志:');
console.log(r.logs.length ? r.logs.map((l) => '  ' + l).join('\n') : '  (空)');

await browser.close();
