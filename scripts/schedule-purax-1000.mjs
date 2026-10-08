#!/usr/bin/env node
/**
 * 定时任务脚本（2026-10-08 10:00 用）：采集 Pura X View → 挑待抢购 SKU 随机分槽 → 派发
 * =====================================================================
 * 步骤：
 *   ① 采集一次「HUAWEI Pura X View」（走桥接的采集接口，只采这一个商品）
 *   ② 从**采集结果**里挑「待抢购」状态的 SKU（有开售时间、当前不可买），
 *      随机洗牌取 2 个（不足 2 个时兜底用全部规格）
 *   ③ 把商品的勾选规格同步写成这 2 个（不然派发闸门会拦）
 *   ④ 新建 acc1 / acc2 两个槽位绑定这 2 个规格（沿用端口 9401/9402，
 *      复用已有窗口和登录——这正是保活验证的意义）
 *   ⑤ 派发（驱动值守到官方开售时刻自动抢，Pura X View 今天 10:08 开售）
 *   ⑥ 等 60 秒收早期日志，重点看两个窗口的登录态与「会话保活：已续命」
 *      （值守循环先睡 30 秒才做第一次保活探测，acc2 又比 acc1 晚启动十来秒，
 *        40 秒会刚好错过 acc2 的「已续命」行，造成误报）
 *
 * 用法：
 *   node scripts/schedule-purax-1000.mjs --plan   # 演练：只采集+打印分配计划，不改任何东西
 *   node scripts/schedule-purax-1000.mjs          # 实战：全部执行
 * =====================================================================
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BRIDGE = 'http://127.0.0.1:3100';
const PRODUCT_ID = 'HUAWEI Pura X View';
const PRD_ID = '10086683896486';
const SLOT_PORTS = [9401, 9402]; // acc1 / acc2：沿用旧端口，复用现有窗口与登录

const PLAN = process.argv.some((a) => a === '--plan');
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ error: 'HTTP ' + r.status }));
}

/* ①② 采集 + 挑待抢购 SKU */
async function plan() {
  log(`① 采集「${PRODUCT_ID}」…`);
  const crawl = await postJson(`${BRIDGE}/api/crawler/run`, { only: PRODUCT_ID });
  if (!crawl.ok) throw new Error('采集失败：' + (crawl.error || JSON.stringify(crawl).slice(0, 300)));
  log(`采集完成：${JSON.stringify(crawl.summary?.counts || {})}`);

  const cat = await (await fetch(`${BRIDGE}/api/crawler/catalog?platform=huawei`)).json();
  const prod = (cat.products || []).find((p) => String(p.prdId) === PRD_ID);
  if (!prod) throw new Error(`采集目录里找不到 prdId=${PRD_ID}`);
  const all = (prod.skus || []).map((s) => ({
    code: String(s.skuId ?? s.sbomCode),
    label: s.label || '',
    buyable: s.buyable === true,
    saleStartAt: s.saleStartAt ?? (s.rushBuy && s.rushBuy.startTime) ?? null,
  }));
  let rush = all.filter((s) => s.saleStartAt && !s.buyable);
  if (rush.length < 2) {
    log(`待抢购规格只有 ${rush.length} 个，兜底加入全部规格挑选。`);
    rush = all;
  }
  if (rush.length < 2) throw new Error('可用规格不足 2 个，没法分两个槽位');
  // Fisher-Yates 洗牌后取前 2
  for (let i = rush.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rush[i], rush[j]] = [rush[j], rush[i]];
  }
  const picked = rush.slice(0, 2);
  log(`② 随机选中 2 个待抢购规格：${picked.map((s) => `${s.code}（${s.label}，${new Date(s.saleStartAt).toLocaleString('zh-CN', { hour12: false })} 开售）`).join('；')}`);
  return picked;
}

