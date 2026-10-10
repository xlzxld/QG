/**
 * 大麦控制台「开抢时间闸门」实测（2026-10-10 实战事故复盘）
 * =====================================================================
 * 事故：13:30 开抢的场次, 用户 13:29:30 点「抢购」, 却一直被拦, 提示"距离现在不足 8 秒, 来不及就位"。
 * 复盘：旧代码只有一条 `fireAt - Date.now() < 8000` 硬拦, **把"时间已经过去"和"不足 8 秒"混成同一句话**;
 *       用户把 13:30 写成了 "1:30"(12 小时制), 被解析成 01:30 = 已过去 12 小时 → 于是报"不足 8 秒",
 *       用户完全看不懂, 而且**没有任何办法走下去**(硬拦, 没有确认)。
 * 现在：解析统一走 `parseFireTime`, 输入框旁边**实时回显"解析成几点 + 距现在多久"**,
 *       已过去/只剩几秒**只提醒不阻断** —— 点「抢购」= 直接下发, 没有任何二次确认(2026-10-10 用户口径)。
 *
 * 本脚本用真中枢(33122, 临时数据目录+真探针库副本) + 真 Chromium 跑:
 *   ① 未来 2 分钟   → 回显"距现在 …"(绿)
 *   ② 未来 3 秒     → 回显"只剩 3.x 秒"(黄, 提示就位需 5~8 秒)
 *   ③ "2026-10-10 1:30:00"(已过去) → 回显"已过去 …" + 24 小时制提醒(红)
 *   ④ ③的状态下点「抢购」→ **不弹确认框**, 只给提醒, 并继续往下走到通道检查(证明没被拦)
 *   ⑤ 非法输入 "下午一点半" → 回显"无法识别"(红), 点抢购 → 报"无法识别"而不是 8 秒
 *   ⑥ 只写时分 "13:30" → 按今天解析(唯一行为, 不再因缺日期而报"时间格式错误")
 *
 * 用法：node verify/verify-grab-time-guard.mjs
 * =====================================================================
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEST_PORT = 33122;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const LINK = 'https://m.damai.cn/shows/item.html?itemId=1079986171474&from=appshare';
const PAST_TRAP = '2026-10-10 1:30:00';   // 事故原样: 想写 13:30 却写成 1:30

let failed = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${msg}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed++;
};
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'time-guard-verify-'));
fs.copyFileSync(path.join(ROOT, 'data', 'grab', 'damai.catalog.json'), path.join(tmpDir, 'damai.catalog.json'));

const hub = spawn(process.execPath, [path.join(ROOT, 'core', 'device-hub.mjs')], {
  cwd: ROOT,
  env: { ...process.env, DEVICE_HUB_PORT: String(TEST_PORT), DEVICE_HUB_DATA_DIR: tmpDir, DEVICE_HUB_FAKE_NO_ADB: '1' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
hub.stdout.on('data', () => {});
hub.stderr.on('data', (d) => process.stderr.write(`[hub] ${d}`));

async function waitReady(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`${BASE}/api/catalog`)).ok) return true; } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let browser;
try {
  ok(await waitReady(), `测试中枢实例就绪 (${TEST_PORT} · 临时数据目录)`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 980 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const hint = () => page.textContent('#grab-time-parsed');
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent));
  const modal = () => page.evaluate(() => {
    const mask = document.getElementById('modal-mask');
    return { open: !!mask && mask.classList.contains('show'), title: document.getElementById('modal-title').textContent, body: document.getElementById('modal-body').textContent };
  });
  const setTime = async (v) => { await page.fill('#grab-time', v); await page.waitForTimeout(150); };

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('catalog-select')?.options.length > 1, { timeout: 15000 });
  await page.fill('#grab-link', LINK);
  await page.waitForTimeout(150);

  /* ---- ① 未来 2 分钟: 绿色"距现在" ---- */
  console.log('\n=== ① 未来 2 分钟 ===');
  await setTime(stamp(Date.now() + 120000));
  const h1 = await hint();
  console.log(`     回显: ${h1}`);
  ok(h1.includes('距现在') && h1.includes('解析为'), '回显"解析为 … · 距现在 …"');

  /* ---- ② 未来 3 秒: 黄色"只剩" ---- */
  console.log('\n=== ② 未来 3 秒 ===');
  await setTime(stamp(Date.now() + 3000));
  const h2 = await hint();
  console.log(`     回显: ${h2}`);
  ok(h2.includes('只剩'), '回显"只剩 N 秒"');
  ok(h2.includes('5~8 秒'), '提示手机就位需要 5~8 秒');

  /* ---- ③ 12/24 小时制陷阱: 已过去的时间必须说清"已过去" ---- */
  console.log('\n=== ③ 事故原样: "' + PAST_TRAP + '"（想写 13:30） ===');
  await setTime(PAST_TRAP);
  const h3 = await hint();
  console.log(`     回显: ${h3}`);
  ok(h3.includes('已过去'), '回显"已过去 …"（不再说"不足 8 秒"）');
  ok(h3.includes('01:30:00'), '回显把解析结果摊开: 01:30:00（12/24 写错一眼可见）');
  ok(h3.includes('24 小时制'), '给出 24 小时制提醒');

  /* ---- ④ 这种状态点「抢购」: 不弹确认框、不被拦, 只提醒后继续往下走 ---- */
  console.log('\n=== ④ 点「抢购」: 不拦, 直接往下走 ===');
  const msgsBefore = (await toasts()).length;
  await page.evaluate(() => { window.grabArm(); });   // 不 return promise: 免得 evaluate 挂在异步流程上
  await page.waitForTimeout(1300);
  const m4 = await modal();
  const t4 = (await toasts()).slice(msgsBefore).join(' ｜ ');
  console.log(`     新提示: ${t4.slice(0, 170)}`);
  ok(!m4.open, '★ 不弹任何二次确认框（点抢购 = 直接执行）');
  ok(t4.includes('已过去'), '只给"开抢时间已过去"的提醒');
  ok(t4.includes('直接下发'), '明确告知已按设置直接下发');
  ok(t4.includes('1:30'), '提醒点到 12/24 小时制的坑');
  ok(t4.includes('手机未连接') || t4.includes('无法连接中枢'), '继续走到了通道检查（证明没被拦在时间这一步）');

  /* ---- ⑤ 非法输入: 报"无法识别", 不是 8 秒 ---- */
  console.log('\n=== ⑤ 非法输入「下午一点半」 ===');
  await setTime('下午一点半');
  const h5 = await hint();
  console.log(`     回显: ${h5}`);
  ok(h5.includes('无法识别'), '回显"无法识别"');
  const msgs5 = (await toasts()).length;
  await page.evaluate(() => { window.grabArm(); });
  await page.waitForTimeout(700);
  const t5 = (await toasts()).slice(msgs5).join(' | ');
  console.log(`     提示: ${t5.slice(0, 110)}`);
  ok(t5.includes('无法识别'), '点抢购报"无法识别"（不再误报 8 秒）');
  ok(!t5.includes('8 秒'), '不出现"8 秒"字样');
  const m5 = await modal();
  ok(!m5.open, '格式错误直接提示, 不弹确认框');

  /* ---- ⑥ 只写时分: 按今天解析 ---- */
  console.log('\n=== ⑥ 只写时分「13:30」 ===');
  await setTime('13:30');
  const h6 = await hint();
  console.log(`     回显: ${h6}`);
  ok(/解析为 \d{4}-\d{2}-\d{2} 13:30:00/.test(h6), '只写时分也能解析（自动按今天补日期）');

  await page.locator('.card.hero').screenshot({ path: path.join(ROOT, 'verify', 'output', 'grab-time-guard.png') }).catch(() => {});
  console.log('\n截图: verify/output/grab-time-guard.png');
  if (pageErrors.length) console.log('⚠️ 页面 JS 错误:', pageErrors.join(' | '));
} catch (e) {
  ok(false, `验证异常: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  hub.kill();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2500);
    hub.on('exit', () => { clearTimeout(t); resolve(); });
  });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

console.log(failed === 0 ? '\n🎉 全部通过' : `\n⚠️ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
