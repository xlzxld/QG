#!/usr/bin/env node
/**
 * 三方案对照实验（2026-10-09 实战用）：一次派发同时跑三种打法
 * =====================================================================
 *   A（acc1）静等按钮：triggerMode=click + 关拦截 —— 不主动轮询内部入口、不做响应
 *      改写，等按钮自然亮。注意：命中按钮后的出手链仍是驱动统一的「内部入口优先、
 *      真点击兜底」——「纯真点击」在当前页面上单独打不动（10-08 实测）。
 *   B（acc2）大提前量：内部触发 + leadMs=3000 + T0 前规格快切（t0SpecSwitch）。
 *      按钮在 T0-3s 就解锁（R1 改写）；快切循环从 T0-1.2s 开始，按钮一亮第一圈即
 *      出手（实际最早出手 ≈ T0-1s 上下，取决于切规格耗时）；开出的确认页会立即
 *      走提交流程（不等 T0）。
 *   C（acc3）现行对照：内部触发 + leadMs=300（沿用全局现值），不切规格、静等按钮
 *      —— 和 10-08 白天完全一样。
 * 流程：采集目标商品 → 挑 3 个「待抢购」规格（有开售时间 + 未开售 + 场次未过；
 *       不足 3 个默认中止，要用现货凑数须显式 --fill-stock）→ 勾选同步 → 写三个
 *       槽位（acc3 是新窗口端口 9403，需要登录一次！）→ 停掉旧驱动 → 派发 →
 *       收早期日志 → 挂复盘收集器（收集时刻 = 最早开售时刻 + 8 分钟）。
 * 全程黑匣子取证照常。
 * 用法：node platforms/huawei/rush-experiment-3plans.mjs --plan    # 演练：只采集+打印计划，不改配置
 *       node platforms/huawei/rush-experiment-3plans.mjs           # 实战
 *       node platforms/huawei/rush-experiment-3plans.mjs --force   # 重跑（允许覆盖已布置的实验）
 * =====================================================================
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BRIDGE = 'http://127.0.0.1:3100';
const PRODUCT_ID = 'HUAWEI Pura X View'; // 控制台商品 id（采集闸门按它精确匹配）
const PRD_ID = '10086683896486';
const PLAN = process.argv.some((a) => a === '--plan');
const FORCE = process.argv.some((a) => a === '--force');
const FILL_STOCK = process.argv.some((a) => a === '--fill-stock');
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postJson = async (u, b) => {
  try { return await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(); }
  catch { return { error: '桥接没有响应（服务可能停了）' }; }
};
const getJson = async (u) => (await fetch(u)).json();

/* ⓪ 桥接探活：服务没起就给句人话，别让脚本崩在半路 */
const alive = await fetch(`${BRIDGE}/api/dispatch/slots?platform=huawei`).then((r) => r.ok).catch(() => false);
if (!alive) {
  console.error('桥接服务没有响应（127.0.0.1:3100）。请先双击「服务启停.bat」→ 按 1 把服务跑起来，再执行本脚本。');
  process.exit(1);
}

log(`① 采集「${PRODUCT_ID}」…`);
const crawl = await postJson(`${BRIDGE}/api/crawler/run`, { platform: 'huawei', only: PRODUCT_ID });
if (!crawl.ok) { console.error('采集失败：', crawl.error || crawl); process.exit(1); }
log(`采集完成：${JSON.stringify(crawl.summary?.counts || {})}`);
const cat = await getJson(`${BRIDGE}/api/crawler/catalog?platform=huawei`);
if (cat.error) { console.error('读采集目录失败：', cat.error); process.exit(1); }
const all = ((cat.products || []).find((p) => String(p.prdId) === PRD_ID)?.skus || [])
  .map((s) => ({ code: String(s.skuId ?? s.sbomCode), label: s.label || '', buyable: s.buyable === true, saleStartAt: s.saleStartAt ?? (s.rushBuy && s.rushBuy.startTime) ?? null }));
