/**
 * 大麦控制台巡演分组 · UI 实测（2026-10-09）
 * =====================================================================
 * 验证 web/hub-console.html 的巡演多站选择能力：
 *   1. 巡演按项目分组（optgroup），各站可选、带状态（预约/缺货）与日期
 *   2. 切换站点：目标名/场次/信息条联动
 *   3. 未采全条目：下拉标注 ⏳未采全 + 显示"补采"按钮
 *   4. 非巡演条目（无 tourId）：平铺显示（向后兼容旧数据）
 *
 * 自起一个中枢实例（DEVICE_HUB_PORT=33120）用于测试，结束后自动清理；
 * 期间会覆盖 data/grab/device-hub.pid，脚本结束时会恢复原内容。
 *
 * 用法：node verify/verify-damai-console-ui.mjs
 * =====================================================================
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEST_PORT = 33120;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const PID_FILE = path.join(ROOT, 'data', 'grab', 'device-hub.pid');

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++; };

/* ---- 备份 PID 文件（测试实例会覆盖写入） ---- */
const pidExisted = fs.existsSync(PID_FILE);
const pidBackup = pidExisted ? fs.readFileSync(PID_FILE, 'utf8') : null;

/* ---- 拉起测试实例 ---- */
const hub = spawn(process.execPath, [path.join(ROOT, 'core', 'device-hub.mjs')], {
  cwd: ROOT,
  env: { ...process.env, DEVICE_HUB_PORT: String(TEST_PORT) },
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
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let browser;
try {
  const ready = await waitReady();
  ok(ready, '测试中枢实例就绪 (33120)');
  if (!ready) throw new Error('中枢未就绪');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => console.log('⚠️ 页面JS错误:', e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => {
    const sel = document.getElementById('catalog-select');
    return sel && sel.options.length > 1;
  }, { timeout: 15000 });

  /* ---- 1. 巡演分组结构 ---- */
  console.log('=== 1. 巡演分组下拉 ===');
  const groupInfo = await page.evaluate(() => {
    const sel = document.getElementById('catalog-select');
    return {
      groups: [...sel.querySelectorAll('optgroup')].map((g) => ({
        label: g.label,
        options: [...g.querySelectorAll('option')].map((o) => o.textContent.trim()),
      })),
      singles: [...sel.querySelectorAll(':scope > option')].map((o) => o.textContent.trim()),
    };
  });
  if (groupInfo.groups.length === 0) {
    console.log('⚠️ 当前探针库无巡演分组数据（catalog 为空或全是非巡演条目），仅验证基础结构');
  } else {
    const g = groupInfo.groups[0];
    console.log(`   分组: ${g.label}`);
    g.options.forEach((o) => console.log(`     • ${o}`));
    ok(g.options.length >= 2, `分组内选项数 >=2: ${g.options.length}`);
    ok(g.options.some((t) => /预约|缺货|在售/.test(t)), '选项带销售状态');
  }

  /* ---- 2. 选中站 → 信息条 + 场次联动 ---- */
  console.log('\n=== 2. 站点选择联动 ===');
  const meta = await page.$eval('#target-meta', (el) => el.textContent.trim());
  ok(meta.length > 0, `信息条显示: ${meta.slice(0, 80)}${meta.length > 80 ? '…' : ''}`);
  const firstChange = await page.evaluate(() => {
    const sel = document.getElementById('catalog-select');
    // 切到分组里最后一个选项（通常是不同站）
    const opts = [...sel.querySelectorAll('optgroup option')];
    const pick = opts.length > 1 ? opts[opts.length - 1] : opts[0];
    if (!pick) return null;
    sel.value = pick.value;
    onCatalogChange();
    return {
      name: document.getElementById('target-name').value,
      sessions: [...document.getElementById('session-select').options].length,
      metaHasStation: /站/.test(document.getElementById('target-meta').textContent),
    };
  });
  if (firstChange) {
    ok(firstChange.name.length > 0, `切换站后目标名: ${firstChange.name}`);
    ok(firstChange.metaHasStation, '信息条含站点');
  }

  /* ---- 3. 未采全条目：⏳标注 + 补采按钮 ---- */
  console.log('\n=== 3. 未采全条目提示 ===');
  const partial = await page.evaluate(() => {
    catalog.push({
      id: 'st-9999999999', itemId: '9999999999', tourId: '__test__',
      tourName: '【测试】巡演A', stationName: '测试站B',
      name: '【测试】巡演A- 测试站B',
      saleStatus: '预约', stationShowTime: '12.01-12.02', fullData: false,
      sessions: [], priceTiers: [],
    });
    renderCatalog();
    const sel = document.getElementById('catalog-select');
    const target = [...sel.options].find((o) => o.textContent.includes('测试站B'));
    sel.value = target.value;
    onCatalogChange();
    return {
      optionText: target.textContent.trim(),
      hasButton: !!document.querySelector('#target-meta button'),
    };
  });
  ok(/未采全/.test(partial.optionText), `下拉标注 ⏳未采全: "${partial.optionText}"`);
  ok(partial.hasButton, '显示"补采此站"按钮');

  /* ---- 4. 非巡演条目平铺（向后兼容） ---- */
  console.log('\n=== 4. 非巡演条目平铺 ===');
  const flat = await page.evaluate(() => {
    catalog.push({
      id: 'st-legacy', itemId: 'legacy-1', name: '某某独立演出', city: '上海',
      status: '在售', sessions: [], priceTiers: [], fullData: true,
    });
    renderCatalog();
    const sel = document.getElementById('catalog-select');
    const opt = [...sel.querySelectorAll(':scope > option')].find((o) => o.textContent.includes('某某独立演出'));
    return { exists: !!opt, text: opt ? opt.textContent.trim() : '', groups: sel.querySelectorAll('optgroup').length };
  });
  ok(flat.exists, `无 tourId 条目平铺显示: "${flat.text}"`);

  await page.screenshot({ path: path.join(ROOT, 'verify', 'output', 'damai-console-ui.png') }).catch(() => {});
} catch (e) {
  ok(false, `UI 验证异常: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  hub.kill();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2500);
    hub.on('exit', () => { clearTimeout(t); resolve(); });
  });
  // 恢复 PID 文件原状（测试实例退出时会删掉自己写的 PID，这里还原为备份内容）
  try {
    if (pidExisted) fs.writeFileSync(PID_FILE, pidBackup, 'utf8');
    else if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch (e) { console.log('⚠️ PID 文件恢复失败:', e.message); }
}

console.log(failed === 0 ? '\n🎉 全部通过' : `\n⚠️ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
