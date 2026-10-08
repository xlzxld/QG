#!/usr/bin/env node
/**
 * 跨商品预热验证（2026-10-08）：先用别的商品开一次确认页，目标商品的确认页会不会变热？
 * =====================================================================
 * 回答任务 3：「预先打开其他商品的提交订单页面，使目标商品的提交订单页面进入热加载」
 *
 * 实验步骤（全程不提交订单，确认页只当草稿开，开完即关）：
 *   0. 清浏览器缓存（制造冷启动条件）
 *   1. 打开"别的商品"的确认页 → 测提交按钮挂载耗时（别的商品自己的冷加载）
 *   2. 关掉，立刻打开"目标商品"的确认页 → 测挂载耗时
 *      ★ 如果这一步明显变快（≈0.5s 级），跨商品预热成立
 *   3. 收摊：关确认页，窗口导航回目标商品原规格
 *
 * 用法：node grab-probe/verify-warm-cross.mjs [--port=9401]
 * =====================================================================
 */
import { CDP, sleep, listTabs, trustedClick } from '../grab/cdp-core.mjs';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PORT = Number(args.port) || 9401;
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

/* 槽位与商品列表（找"别的商品"用） */
const slots = JSON.parse(readFileSync(new URL('../data/grab/rush-slots.huawei.json', import.meta.url), 'utf8')).slots;
const slot = slots.find((s) => Number(s.port) === PORT) || slots[0];
const cfg = JSON.parse(readFileSync(new URL('../data/grab/huawei.config.json', import.meta.url), 'utf8'));
const pidOf = (p) => (String(p.url || '').match(/prdId=(\d+)/) || [])[1] || '';
const others = (cfg.products || []).filter((p) => p.enabled !== false && pidOf(p) !== String(slot.prdId));
const TARGET_URL = `https://item.vmall.com/product/comdetail/index.html?prdId=${slot.prdId}&sbomCode=${slot.sbomCode}`;
log(`目标：${slot.id} prdId=${slot.prdId} sbomCode=${slot.sbomCode}`);
log(`候选预热商品：${others.map((p) => `${p.id}(${pidOf(p)})`).join('、')}`);

const OUTER = `(() => {
    const root = document.getElementById('prd-botnav-rightbtn');
    if (!root) return null;
    const host = root.querySelector('div[tabindex]') || root.querySelector('[tabindex]');
    if (!host) return null;
    const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
    let node = key ? host[key] : null, hops = 0;
    while (node && hops < 25) {
      const p = node.memoizedProps;
      if (p && typeof p.onPress === 'function') return p.onPress;
      node = node.return; hops++;
    }
    return null;
  })()`;

const MOUNT_CHECK = `(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    for (const el of document.querySelectorAll('a,button,div,span')) {
      const t = clean(el.innerText);
      if (!t || t.length > 6 || !t.includes('提交订单')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  })()`;

async function pageReady(cdp) {
  for (let i = 0; i < 90; i++) {
    const st = await cdp.eval('({ ready: document.readyState, has: !!(document.body && document.body.innerText) })').catch(() => null);
    if (st && st.ready === 'complete' && st.has) break;
    await sleep(500);
  }
  await sleep(2500);
}

