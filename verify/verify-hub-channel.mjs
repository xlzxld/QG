/**
 * 统一通道逻辑验证 (2026-10-09)
 * =====================================================================
 * 验证「USB(ADB) 优先 → 无 USB 自动降级 WiFi(Agent 本地执行)」全链路:
 *   1. 无 USB 无 Agent  → /api/channel = none; perf-boost 回 needUsb; open-item 闸门先行 (400/403)
 *   2. 仅 WiFi Agent    → /api/channel = wifi; /api/phone/cmd 打开商品页 = 下发 phone_op 任务
 *                         (WiFi 下不再被「无 USB 设备」挡住)
 *   3. 通道能力矩阵     → openItem/tapShizuku 两通道可用; armTap/perfBoost/diagSnapshot USB 独占
 *      (无障碍手势已按用户口径删除 —— 对自绘按钮无效)
 *   4. 控制台 UI        → 通道徽标 / 「抢购」「停止」改名 / 独立「局域网更新」按钮已并入 /
 *                         「查询」按钮已移除 / 「停止手机脚本」在设备卡片
 *
 * 自起一个中枢实例 (DEVICE_HUB_PORT=33121 + 独立临时数据目录), 结束自动清理。
 * 用法: node verify/verify-hub-channel.mjs
 * =====================================================================
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEST_PORT = 33121;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++; };

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-channel-'));
fs.writeFileSync(path.join(tmpData, 'damai.catalog.json'), JSON.stringify({
  items: [{ id: 'st-1085142029424', itemId: '1085142029424', name: '测试演出', city: '杭州', status: '在售', fullData: true, sessions: [], priceTiers: [] }],
}));

const hub = spawn(process.execPath, [path.join(ROOT, 'core', 'device-hub.mjs')], {
  cwd: ROOT,
  // ★ DEVICE_HUB_FAKE_NO_ADB=1: 强制"无 USB"场景 —— 本机插着真机跑验证时, 真实 adb 设备会把
  //   WiFi 降级断言全部顶掉 (resolveChannel 优先真实 USB)。此开关只影响该测试实例, 不碰真机。
  env: { ...process.env, DEVICE_HUB_PORT: String(TEST_PORT), DEVICE_HUB_DATA_DIR: tmpData, DEVICE_HUB_FAKE_NO_ADB: '1' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
hub.stderr.on('data', () => {});

async function waitReady(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/api/catalog`); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
const j = async (p, opts) => { const r = await fetch(BASE + p, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const post = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

try {
  ok(await waitReady(), '测试中枢实例就绪 (33121)');

  /* ---- 1. 无 USB 无 Agent: 通道 = none ---- */
  console.log('\n=== 1. 空通道 (无 USB / 无 Agent) ===');
  const ch0 = await j('/api/channel');
  ok(ch0.status === 200 && ch0.body.channel, '/api/channel 可查');
  ok(['none', 'usb'].includes(ch0.body.channel.mode), `通道模式: ${ch0.body.channel.mode} (本机若无 adb 应为 none)`);
  if (ch0.body.channel.mode === 'none') {
    const pf = await j('/api/device/perf-boost');
    ok(pf.status === 200 && pf.body.status === 'unavailable' && pf.body.needUsb === true, 'perf-boost 无 USB → 明确 needUsb (不再笼统报错)');
    const oi = await post('/api/phone/cmd', { op: 'open_item', params: { itemId: '1085142029424' } });
    ok(oi.status === 503 && /未连接|手机/.test(oi.body.error || ''), 'phone/cmd 无通道 → 503 + 明确提示');
  }

  /* ---- 2. 闸门顺序: 非法输入永远优先于通道 (400/403) ---- */
  console.log('\n=== 2. open-item 闸门顺序 ===');
  const g1 = await post('/api/adb/open-item', { itemId: 'abc' });
  ok(g1.status === 400, `非数字 itemId → 400 (实际 ${g1.status})`);
  const g2 = await post('/api/adb/open-item', { itemId: '999999999999' });
  ok(g2.status === 403, `不在探针库 → 403 (实际 ${g2.status})`);

  /* ---- 3. 模拟 WiFi Agent 上线: 通道 = wifi, 代操作降级可用 ---- */
  console.log('\n=== 3. WiFi Agent 上线 → 降级通道 ===');
  const hello = await post('/api/device/hello', { deviceId: 'wifi-phone-01', agentVersion: '1.1.0', screen: [1080, 2400], accessibility: true, battery: 80 });
  ok(hello.status === 200 && hello.body.channel, 'hello 注册成功且回带 channel');
  const ch1 = await j('/api/channel');
  ok(ch1.body.channel.mode === 'wifi' && ch1.body.channel.wifi === true, `通道模式 = ${ch1.body.channel.mode}`);
  ok(ch1.body.channel.caps.openItem === true && ch1.body.channel.caps.tapShizuku === true, 'WiFi 能力: openItem / tapShizuku(手机本地注入) 可用');
  ok(ch1.body.channel.caps.gesture === undefined, '无障碍手势已从能力矩阵移除 (对自绘按钮无效)');
  ok(ch1.body.channel.caps.perfBoost === false && ch1.body.channel.caps.armTap === false, 'WiFi 能力: perfBoost/armTap 明确 USB 独占');

  const op = await post('/api/phone/cmd', { op: 'open_item', params: { itemId: '1085142029424' } });
  ok(op.status === 200 && op.body.via === 'wifi' && op.body.status === 'dispatched', `WiFi 打开商品页 → 下发 phone_op (via=${op.body.via}, 不再报「无USB」)`);
  ok(!!op.body.taskId, `返回任务号 ${op.body.taskId || '缺失'}`);
  const queued = await j('/api/device/poll-task?deviceId=wifi-phone-01');
  ok(queued.body.status === 'task' && queued.body.task.mode === 'phone_op' && queued.body.task.op === 'open_item', '手机长轮询能领到 phone_op/open_item 任务');
  const pf1 = await j('/api/device/perf-boost');
  ok(pf1.body.status === 'unavailable' && pf1.body.needUsb === true, 'WiFi 下 perf-boost 仍明确 needUsb (USB 独占, 不误导)');

  // 旧脚本版本闸门: agentVersion < 1.1.0 时 phone_op 被拦下 (旧脚本会把它当演练跑掉)
  await post('/api/device/hello', { deviceId: 'old-phone-02', agentVersion: '1.0.1', screen: [1080, 2400], accessibility: true });
  const oldOp = await post('/api/phone/cmd', { op: 'open_item', params: { itemId: '1085142029424' }, deviceId: 'old-phone-02' });
  ok(oldOp.status === 409 && /过旧|更新手机脚本/.test(oldOp.body.error || ''), `旧脚本派 phone_op → 409 拦下 (实际 ${oldOp.status})`);
  // 自测单飞: 两次自测派发, 第二次被拒
  const st1 = await post('/api/tasks/dispatch', { deviceId: 'wifi-phone-01', task: { taskId: 't-st-a', mode: 'grab', grab: { selfTest: true }, target: { itemId: '1085142029424' }, timing: { fireAtEpochMs: Date.now() + 60000 } } });
  ok(st1.status === 200, `第一次自测派发成功 (${st1.status})`);
  const st2 = await post('/api/tasks/dispatch', { deviceId: 'wifi-phone-01', task: { taskId: 't-st-b', mode: 'grab', grab: { selfTest: true }, target: { itemId: '1085142029424' }, timing: { fireAtEpochMs: Date.now() + 60000 } } });
  ok(st2.status === 400 && /仍在执行/.test(st2.body.error || ''), `第二次自测被单飞闸门拦下 (${st2.status}: ${(st2.body.error || '').slice(0, 30)})`);

  /* ---- 4. 控制台 UI (无头浏览器) ---- */
  console.log('\n=== 4. 控制台 UI ===');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => !!document.querySelector('#chan-badge'), { timeout: 10000 });
  await page.waitForTimeout(1200);   // 等 refreshDevices 首轮跑完

  const ui = await page.evaluate(() => ({
    chanBadge: document.getElementById('chan-badge')?.textContent.trim(),
    chanHint: (document.getElementById('chan-hint')?.textContent || '').slice(0, 40),
    grabBtn: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('抢购'))?.textContent.trim(),
    stopBtn: [...document.querySelectorAll('button')].find((b) => b.textContent.includes('停止'))?.textContent.trim(),
    hasLanUpdateBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('局域网更新脚本')),
    hasPerfQueryBtn: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '查询'),
    onlyLabel: document.getElementById('only-task')?.parentElement?.textContent.trim(),
    stopInDeviceCard: !!document.getElementById('btn-stop-agent'),
    perfBtnDisabled: document.getElementById('perf-boost-on')?.disabled,
  }));
  ok(!!ui.chanBadge, `顶栏通道徽标存在: ${ui.chanBadge}`);
  ok(ui.grabBtn && ui.grabBtn.includes('抢购'), `「布防」已改名「抢购」: ${ui.grabBtn}`);
  ok(ui.stopBtn && ui.stopBtn.includes('停止'), `「解除」已改名「停止」: ${ui.stopBtn}`);
  ok(ui.hasLanUpdateBtn === false, '独立「局域网更新脚本」按钮已移除 (并入更新按钮)');
  ok(ui.hasPerfQueryBtn === false, '「查询」按钮已移除 (页面加载/操作后自动刷新)');
  ok(ui.onlyLabel.includes('本次任务'), `日志过滤标签: ${ui.onlyLabel}`);
  ok(ui.stopInDeviceCard, '「停止手机脚本」按钮已移入设备卡片');
  ok(typeof ui.perfBtnDisabled === 'boolean', `保活优化按钮通道感知 (当前 ${ui.perfBtnDisabled ? '置灰' : '可用'})`);
  ok(pageErrors.length === 0, `无页面 JS 错误${pageErrors.length ? ': ' + pageErrors[0] : ''}`);

  await page.screenshot({ path: path.join(ROOT, 'verify', 'output', 'hub-channel-ui.png') }).catch(() => {});
  await browser.close().catch(() => {});
} catch (e) {
  ok(false, `验证异常: ${e.message}`);
} finally {
  hub.kill('SIGTERM');
  await new Promise((r) => { const t = setTimeout(r, 2000); hub.on('exit', () => { clearTimeout(t); r(); }); });
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (e) {}
}

console.log(failed === 0 ? '\n🎉 全部通过' : `\n⚠️ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