/* ③④⑤⑥ 改勾选 → 建槽位 → 派发 → 收日志 */
async function run(picked) {
  // 若有旧驱动还在跑：槽位是它启动时读一次的，不会热加载——不停掉就会带着
  // 旧绑定继续抢错东西。先停（只停驱动进程，专用窗口和登录都保留），再派发。
  try {
    const st = await (await fetch(`${BRIDGE}/api/dispatch/status?platform=huawei`)).json();
    if (st.running) {
      log('检测到已有驱动在运行（旧槽位绑定不会热加载）——先停止再派发，窗口与登录不受影响。');
      await postJson(`${BRIDGE}/api/dispatch/stop`, { platform: 'huawei' });
      await sleep(2000);
    }
  } catch { /* 状态查不到就按常规走，派发接口自己会拦「已在运行」 */ }

  const cfg = await (await fetch(`${BRIDGE}/api/config/huawei`)).json();
  const cfgProd = (cfg.products || []).find((p) => (String(p.url || '').match(/prdId=(\d+)/) || [])[1] === PRD_ID);
  if (!cfgProd) throw new Error(`配置里找不到 prdId=${PRD_ID} 的商品`);

  const sel = await postJson(`${BRIDGE}/api/config/huawei/sku-select`, {
    productUrl: cfgProd.url,
    skuIds: picked.map((s) => s.code),
  });
  if (!sel.ok) throw new Error('写商品勾选失败：' + (sel.error || JSON.stringify(sel).slice(0, 300)));
  log('③ 商品勾选已同步为选中的 2 个规格。');

  const slots = picked.map((s, i) => ({
    id: `acc${i + 1}`,
    prdId: PRD_ID,
    sbomCode: s.code,
    port: SLOT_PORTS[i],
    scanSboms: picked.map((x) => x.code), // 回流切换清单 = 这 2 个规格
  }));
  const w = await postJson(`${BRIDGE}/api/dispatch/slots`, { platform: 'huawei', slots });
  if (!w.ok) throw new Error('写槽位失败：' + (w.error || JSON.stringify(w).slice(0, 300)));
  log(`④ 槽位已建：${slots.map((s) => `${s.id}→${s.sbomCode}（端口 ${s.port}）`).join('，')}`);

  const l = await postJson(`${BRIDGE}/api/dispatch/launch`, { platform: 'huawei' });
  if (!l.ok && !/已在运行/.test(l.error || '')) {
    throw new Error('派发失败：' + (l.error || JSON.stringify(l).slice(0, 300)));
  }
  log(l.ok
    ? `⑤ 已派发（pid ${l.pid}）。驱动值守到官方开售时刻自动抢。`
    : '⑤ ⚠️ 驱动已在运行、本次没换成新槽位——它还带着旧绑定，若刚改过槽位请先停驱动再手动派发一次。');

  await sleep(60000);
  try {
    const st = await (await fetch(`${BRIDGE}/api/dispatch/status?platform=huawei`)).json();
    log('===== 派发后早期日志（最后 25 行）=====');
    (st.log || []).slice(-25).forEach((x) => console.log('  ' + x));
  } catch (e) {
    log(`读驱动日志失败（${e.message}）——派发本身已成功，可去控制台「开抢」页看日志。`);
  }
}

/* 主流程（Windows 上带未关 socket 直接 exit 会触发 libuv 断言，歇 600ms 再退） */
try {
  const picked = await plan();
  if (PLAN) {
    log('--plan 演练模式：到此为止，不改勾选、不建槽位、不派发、不挂 10:16 复盘定时器。');
  } else {
    await run(picked);
    spawnDeferredCollector();
  }
} catch (e) {
  console.error(`[失败] ${e.message}`);
  // 实战半途失败也挂复盘收集器：取证目录里已有的部分照样能出报告；
  // 演练（--plan）失败则什么都不留
  if (!PLAN) spawnDeferredCollector();
  await sleep(600);
  process.exit(1);
}
await sleep(600);
process.exit(0);

/* 10:16 自动收集复盘报告（脱管后台定时器，本脚本退出后照跑） */
function spawnDeferredCollector() {
  const ROOT = fileURLToPath(new URL('..', import.meta.url)); // 绝对路径：不挑运行时 cwd
  try {
    const c = spawn(process.execPath, [fileURLToPath(new URL('./deferred-timers.mjs', import.meta.url)), '10:16', 'grab-probe/collect-rush-evidence.mjs'], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    c.unref();
    log('已挂 10:16 复盘报告收集器（后台定时，报告写到 data/grab/evidence/rush-*/复盘报告.md）。');
  } catch { /* 挂不上就算了 */ }
}