/** 在当前商品页开确认页（草稿），测按钮挂载耗时；返回耗时 ms 或 null（没开出来） */
async function openConfirmAndMeasure(cdp, label) {
  const tabs0 = new Set((await listTabs(PORT)).map((t) => t.id));
  const btn = await cdp.eval(`(() => { const a = document.getElementById('prd-botnav-rightbtn'); return a ? (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20) : null; })()`);
  if (!btn || !/立即购买|立即申购|马上抢|立即抢购/.test(btn)) {
    log(`  [${label}] 按钮不可买（${btn || '无锚点'}），跳过这个商品`);
    return null;
  }
  const r1 = await cdp.send('Runtime.evaluate', { expression: OUTER, returnByValue: false });
  const fnId = r1 && r1.result && r1.result.objectId;
  let fired = false;
  if (fnId) {
    const fire = await cdp.send('Runtime.callFunctionOn', {
      objectId: fnId,
      functionDeclaration: 'function(){ try { this(); return "FIRED"; } catch (e) { return "ERR:" + e.message; } }',
      returnByValue: true, userGesture: true,
    });
    fired = fire.result && fire.result.value === 'FIRED';
  }
  if (!fired) {
    const pos = await cdp.eval(`(() => { const a = document.getElementById('prd-botnav-rightbtn'); if (!a) return null; const r = a.getBoundingClientRect(); if (r.width <= 0) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!pos) { log(`  [${label}] 触发失败（无入口无坐标）`); return null; }
    await trustedClick(cdp, pos.x, pos.y);
  }
  const tFire = Date.now();
  let confirmTab = null;
  let tAppear = 0;
  for (let i = 0; i < 60 && !confirmTab; i++) {
    await sleep(200);
    const ts = await listTabs(PORT);
    confirmTab = ts.find((t) => /orderConfirm/.test(t.url || '') && !tabs0.has(t.id)) || null;
    if (confirmTab) tAppear = Date.now();
  }
  if (!confirmTab) { log(`  [${label}] 12 秒没等到确认页`); return null; }
  const cdp2 = new CDP(confirmTab.webSocketDebuggerUrl);
  await cdp2.connect();
  await cdp2.send('Runtime.enable');
  let mounted = 0;
  for (let i = 0; i < 100 && !mounted; i++) {
    await sleep(200);
    try { if (await cdp2.eval(MOUNT_CHECK)) mounted = Date.now(); } catch { /* 加载中 */ }
  }
  cdp2.ws.close();
  // 关掉这个草稿确认页
  await fetch(`http://127.0.0.1:${PORT}/json/close/${confirmTab.id}`).catch(() => {});
  if (!mounted) { log(`  [${label}] 20 秒内提交按钮没挂载`); return null; }
  const totalFromFire = mounted - tFire;
  log(`  [${label}] ✔ 触发→确认页出现 ${tAppear - tFire}ms；确认页出现→提交按钮可见 ${mounted - tAppear}ms（合计 ${totalFromFire}ms）`);
  return { fromFire: totalFromFire, mount: mounted - tAppear };
}

/* ── 主流程 ── */
const tabs = await listTabs(PORT);
const tab = tabs.find((t) => /comdetail/.test(t.url || ''));
if (!tab) { log('窗口里没有商品页标签'); process.exit(1); }
const cdp = new CDP(tab.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

try {
  // 0. 清缓存 + 冷却（磁盘缓存的内存索引也要卸掉，等 3 秒）
  log('步骤0：清浏览器缓存（制造冷启动）…');
  try {
    await cdp.send('Network.enable');
    await cdp.send('Network.clearBrowserCache');
    log('  缓存已清');
  } catch (e) { log(`  清缓存失败：${e.message}（继续，结果偏热）`); }
  await sleep(3000);

  // 1. 找一个可买的"别的商品"，开它的确认页（它的冷加载）
  let warmResult = null;
  let warmProd = null;
  for (const p of others) {
    const url = `https://item.vmall.com/product/comdetail/index.html?prdId=${pidOf(p)}&sbomCode=${(p.skuIds || [])[0] || (String(p.url).match(/sbomCode=(\d+)/) || [])[1] || ''}`;
    log(`步骤1：去别的商品「${p.id}」开确认页（预热）…`);
    await cdp.send('Page.navigate', { url });
    await pageReady(cdp);
    warmResult = await openConfirmAndMeasure(cdp, `预热商品·${p.id}`);
    if (warmResult) { warmProd = p; break; }
  }
  if (!warmResult) log('⚠ 没有一个别的商品能开确认页（都不可买？）——只能测目标页自身冷加载');

  await sleep(1000);

  // 2. 目标商品确认页（关键测量：被别的商品预热后有多快）
  log(`步骤2：回目标商品开确认页（测被预热后的加载）…`);
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await pageReady(cdp);
  const targetResult = await openConfirmAndMeasure(cdp, `目标商品·${slot.id}`);

  // 3. 结论
  console.log('\n===== 结论 =====');
  console.log(`  预热商品（${warmProd ? warmProd.id : '无'}）冷加载：${warmResult ? `${warmResult.fromFire}ms（按钮挂载 ${warmResult.mount}ms）` : '未测成'}`);
  console.log(`  目标商品（被预热后）    ：${targetResult ? `${targetResult.fromFire}ms（按钮挂载 ${targetResult.mount}ms）` : '未测成'}`);
  if (targetResult && targetResult.mount < 1500) {
    console.log('  ✅ 跨商品预热成立：目标商品确认页按钮挂载进入热加载量级（<1.5s）');
  } else if (targetResult) {
    console.log('  ⚠ 目标商品挂载仍慢（≥1.5s）——跨商品预热不成立或缓存被清后未完全暖');
  }
} finally {
  // 收摊：关所有确认页草稿，回目标商品原规格
  try {
    for (const t of await listTabs(PORT)) {
      if (/orderConfirm/.test(t.url || '')) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
    }
    await cdp.send('Page.navigate', { url: TARGET_URL }).catch(() => {});
    log('已收摊：确认页已关，窗口已回目标商品原规格。');
  } catch { /* ignore */ }
  process.exit(0);
}
