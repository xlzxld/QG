/**
 * 大麦控制台 2026-10-10 改版实测（真中枢 + 真 Chromium）
 * =====================================================================
 * 覆盖本轮 12 条需求里"能在浏览器里验"的部分（不是读源码猜, 是真 DOM 行为 + 真下发报文）：
 *   ① 执行方式下拉已移除; 旧「彩排 / 无脑高频」字样不再出现
 *   ② 抢购按钮左侧新增**绿色测试**按钮 (DOM 顺序 + 颜色类 btn ok)
 *   ③ 到点盲点一发开关在位, 勾选后下发报文 blindFire=true; 不勾 → 不下发该开关(或 false)
 *   ④ 双读确认 / 弹窗起始延迟 / 弹窗探测间隔 / 终态看护间隔 四个输入在位且默认值 50/300/50/400,
 *     点「抢购」后原样进下发报文
 *   ⑤ 「🧪 测试」按钮下发时 dryRun=true; 「🚀 抢购」下发时 dryRun 不为真 (同一份参数)
 *   ⑥ 「🩺 全面自检」按钮在位, 点击后逐项渲染, 末尾按**当前通道**给出链路说明 (USB / Wi-Fi 文案不同)
 *
 * 自起中枢实例 (端口 33122, 数据目录 = 临时目录 + 真探针库副本) → 不污染 data/grab。
 * 用法：node verify/verify-grab-console-v2.mjs
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
const TEST_PORT = 33123;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const LINK = 'https://m.damai.cn/shows/item.html?itemId=1085142029424&from=appshare';

let failed = 0;
const ok = (cond, msg, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${msg}${extra ? ' → ' + extra : ''}`);
  if (!cond) failed++;
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grabv2-'));
try {
  fs.copyFileSync(path.join(ROOT, 'data', 'grab', 'damai.catalog.json'), path.join(tmpDir, 'damai.catalog.json'));
} catch (e) { /* 没探针库也能跑 */ }

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
    try { const r = await fetch(`${BASE}/api/catalog`); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let browser;
try {
  ok(await waitReady(), `测试中枢实例就绪 (${TEST_PORT} · 临时数据目录)`);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // 捕获抢购下发报文 (不真发到手机): 截获 /api/tasks/dispatch, 回一个假 200
  let lastTask = null;
  await page.route('**/api/tasks/dispatch', async (route) => {
    try { lastTask = JSON.parse(route.request().postData() || '{}').task || null; } catch (e) {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'dispatched', taskId: lastTask?.taskId }) });
  });
  // 通道桩: 没有真机时 requireChannel() 会以"未连接"把下发挡掉 —— 这里给个 USB 通道
  // 设备桩: grabArm 现在**两种通道都要求"脚本真的在跑"** (手机 Agent 在线), 所以也要给一台假在线设备
  const stubDevices = async () => {
    await page.unroute('**/api/devices').catch(() => {});
    await page.route('**/api/devices', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        devices: [{ deviceId: 'verify-phone', model: 'VerifyPhone', isAlive: true, isAdbOnly: false, screen: [1080, 2400], shizuku: 'active', agentVersion: '1.5.1', state: 'idle' }],
        adbDevicesCount: 1, httpAgentsCount: 1, hubAgentScriptSize: 0,
        channel: { mode: 'usb', usb: true, wifi: false, shizuku: 'active', shizukuReady: true, deviceId: 'verify-phone' },
      }),
    }));
  };
  const stubUsbChannel = async () => {
    await page.unroute('**/api/channel').catch(() => {});
    await page.route('**/api/channel', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ channel: { mode: 'usb', usb: true, wifi: false, shizuku: 'active', shizukuReady: true, deviceId: 'verify-phone' } }),
    }));
    await page.evaluate(() => { chanState = { mode: 'usb', usb: true, wifi: false, shizuku: 'active' }; });
  };
  await stubDevices();
  await stubUsbChannel();

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => {
    const sel = document.getElementById('catalog-select');
    return sel && sel.options.length > 1;
  }, { timeout: 15000 });

  /* ---- ① 旧模式彻底移除 ---- */
  console.log('\n=== ① 旧模式（彩排 / 无脑高频 / 执行方式下拉）已移除 ===');
  const legacy = await page.evaluate(() => ({
    execSel: !!document.getElementById('grab-exec'),
    rehWrap: !!document.getElementById('grab-reh-wrap'),
    rehMs: !!document.getElementById('grab-reh-ms'),
    heroText: document.querySelector('.card.hero').textContent,
    hasFn: typeof window.onGrabExecChange,
  }));
  ok(!legacy.execSel, '「执行方式」下拉已移除');
  ok(!legacy.rehWrap && !legacy.rehMs, '彩排时间 / 彩排连点时长输入已移除');
  ok(!/彩排|无脑高频/.test(legacy.heroText), '卡片里不再出现「彩排 / 无脑高频」字样');
  ok(legacy.hasFn === 'undefined', 'onGrabExecChange 已删除');

  /* ---- ② 绿色测试按钮在抢购左侧 ---- */
  console.log('\n=== ② 绿色「测试」按钮（抢购左侧）===');
  const btnInfo = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.card.hero .btnrow .btn')];
    const idxTest = btns.findIndex((b) => b.textContent.includes('测试'));
    const idxArm = btns.findIndex((b) => b.textContent.includes('抢购'));
    const t = btns[idxTest], a = btns[idxArm];
    return {
      idxTest, idxArm,
      testLabel: t ? t.textContent.trim() : '',
      testClass: t ? t.className : '',
      testOnclick: t ? t.getAttribute('onclick') : '',
      armOnclick: a ? a.getAttribute('onclick') : '',
      testLeftOfArm: (t && a) ? (t.getBoundingClientRect().left < a.getBoundingClientRect().left) : false,
      check: !!document.querySelector('.card.hero .btnrow .btn[onclick="grabFullCheck()"]'),
    };
  });
  ok(btnInfo.idxTest >= 0, `「测试」按钮在位: "${btnInfo.testLabel}"`);
  ok(/btn ok/.test(btnInfo.testClass), '测试按钮用绿色样式 (btn ok)', btnInfo.testClass);
  ok(btnInfo.testOnclick === 'grabArm(true)', '测试按钮 → grabArm(true) (测试模式)', btnInfo.testOnclick);
  ok(btnInfo.armOnclick === 'grabArm(false)', '抢购按钮 → grabArm(false) (正式)', btnInfo.armOnclick);
  ok(btnInfo.testLeftOfArm, '测试按钮确实在抢购按钮**左侧**');
  ok(btnInfo.check, '「🩺 全面自检」按钮在位');

  /* ---- ③④ 新参数默认值 + 下发报文 ---- */
  console.log('\n=== ③④ 新参数在位 / 默认值 / 下发报文 ===');
  const defaults = await page.evaluate(() => ({
    blind: !!document.getElementById('grab-blindfire'),
    blindChecked: document.getElementById('grab-blindfire')?.checked,
    dr: document.getElementById('grab-double-read')?.value,
    pd: document.getElementById('grab-popup-delay')?.value,
    pp: document.getElementById('grab-popup-poll')?.value,
    wp: document.getElementById('grab-watch-poll')?.value,
  }));
  ok(defaults.blind, '「到点盲点一发」开关在位');
  ok(defaults.blindChecked === false, '盲点开关默认关');
  ok(defaults.dr === '50', `双读确认默认 50ms (实际 ${defaults.dr})`);
  ok(defaults.pd === '300', `弹窗起始延迟默认 300ms (实际 ${defaults.pd})`);
  ok(defaults.pp === '50', `弹窗探测间隔默认 50ms (实际 ${defaults.pp})`);
  ok(defaults.wp === '400', `终态看护间隔默认 400ms (实际 ${defaults.wp})`);

  await page.fill('#grab-link', LINK);
  await page.fill('#grab-time', '2026-10-11 13:30:00');
  await page.waitForTimeout(250);
  await stubUsbChannel();
  await page.check('#grab-blindfire');
  const hintOn = await page.textContent('#grab-blind-hint');
  ok(/已开/.test(hintOn), '勾选盲点后提示切换为「已开」', hintOn.slice(0, 30));
  // 改一个值验证"改完能生效"
  await page.fill('#grab-double-read', '40');
  await page.fill('#grab-popup-poll', '45');
  await page.fill('#grab-watch-poll', '350');
  await page.click('button[onclick="grabArm(false)"]');
  await page.waitForTimeout(400);
  const g = lastTask?.grab || {};
  ok(lastTask && lastTask.mode === 'grab', '点「抢购」确实下发了 grab 任务');
  ok(g.dryRun !== true, '「抢购」不下发测试标志 (dryRun 不为真)', String(g.dryRun));
  ok(g.blindFire === true, '盲点开关随下发带上 (blindFire=true)', String(g.blindFire));
  ok(g.doubleReadMs === 40, `双读确认改 40ms 真的下发 40 (实际 ${g.doubleReadMs})`);
  ok(g.popupPollMs === 45, `弹窗探测间隔改 45ms 真的下发 45 (实际 ${g.popupPollMs})`);
  ok(g.watchPollMs === 350, `终态看护改 350ms 真的下发 350 (实际 ${g.watchPollMs})`);
  ok(g.popupDelayMs === 300, `弹窗起始延迟下发 300 (实际 ${g.popupDelayMs})`);
  ok(g.hammer === undefined && g.rehearsalMs === undefined, '旧字段 hammer / rehearsalMs 不再下发');

  /* ---- ⑤ 测试按钮走测试模式, 参数同一份 ---- */
  console.log('\n=== ⑤ 「🧪 测试」按钮 → dryRun=true ===');
  lastTask = null;
  await stubUsbChannel();
  await page.click('button[onclick="grabArm(true)"]');
  await page.waitForTimeout(400);
  const gt = lastTask?.grab || {};
  ok(lastTask && lastTask.mode === 'grab', '点「测试」也下发 grab 任务');
  ok(gt.dryRun === true, '「测试」下发 dryRun=true (到点直接出手, 不等页面变化)');
  ok(gt.blindFire === true && gt.doubleReadMs === 40, '测试与抢购用**同一份参数**');

  /* ---- ⑥ 全面自检 + 按通道给链路说明 ---- */
  console.log('\n=== ⑥ 「🩺 全面自检」+ 通道链路说明 ===');
  const runCheck = async (mode, shizuku) => {
    await page.unroute('**/api/channel').catch(() => {});
    await page.route('**/api/channel', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ channel: { mode, usb: mode === 'usb', wifi: mode === 'wifi', shizuku: shizuku || 'none', shizukuReady: shizuku === 'active' } }),
    }));
    await page.evaluate((m) => { chanState = { mode: m, usb: m === 'usb', wifi: m === 'wifi', shizuku: 'unknown' }; }, mode);
    await page.evaluate(() => grabFullCheck());
    await page.waitForTimeout(1400);
    return page.evaluate(() => ({
      boxShown: getComputedStyle(document.getElementById('grab-check-steps')).display !== 'none',
      lines: [...document.querySelectorAll('#grab-check-steps .cs')].map((d) => d.textContent.trim()),
      classes: [...document.querySelectorAll('#grab-check-steps .cs')].map((d) => d.className),
    }));
  };

  const usb = await runCheck('usb');
  ok(usb.boxShown, '自检结果区已展开');
  ok(usb.lines.length >= 8, `自检逐项渲染 (${usb.lines.length} 行)`);
  ok(usb.lines.some((t) => t.includes('中枢服务')), '含「中枢服务」项');
  ok(usb.lines.some((t) => t.includes('链接通道')), '含「链接通道」项');
  ok(usb.lines.some((t) => t.includes('手机脚本版本')), '含「手机脚本版本」项');
  ok(usb.lines.some((t) => t.includes('开抢时间')), '含「开抢时间」项');
  const usbChain = usb.lines.find((t) => t.includes('完整抢购链路')) || '';
  ok(/USB/.test(usbChain), 'USB 通道: 链路说明标题写明 USB');
  ok(/adb 注入/.test(usbChain), 'USB 通道: 首击说明为 adb 注入');
  ok(/就位/.test(usbChain) && /核对/.test(usbChain) && /连点链/.test(usbChain), '链路说明含 就位/核对/连点链 全流程');

  const wifi = await runCheck('wifi', 'none');
  const wifiChain = wifi.lines.find((t) => t.includes('完整抢购链路')) || '';
  ok(/Wi-Fi/.test(wifiChain), 'Wi-Fi 通道: 链路说明标题写明 Wi-Fi');
  ok(/Shizuku/.test(wifiChain), 'Wi-Fi 通道: 首击说明指向 Shizuku 本地注入 (两种通道文案不同)');
  // ★ 用户口径: WiFi 通道下必须确保 Shizuku 是打开的 —— 没开就是❌红项
  const szIdx = wifi.lines.findIndex((t) => t.includes('手机自主点击'));
  ok(szIdx >= 0, '自检列出了「手机自主点击 (Shizuku)」这一项');
  ok(/bad/.test(wifi.classes[szIdx] || ''), 'Wi-Fi + Shizuku 没开 → 判为❌红项 (WiFi 下这是硬条件)', wifi.classes[szIdx]);
  ok(/点不出去/.test(wifi.lines[szIdx] || ''), '红项里说清了后果并给了开法', (wifi.lines[szIdx] || '').slice(0, 60));

  const wifiOk = await runCheck('wifi', 'active');
  const szOkIdx = wifiOk.lines.findIndex((t) => t.includes('手机自主点击'));
  ok(/ok/.test(wifiOk.classes[szOkIdx] || ''), 'Wi-Fi + Shizuku 已开 → 判为✅通过', wifiOk.classes[szOkIdx]);

  const usbChk = await runCheck('usb', 'none');
  const szUsbIdx = usbChk.lines.findIndex((t) => t.includes('手机自主点击'));
  ok(/ok|warn/.test(usbChk.classes[szUsbIdx] || ''), 'USB 通道下 Shizuku 未开只算提醒 (不挡)', usbChk.classes[szUsbIdx]);

  /* ---- ⑦ 抖动上限开到几何极限 X≤100 / Y≤40, 且能真下发 ---- */
  console.log('\n=== ⑦ 抖动上限 X≤100 / Y≤40 (放开, 非 24) ===');
  await stubUsbChannel();
  const jitterDom = await page.evaluate(() => ({
    xMax: document.getElementById('grab-jitter-x').getAttribute('max'),
    yMax: document.getElementById('grab-jitter-y').getAttribute('max'),
  }));
  ok(jitterDom.xMax === '100', `抖动 X 输入框上限 = ${jitterDom.xMax}`);
  ok(jitterDom.yMax === '40', `抖动 Y 输入框上限 = ${jitterDom.yMax}`);
  await page.fill('#grab-jitter-x', '100');
  await page.fill('#grab-jitter-y', '40');
  lastTask = null;
  await page.click('button[onclick="grabArm(false)"]');
  await page.waitForTimeout(400);
  const gj = lastTask?.grab || {};
  ok(gj.jitterXPx === 100 && gj.jitterYPx === 40, `填 100/40 原样下发 (实际 ${gj.jitterXPx}/${gj.jitterYPx})`);

  /* ---- ⑧ 日志面板: 用户操作 + 参数快照都有人话记录 ---- */
  console.log('\n=== ⑧ 日志面板（任何操作都有记录）===');
  const logs = await page.evaluate(() => [...document.querySelectorAll('#logbox .loge')].map((d) => d.textContent.trim()));
  ok(logs.some((t) => t.includes('[操作]')), '日志里有「你点了…」这类操作记录');
  ok(logs.some((t) => t.includes('[参数]')), '日志里有本次下发参数的快照记录');
  ok(logs.some((t) => /盲点|双读确认|看护/.test(t)), '参数快照里含新增的 4 个节奏参数');
  const heroText = await page.textContent('.card.hero');
  ok(!/退无障碍手势/.test(heroText), '卡片里不再有「退无障碍手势」这种误导说法');

  /* ---- ⑨ 导出本次记录 (含人工操作) ---- */
  console.log('\n=== ⑨ 「📄 导出本次记录」===');
  ok(await page.$('button[onclick="exportRunRecord()"]') !== null, '「导出本次记录」按钮在位');
  await page.click('button[onclick="exportRunRecord()"]');
  await page.waitForTimeout(1200);
  const digestUi = await page.evaluate(() => document.body.textContent || '');
  ok(/抢购全程记录/.test(digestUi), '导出后弹出了可读记录');
  ok(/关键结论/.test(digestUi), '记录里有「关键结论」段');
  const exportLogs = await page.evaluate(() => [...document.querySelectorAll('#logbox .loge')].map((d) => d.textContent.trim()));
  ok(exportLogs.some((t) => t.includes('[记录]')), '日志里能看到"已导出 N 条记录"');
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { try { closeModal(); } catch (e) {} });

  /* ---- ⑩ 停止脚本两档状态: 「正在停止…」(指令已发, 等手机回报) → 「⏹ 已停止」(手机回报过) ---- */
  console.log('\n=== ⑩ 停止脚本后的两档状态 + 发不出去 ===');
  const stubDev = (fields, chFields) => page.route('**/api/devices', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      devices: [{ deviceId: 'verify-phone', model: 'VerifyPhone', isAdbOnly: false, usbAttached: true, screen: [1080, 2400], shizuku: 'active', agentVersion: '1.5.2', state: 'idle', ...fields }],
      adbDevicesCount: 1, httpAgentsCount: 1, hubAgentScriptSize: 0,
      channel: { mode: 'usb', usb: true, wifi: false, shizuku: 'none', shizukuReady: false, deviceId: 'verify-phone', ...chFields },
    }),
  }));

  // 第一档: 指令已下发, 手机还没回报 → 不谎报"在线", 也不谎报"已停止"
  await page.unroute('**/api/devices').catch(() => {});
  await stubDev({ isAlive: true, stopPushedAt: Date.now() }, {});
  await page.evaluate(() => refreshDevices(true));
  await page.waitForTimeout(400);
  const pendingUi = await page.evaluate(() => ({
    devArea: document.getElementById('dev-area').textContent,
    badge: document.getElementById('dev-badge').textContent,
  }));
  ok(/正在停止/.test(pendingUi.devArea), '指令已发/未回报 → 卡片显示「正在停止…」', pendingUi.devArea.slice(0, 40));

  // 第二档: 手机回报过「我要退了」→ 中枢已确认
  await page.unroute('**/api/devices').catch(() => {});
  await stubDev({ isAlive: false, stoppingAt: Date.now(), stopPushedAt: Date.now() }, {});
  await page.evaluate(() => refreshDevices(true));
  await page.waitForTimeout(400);
  const stoppedUi = await page.evaluate(() => ({
    devArea: document.getElementById('dev-area').textContent,
    badge: document.getElementById('dev-badge').textContent,
  }));
  ok(/已停止/.test(stoppedUi.devArea), '手机回报后 → 卡片显示「⏹ 已停止」', stoppedUi.devArea.slice(0, 40));
  ok(stoppedUi.badge === '已停止', `顶部徽标 = 已停止 (实际 ${stoppedUi.badge})`);

  lastTask = null;
  await page.click('button[onclick="grabArm(false)"]');
  await page.waitForTimeout(600);
  ok(lastTask === null, '脚本已停时点「抢购」→ **不发任务**(以前会排进队列没人执行)');
  const refusal = await page.evaluate(() => [...document.querySelectorAll('#logbox .loge')].map((d) => d.textContent.trim()).slice(-6));
  ok(refusal.some((t) => /没下发/.test(t)), '日志写清了"为什么没下发"', refusal.find(t => /没下发/.test(t)) || '');

  /* ---- ⑪ 更新脚本 (WiFi 路径) 不得误报"更新未完成" ---- */
  console.log('\n=== ⑪ 更新手机脚本 (Wi-Fi 路径) ===');
  await page.unroute('**/api/channel').catch(() => {});
  await page.route('**/api/channel', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ channel: { mode: 'wifi', usb: false, wifi: true, shizuku: 'active', shizukuReady: true, deviceId: 'verify-phone' } }),
  }));
  let updateCalled = 0;
  await page.unroute('**/api/device/update-script-lan').catch(() => {});
  await page.route('**/api/device/update-script-lan', (route) => {
    updateCalled++;
    // 中枢真实返回: {ok:true, pending:true, ...} —— 旧版**没有 ok 字段**, 控制台因此必然误报"更新未完成"
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, pending: true, status: 'pending', deviceId: 'verify-phone', localSize: 213712, note: '手机最多 4 秒内开始下载并覆盖本地脚本, 随后自动重启' }),
    });
  });
  await page.evaluate(() => { chanState = { mode: 'wifi', usb: false, wifi: true, shizuku: 'active' }; document.getElementById('toasts').innerHTML = ''; });
  page.evaluate(() => updateScript()).catch(() => {});
  await page.waitForTimeout(500);
  await page.click('#modal-footer button.btn.danger');       // 确认框的"开始更新"
  await page.waitForTimeout(900);
  const updToasts = await page.evaluate(() => document.getElementById('toasts').textContent);
  ok(updateCalled === 1, '确实调用了 Wi-Fi 更新端点');
  ok(!/更新未完成/.test(updToasts), '★ 不再误报「更新未完成」', updToasts.slice(0, 70));
  ok(/已下发更新指令/.test(updToasts), '明确告知"已下发, 手机自己去下载"');
  const updLogs = await page.evaluate(() => [...document.querySelectorAll('#logbox .loge')].map((d) => d.textContent.trim()).slice(-4));
  ok(updLogs.some((t) => t.includes('[更新]')), '日志里记了这次更新', updLogs.find(t => t.includes('[更新]')) || '');

  await page.locator('.card.hero').screenshot({ path: path.join(ROOT, 'verify', 'output', 'grab-console-v2.png') }).catch(() => {});
  console.log('\n截图: verify/output/grab-console-v2.png');
  if (pageErrors.length) { console.log('⚠️ 页面 JS 错误:', pageErrors.join(' | ')); ok(false, '页面无 JS 错误'); }
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