/* 「待抢购」= 有开售时间 + 未开售 + 场次还没过（防"已过期僵尸"被当成目标） */
let rush = all.filter((s) => s.saleStartAt && !s.buyable && new Date(s.saleStartAt).getTime() > Date.now());
if (rush.length < 3) {
  /* 兜底：新场次还没放出来时，用"锁定中（不可买）"的规格顶上——按钮锁着不会误出手，
     和待抢购同样安全；现货规格绝不自动凑数（按钮已亮会立刻真实下单）。 */
  const locked = all.filter((s) => !s.buyable && !rush.includes(s));
  if (locked.length) {
    log(`未来场次的待抢购规格只有 ${rush.length} 个，补入 ${locked.length} 个"锁定中"规格（按钮未解锁，安全）。`);
    rush = rush.concat(locked);
  }
}
if (rush.length < 3) {
  if (!FILL_STOCK) {
    console.error(`待抢购规格不足 3 个（当前 ${rush.length} 个）——中止，不拿现货凑数。`);
    if (rush.length) console.error(`  可用待抢购：${rush.map((s) => `${s.code}（${s.label}，${s.saleStartAt} 开售）`).join('；')}`);
    console.error(`  全部规格现状：${all.map((s) => `${s.code}${s.buyable ? '·现货' : s.saleStartAt ? '·' + String(s.saleStartAt).slice(5, 16) + '开售' : '·无场次'}`).join('；')}`);
    console.error('  常见原因：明天的场次还没放出 / 今天场次已过 / 商品状态变了。');
    console.error('  如果确认要用现货规格凑数（实验性质会变），加 --fill-stock 重跑。');
    process.exit(1);
  }
  log(`⚠️ 待抢购只有 ${rush.length} 个，--fill-stock 生效：退回全部规格挑选（含现货，实验性质会变！）`);
  rush = all;
}
if (rush.length < 3) { console.error('可用规格不足 3 个（catalog 里这个商品没采到 SKU？）'); process.exit(1); }
for (let i = rush.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rush[i], rush[j]] = [rush[j], rush[i]]; }
const picked = rush.slice(0, 3);
log(`② 随机选中 3 个待抢购规格：${picked.map((s) => s.code + '（' + s.label + '）').join('；')}`);
const cfg = await getJson(`${BRIDGE}/api/config/huawei`);
const cfgProd = (cfg.products || []).find((p) => (String(p.url || '').match(/prdId=(\d+)/) || [])[1] === PRD_ID);
if (!cfgProd) { console.error(`配置里找不到 prdId=${PRD_ID} 的商品——先去控制台「商品与 SKU」页确认它在列表里。`); process.exit(1); }
const slots = [
  { id: 'acc1', prdId: PRD_ID, sbomCode: picked[0].code, port: 9401, scanSboms: picked.map((x) => x.code), triggerMode: 'click', intercept: { enabled: false }, forceClick: true },   // A 纯点击（真点击→排队链路）
  { id: 'acc2', prdId: PRD_ID, sbomCode: picked[1].code, port: 9402, scanSboms: picked.map((x) => x.code), intercept: { leadMs: 3000 }, t0SpecSwitch: true },     // B 大提前量+快切
  { id: 'acc3', prdId: PRD_ID, sbomCode: picked[2].code, port: 9403, scanSboms: picked.map((x) => x.code) },                                                     // C 现行对照
];
log(`③ 方案分配：A=acc1 纯点击(${picked[0].code})；B=acc2 大提前量(${picked[1].code})；C=acc3 现行对照(${picked[2].code})`);
if (PLAN) { log('--plan 演练：未写勾选、未写槽位、未派发、未挂收集器。（注意：本次已真实采集一次，采集是只读动作。）'); await sleep(1500); process.exit(0); }

/* 重跑保护：槽位里已带实验字段 = 之前布置过 → 需要 --force 才允许覆盖 */
try {
  const cur = await getJson(`${BRIDGE}/api/dispatch/slots?platform=huawei`);
  const armed = (cur.slots || []).some((s) => s && (s.t0SpecSwitch === true || s.triggerMode || s.intercept));
  if (armed && !FORCE) {
    console.error('检测到槽位里已存在「三方案实验」配置——说明之前已经布置过一轮。');
    console.error('直接重跑会重新随机规格、触发换绑确认与重置、覆盖上一轮布置。');
    console.error('确认要重跑请加 --force，例如：node platforms/huawei/rush-experiment-3plans.mjs --force');
    process.exit(1);
  }
} catch { /* 读不到槽位就当没布置过，继续 */ }

