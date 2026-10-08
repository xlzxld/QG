/**
 * 单独截「抢购行为」卡片（只读）
 * 2026-10-08：面板全量化改版后，确认新排版清楚、大白话标注读得懂。
 * 用法：node grab-probe/shot-settings-card.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN' });
const page = await ctx.newPage();

const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3500);
await page.click('.tab[data-p="page-settings"]');
await page.waitForTimeout(700);
// 吸顶导航会盖住卡片顶部，截图前按平它（只影响截图，不改项目文件）
await page.addStyleTag({ content: 'header { position: static !important; }' });

const card = page.locator('#page-settings .card').filter({ hasText: '抢购行为' });
const f = join(OUT, 'settings-card.png');
await card.screenshot({ path: f });

console.log('截图:', f);
console.log('控制台错误:', errs.length ? JSON.stringify(errs, null, 1) : '无');
await browser.close();
