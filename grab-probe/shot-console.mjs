/**
 * 控制台面板截图（只读）
 * =====================================================================
 * 目的：肉眼确认重构后的面板排版是否清楚（这是给用户看的界面，得看过才知道）。
 *
 * 用法：node grab-probe/shot-console.mjs
 * =====================================================================
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1.4, locale: 'zh-CN' });
const page = await ctx.newPage();

const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3500);

const files = [];

// 1) 商品与 SKU 页（默认页，含展开的 SKU 表）
let f = join(OUT, 'console-1-products.jpg');
await page.screenshot({ path: f, type: 'jpeg', quality: 72 });
files.push(f);

// 2) 采集状态：把统计行也带上
await page.evaluate(() => window.scrollTo(0, 0));

// 3) 抢购设置页
await page.click('.tab[data-p="page-settings"]');
await page.waitForTimeout(700);
f = join(OUT, 'console-2-settings.jpg');
await page.screenshot({ path: f, type: 'jpeg', quality: 72 });
files.push(f);

// 4) 抢购结果页
await page.click('.tab[data-p="page-results"]');
await page.waitForTimeout(700);
f = join(OUT, 'console-3-results.jpg');
await page.screenshot({ path: f, type: 'jpeg', quality: 72 });
files.push(f);

// 5) 怎么用页
await page.click('.tab[data-p="page-about"]');
await page.waitForTimeout(700);
f = join(OUT, 'console-4-about.jpg');
await page.screenshot({ path: f, type: 'jpeg', quality: 72 });
files.push(f);

// 校验页面确实渲染出了东西
await page.click('.tab[data-p="page-products"]');
await page.waitForTimeout(500);
const check = await page.evaluate(() => ({
  商品卡片数: document.querySelectorAll('.prod').length,
  SKU表行数: document.querySelectorAll('tbody tr').length,
  维度按钮数: document.querySelectorAll('.dimbtn').length,
  顶栏状态: document.getElementById('statLine')?.innerText,
  采集统计: document.getElementById('crawlStat')?.innerText,
  首个SKU行: document.querySelector('tbody tr')?.innerText?.replace(/\s+/g, ' ').slice(0, 130),
}));

console.log('=== 渲染校验 ===');
for (const [k, v] of Object.entries(check)) console.log(' ', k, '=', JSON.stringify(v));
console.log('\n控制台错误:', errs.length ? JSON.stringify(errs, null, 1) : '无');
console.log('\n截图:');
files.forEach((x) => console.log('  ', x));

await browser.close();