/* 旧驱动还在跑就先停：驱动只在启动时读一次槽位、不热加载——不停会把新配置白写 */
const st0 = await getJson(`${BRIDGE}/api/dispatch/status?platform=huawei`).catch(() => null);
if (st0 && st0.running) {
  log('检测到已有驱动在运行（不会热加载新槽位配置）——先停掉，窗口与登录都保留。');
  await postJson(`${BRIDGE}/api/dispatch/stop`, { platform: 'huawei' });
  await sleep(2500);
}

const sel = await postJson(`${BRIDGE}/api/config/huawei/sku-select`, { productUrl: cfgProd.url, skuIds: picked.map((s) => s.code) });
if (!sel.ok) { console.error('写勾选失败：', sel.error); process.exit(1); }
const w = await postJson(`${BRIDGE}/api/dispatch/slots`, { platform: 'huawei', slots });
if (!w.ok) { console.error('写槽位失败：', w.error); process.exit(1); }
if ((w.rebinds || []).length) {
  log('槽位换绑（旧绑定 → 新绑定；配不上的体检报告已作废）：');
  for (const r of w.rebinds) log(`  ${r.id}：${r.from ? r.from.sbomCode : '(新槽位)'} → ${r.to.sbomCode}${(r.invalidated || []).length ? '（体检报告已作废，建议重新体检）' : ''}`);
}
log('④ 勾选与槽位已保存（acc3 是新窗口，第一次跑会提示登录——开售前务必登好）。');
const l = await postJson(`${BRIDGE}/api/dispatch/launch`, { platform: 'huawei' });
if (!l.ok) {
  if (/已在运行/.test(l.error || '')) {
    log('⚠️ 派发接口说驱动已在运行——新槽位配置可能没被加载。建议停掉驱动后重跑本脚本（或去控制台手动重派发）。');
  } else {
    console.error('派发失败：', l.error);
    process.exit(1);
  }
} else {
  log(`⑤ 已派发（pid ${l.pid}）。`);
}

/* 复盘收集器：脱管后台定时，收集时刻 = 最早开售时刻 + 8 分钟（与 10:16 = 10:08+8min 同口径） */
spawnDeferredCollector(picked);
await sleep(45000);
try {
  const st = await getJson(`${BRIDGE}/api/dispatch/status?platform=huawei`);
  log('===== 派发后早期日志（最后 25 行）=====');
  (st.log || []).slice(-25).forEach((x) => console.log('  ' + x));
} catch (e) {
  log(`读驱动日志失败（${e.message}）——派发本身已成功，去控制台「开抢」页看日志。`);
}
log('收尾提醒：1) 现在就去端口 9403 的窗口把 acc3 登录掉；2) 登录预检命令：node tools/check-slot-logins.mjs');
await sleep(1500);
process.exit(0);

/* 10:16 一类的脱管收集器：睡到「最早开售 + 8 分钟」，跑复盘报告收集（本脚本退出后照跑） */
function spawnDeferredCollector(pickedList) {
  const future = pickedList
    .map((s) => new Date(s.saleStartAt).getTime())
    .filter((t) => Number.isFinite(t) && t > Date.now())
    .sort((a, b) => a - b);
  if (!future.length) {
    log('⚠️ 规格里没有"未来的开售时刻"，无法推导复盘收集时刻，本次不挂收集器。想手动收集随时跑：node verify/collect-rush-evidence.mjs');
    return;
  }
  const at = new Date(future[0] + 8 * 60 * 1000);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  try {
    const c = spawn(process.execPath, [fileURLToPath(new URL('../../core/deferred-timers.mjs', import.meta.url)), hhmm, 'verify/collect-rush-evidence.mjs'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    c.on('error', (e) => log(`⚠️ 复盘收集器挂载失败：${e.message}`));
    c.unref();
    log(`已挂 ${hhmm} 复盘报告收集器（脱管后台定时，报告写到 data/grab/evidence/rush-*/复盘报告.md）。`);
  } catch (e) {
    log(`⚠️ 复盘收集器挂载失败：${e.message}`);
  }
}
