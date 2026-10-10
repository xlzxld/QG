/**
 * 大麦控制台「链接解析后自动重填」实测（2026-10-10）
 * =====================================================================
 * 用户报的 bug：商品链接正确解析后, 「页面核对关键词」与「开抢时间」仍是上一个商品的陈旧文字。
 * 根因：两处预填都是"字段非空就永不覆盖"（autoFillGrabTime 直接 return；关键词 if(!value)）→ 换商品后不刷新。
 *
 * 本脚本用**真中枢 + 真 Chromium**（不是桩）跑 5 个场景, 含反向对照:
 *   ① 粘贴"杭州·王嘉尔"（探针库无开售提示）→ 关键词填成该商品, 开抢时间被清空 + 明示请手填
 *   ② 手工改成旧值后再换"贵阳·薛之谦"（有开售提示）→ 两个字段都必须刷新（不得留陈旧文字）
 *   ③ 同一个商品重复解析 → 手改过的值**不得被冲掉**（反向对照）
 *   ④ 本机已存参数被恢复后（页面重载）→ 不得被当成"换商品"而冲掉（primeGrabLinkBaseline 的护栏）
 *   ⑤ 恢复态下再换商品 → 仍必须刷新
 *
 * 自起一个中枢实例（端口 33121, 数据目录 = 临时目录 + 真探针库副本）→ 不污染 data/grab。
 * 用法：node verify/verify-grab-prefill-refresh.mjs
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
const TEST_PORT = 33121;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const SAVE_KEY = 'qg.grab.params.v1';

const LINK_HZ = 'https://m.damai.cn/shows/item.html?itemId=1079986171474&from=appshare';   // 杭州·王嘉尔（探针库: 无开售提示）
const LINK_GY = 'https://m.damai.cn/shows/item.html?itemId=1085142029424&from=appshare';   // 贵阳·薛之谦（探针库: 有开售提示）
const LINK_XM = 'https://m.damai.cn/shows/item.html?itemId=1083650546473&from=appshare';   // 厦门·薛之谦（另一站, 换商品用）

let failed = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${msg}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed++;
};

/* ---- 临时数据目录 + 抄一份真探针库（不碰生产 data/grab, 也不碰它的 pid 文件） ---- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefill-verify-'));
fs.copyFileSync(
  path.join(ROOT, 'data', 'grab', 'damai.catalog.json'),
  path.join(tmpDir, 'damai.catalog.json'),
);

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
    try {
      const r = await fetch(`${BASE}/api/catalog`);
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
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

  const passLink = async (link) => {
    await page.fill('#grab-link', '');
    await page.fill('#grab-link', link);
    await page.waitForTimeout(180);
  };
  const kws = () => page.inputValue('#grab-keywords');
  const tval = () => page.inputValue('#grab-time');
  const parsed = () => page.textContent('#grab-parsed');

  const waitCatalog = () => page.waitForFunction(() => {
    const sel = document.getElementById('catalog-select');
    return sel && sel.options.length > 1;
  }, { timeout: 15000 });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await waitCatalog();

  /* ---- ① 换到"探针库没有开售提示"的商品：关键词要填、时间要清空并明示 ---- */
  console.log('\n=== ① 粘贴杭州·王嘉尔（探针库无开售提示）===');
  await page.fill('#grab-keywords', '上一个商品的城市');
  await page.fill('#grab-time', '2026-10-17 17:17:00');
  await passLink(LINK_HZ);
  const kw1 = await kws(), t1 = await tval(), p1 = await parsed();
  ok(kw1.includes('王嘉尔'), '关键词自动更新为本商品的词', kw1);
  ok(!kw1.includes('上一个商品'), '关键词不留上一个商品的陈旧文字');
  ok(t1 === '', '无开售提示 → 开抢时间被清空（不沿用上一个商品的时间）', JSON.stringify(t1));
  ok(p1.includes('请手动填'), '解析提示明示"开抢时间请手动填"');

  /* ---- ② 换商品必须刷新两个字段（用户报的核心 bug） ---- */
  console.log('\n=== ② 手工改旧值 → 换贵阳·薛之谦（有开售提示）===');
  await page.fill('#grab-keywords', '旧商品旧关键词');
  await page.fill('#grab-time', '2026-01-01 09:00:00');
  await passLink(LINK_GY);
  const kw2 = await kws(), t2 = await tval();
  ok(!kw2.includes('旧商品'), '★ 关键词被刷新（修复前会一直显示陈旧文字）', kw2);
  ok(kw2.includes('薛之谦'), '关键词命中新商品名');
  ok(t2 !== '2026-01-01 09:00:00', '★ 开抢时间被刷新（修复前会一直显示陈旧时间）', t2);
  ok(/^\d{4}-10-02 17:17:00$/.test(t2), '开抢时间取自新商品最后一条开售提示', t2);

  /* ---- ③ 反向对照：同一个商品重复解析, 不得冲掉手改值 ---- */
  console.log('\n=== ③ 反面对照：同商品重复解析（手改值必须保住）===');
  await page.fill('#grab-keywords', '手工改过的词');
  const tBefore = await tval();
  await passLink(LINK_GY);
  ok((await kws()) === '手工改过的词', '同一商品重复解析 → 手改关键词不被冲掉');
  ok((await tval()) === tBefore, '同一商品重复解析 → 开抢时间不被冲掉');

  /* ---- ④ 重载后恢复已存参数, 不得被当成"换商品"冲掉 ---- */
  console.log('\n=== ④ 本机已存参数恢复（页面重载）===');
  await page.evaluate(([key, link]) => {
    localStorage.setItem(key, JSON.stringify({
      'grab-link': link,
      'grab-keywords': '已存的词',
      'grab-time': '2026-10-08 17:17:00',
    }));
  }, [SAVE_KEY, LINK_GY]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitCatalog();
  await page.waitForTimeout(250);
  ok((await kws()) === '已存的词', '重载恢复的已存关键词不被冲掉', await kws());
  ok((await tval()) === '2026-10-08 17:17:00', '重载恢复的已存开抢时间不被冲掉', await tval());

  /* ---- ⑤ 恢复态下换商品 → 仍必须刷新 ---- */
  console.log('\n=== ⑤ 恢复态下换商品（厦门站）===');
  await passLink(LINK_XM);
  const kw5 = await kws(), t5 = await tval();
  ok(!kw5.includes('已存的词'), '★ 恢复态下换商品 → 关键词照样刷新', kw5);
  ok(t5 !== '2026-10-08 17:17:00', '★ 恢复态下换商品 → 开抢时间照样刷新', t5);

  /* ---- ⑥ 保存按钮 == 「手动保存」, 且「清空已存」已彻底移除 ---- */
  console.log('\n=== ⑥ 参数保存方式（手动保存）===');
  const ui = await page.evaluate(() => ({
    hasReset: typeof window.resetGrabParams === 'function',
    saveBtn: !!document.querySelector('#btn-verify-script') && [...document.querySelectorAll('button')].some((b) => b.textContent.includes('保存参数')),
    resetBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('清空已存')),
  }));
  ok(!ui.hasReset && !ui.resetBtn, '「清空已存 / resetGrabParams」已彻底移除');
  ok(ui.saveBtn, '「💾 保存参数」按钮在位');

  /* ---- ⑦ 新增「验证手机脚本是否最新」按钮（没插手机也要给出全面提示, 不谎报成功）---- */
  console.log('\n=== ⑦ 「验证手机脚本是否最新」按钮 ===');
  await page.evaluate(() => document.getElementById('btn-verify-script').click());
  await page.waitForTimeout(1500);
  const vres = await page.evaluate(() => ({
    lines: [...document.querySelectorAll('#verify-steps .cs')].map((d) => d.textContent.trim()),
    btnText: document.getElementById('btn-verify-script').textContent.trim(),
  }));
  vres.lines.forEach((t) => console.log(`     • ${t}`));
  ok(vres.lines.length >= 3, '校验明细已渲染进卡片（提示要全面）');
  ok(vres.lines.some((t) => t.includes('电脑端脚本')), '明细含「电脑端脚本」（体积/版本）');
  ok(vres.lines.some((t) => t.includes('Agent 不在线') || t.includes('手机 Agent 在线')), '明细含手机侧状态');
  ok(vres.lines.some((t) => t.includes('手机侧提示')), '明细含手机侧提示结论');
  ok(vres.lines.some((t) => t.includes('下一步')), '明细含下一步建议');
  ok(vres.btnText.includes('验证手机脚本是否最新'), '按钮已复位, 可再次点击');

  await page.locator('.card.hero').screenshot({ path: path.join(ROOT, 'verify', 'output', 'grab-prefill-refresh.png') }).catch(() => {});
  await page.locator('.card:has(#btn-verify-script)').screenshot({ path: path.join(ROOT, 'verify', 'output', 'verify-script-panel.png') }).catch(() => {});
  console.log('\n截图: verify/output/grab-prefill-refresh.png + verify-script-panel.png');
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
