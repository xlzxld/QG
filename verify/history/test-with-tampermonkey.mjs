/**
 * 用真实 Chrome + 真实 Tampermonkey 扩展打开商品页，
 * 抓脚本在油猴里的真实执行结果（面板有没有出现、控制台报什么）。
 *
 * 与之前 page.evaluate 注入的区别：这一次脚本由油猴自己加载，
 * 走完整的 metadata 解析 → 沙箱 → GM_* 注入流程，
 * 能复现「图标红叉 / 面板不出现」这类加载期问题。
 *
 * 用本机已装的油猴扩展（Chrome 扩展 ID dhdgffkkebhmkfjojejmpbldmpobfkfo）。
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';

const TM_ID = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const TM_PATH = `${process.env.LOCALAPPDATA}/Google/Chrome/User Data/Default/Extensions/${TM_ID}/5.5.1_0`;
const SCRIPT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace/grab/huawei.user.js';
const TARGET = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

if (!existsSync(TM_PATH)) {
  console.log('✗ 找不到油猴扩展目录:', TM_PATH);
  process.exit(1);
}
if (!existsSync(SCRIPT)) {
  console.log('✗ 找不到脚本:', SCRIPT);
  process.exit(1);
}

console.log('油猴扩展:', TM_PATH);
console.log('目标页面:', TARGET);
console.log('');

const userDataDir = `${process.env.TEMP}/tm-probe-profile-${Date.now()}`;

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  args: [
    `--disable-extensions-except=${TM_PATH}`,
    `--load-extension=${TM_PATH}`,
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
  ],
});

// 等扩展后台就绪
await new Promise((r) => setTimeout(r, 3000));

// 扩展 service worker
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
console.log('油猴后台:', sw ? sw.url() : '未就绪');

const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));

try {
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);
} catch (e) {
  logs.push(`[NAV_FAIL] ${e.message}`);
}

// 面板是否被油猴注入出来
const panel = await page.evaluate(() => {
  const p = document.querySelector('#qp-huawei-grab-panel');
  return p ? {
    phase: p.querySelector('#qp-phase')?.textContent,
    logs: [...p.querySelectorAll('#qp-log div')].map((d) => d.textContent),
  } : null;
});

console.log('');
console.log('=== 面板 ===');
console.log(panel ? JSON.stringify(panel, null, 2) : '✗ 面板不存在 —— 与你看到的现象一致');

console.log('');
console.log('=== 控制台（过滤噪音）===');
const filtered = logs.filter((l) => !/WebGL|first input delay|GPU stall|vmallres\.com|chunk-|openapi\.vmall|\[table\]|Array\(\d+\)/i.test(l));
console.log(filtered.length ? filtered.slice(0, 25).join('\n') : '(无相关输出)');

await ctx.close();
