/**
 * 验证控制台「采集范围」下拉栏（只读，不触发采集）
 * =====================================================================
 * 检查点：
 *   1. #onlyId 是 <select>（不再是输入框）
 *   2. 选项 = 全部商品 + 配置里每个商品（value 与爬虫视角 id 一致）
 *   3. 选择某个商品后 value 真的变化
 *   4. 页面无 JS 报错
 *
 * 用法：node grab-probe/verify-only-picker.mjs
 * =====================================================================
 */

import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'output');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.4, locale: 'zh-CN' });
const page = await ctx.newPage();

const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3500);

const info = await page.evaluate(() => {
  const sel = document.getElementById('onlyId');
  if (!sel) return { error: '找不到 #onlyId' };
  return {
    tagName: sel.tagName,
    options: [...sel.options].map((o) => ({ value: o.value, text: o.textContent })),
    currentValue: sel.value,
  };
});

console.log('=== #onlyId 检查 ===');
console.log('标签名:', info.tagName, info.tagName === 'SELECT' ? '✔ 是下拉栏' : '✘ 不是下拉栏');
console.log('当前值:', JSON.stringify(info.currentValue));
console.log('选项:');
for (const o of info.options) console.log(`  - value=${JSON.stringify(o.value)}  text=${JSON.stringify(o.text)}`);

// 选择第 3 个选项（第一个商品或全部之后第二项）试试真实交互
let interact = null;
if (info.options.length > 2) {
  const target = info.options[2];
  interact = await page.evaluate((val) => {
    const sel = document.getElementById('onlyId');
    sel.value = val;
    return { afterSelect: sel.value, selectedText: sel.selectedOptions[0]?.textContent };
  }, target.value);
  console.log('\n交互测试：选中', JSON.stringify(target.text), '→', JSON.stringify(interact));
}

// 截图采集卡片（滚动到顶部）
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: join(OUT, 'only-picker.png'), clip: { x: 0, y: 0, width: 1500, height: 560 } });

console.log('\n控制台 JS 错误:', errs.length ? JSON.stringify(errs, null, 1) : '无 ✔');
console.log('截图:', join(OUT, 'only-picker.png'));

await browser.close();
