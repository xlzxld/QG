/**
 * 验证「删商品后采集下拉栏即时刷新」（2026-10-07 修复的回归测试）
 * =====================================================================
 * 场景（净零副作用：临时商品最后必定清掉，配置回到测试前状态）：
 *   1. 经 API 加一个临时商品（id=ZZ-验证临时商品）
 *   2. 打开控制台：下拉栏应已包含它
 *   3. 在页面上点它的「删除这个商品」→ 自动接受确认框
 *   4. 不刷新页面：下拉栏应立刻不含它（核心断言）；
 *      且已删商品 "HUAWEI Mate 90" 也不该出现在下拉栏里
 *   5. 脚本结束前复核：配置商品数回到测试前；没回去就强制清
 * 用法：node grab-probe/verify-picker-refresh.mjs
 * （需要桥接在 3100 运行）
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3100';
const TEMP_ID = 'ZZ-验证临时商品';
const TEMP_URL = 'https://item.vmall.com/product/comdetail/index.html?prdId=99999999999999';

const getCfg = async () => (await (await fetch(`${BASE}/api/config/huawei`)).json());
const putProducts = async (products) => (await (await fetch(`${BASE}/api/config/huawei/products`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ products }),
})).json());

let browser = null;
try {
  const cfg0 = await getCfg();
  const n0 = (cfg0.products || []).length;
  console.log(`测试前商品数：${n0}`);
  if ((cfg0.products || []).some((p) => p.id === TEMP_ID)) throw new Error('已存在同名临时商品，请先人工清理');

  await putProducts([...(cfg0.products || []), {
    id: TEMP_ID, enabled: true, url: TEMP_URL, skuIds: [], maxPrice: null, quantity: 1, saleAt: null,
  }]);
  console.log('已加临时商品（只用于本次验证，不会参与任何采集）');

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept()); // 删除确认框：一律接受

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#onlyId option').length > 1, null, { timeout: 15000 });
  await page.waitForTimeout(600);

  const readPicker = () => page.evaluate(() =>
    [...document.getElementById('onlyId').options].map((o) => ({ value: o.value, text: o.textContent })));

  const before = await readPicker();
  console.log(`页面加载后：下拉栏 ${before.length} 项；含临时商品=${before.some((o) => o.value === TEMP_ID)}（应 true）`);
  console.log(`已删商品 "HUAWEI Mate 90" 在下拉栏=${before.some((o) => o.value === 'HUAWEI Mate 90')}（应 false）`);

  const card = page.locator(`.prod[data-i="${n0}"]`);
  if (!(await card.count())) throw new Error('页面上找不到临时商品卡片（data-i=' + n0 + '）');
  await card.locator('.hd').click(); // 展开卡片（卡片体是懒渲染，展开后才出现删除按钮）
  const delBtn = card.locator('.bd [data-del]');
  await delBtn.waitFor({ state: 'visible', timeout: 5000 });
  await delBtn.click();
  console.log('已点击「删除这个商品」（确认框已自动接受）');

  let refreshed = false;
  try {
    await page.waitForFunction(
      (tid) => ![...document.getElementById('onlyId').options].some((o) => o.value === tid),
      TEMP_ID, { timeout: 8000 });
    refreshed = true;
  } catch { /* 没刷新出来 */ }

  const after = await readPicker();
  console.log(refreshed
    ? '✔ 下拉栏已即时移除临时商品（无需刷新页面）'
    : '✘ 下拉栏仍含临时商品 —— 修复没生效？');
  console.log(`删除后：下拉栏 ${after.length} 项；含临时商品=${after.some((o) => o.value === TEMP_ID)}（应 false）`);
  console.log(`页面 JS 异常：${errs.length ? errs.join(' | ') : '无 ✓'}`);

  const cfg1 = await getCfg();
  console.log(`删除后商品数：${(cfg1.products || []).length}（应回到 ${n0}）`);
} catch (e) {
  console.log('验证失败：' + e.message);
} finally {
  try {
    const cfg = await getCfg();
    if ((cfg.products || []).some((p) => p.id === TEMP_ID)) {
      await putProducts((cfg.products || []).filter((p) => p.id !== TEMP_ID));
      console.log('已强制清理临时商品（兜底）');
    }
  } catch (e) { console.log('清理检查失败：' + e.message); }
  if (browser) await browser.close().catch(() => {});
}
console.log('验证结束');
process.exit(0); // 显式退出：playwright 的浏览器进程句柄可能吊住事件循环
