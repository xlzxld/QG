#!/usr/bin/env node
/**
 * 手动/定时派发华为驱动（调桥接 /api/dispatch/launch）
 * =====================================================================
 * 用法：
 *   node tools/dispatch-huawei.mjs --plan   只做检查（桥接可达 / 槽位闸门 / 驱动状态），不派发
 *   node tools/dispatch-huawei.mjs          真正派发（幂等：已在运行 = 成功，不重复派）
 *
 * 被「今早抢购-手动武装.bat」的脱管定时器调用；也可手动运行。
 * 记录：data/grab/auto-dispatch-log.md；派发结果同时回传控制台「抢购结果」页。
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BRIDGE = 'http://127.0.0.1:3100';
const PLAN = process.argv.includes('--plan');
const LOGF = path.join(ROOT, 'data', 'grab', 'auto-dispatch-log.md');

const now = () => new Date().toLocaleString('zh-CN', { hour12: false });
const appendLog = (line) => { try { fs.appendFileSync(LOGF, line + '\n'); } catch { /* 忽略 */ } };
const jfetch = async (url, opts) => {
  const r = await fetch(url, opts);
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json: j };
};

// ① 桥接可达性 + 驱动状态
let st;
try {
  st = (await jfetch(`${BRIDGE}/api/dispatch/status?platform=huawei`)).json || {};
} catch (e) {
  console.log(`[失败] 连不上桥接服务（${BRIDGE}）：${e.message}`);
  appendLog(`- ${now()} 派发失败：桥接连不上（${e.message}）`);
  process.exit(1);
}
console.log(`桥接可达 ✓ 驱动当前${st.running ? '在运行' : '未运行'}${st.running ? `（自 ${st.startedAt || '?'}）` : ''}`);

// ② 槽位闸门预演（与桥接派发前同一口径）
try {
  const sf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'grab', 'rush-slots.huawei.json'), 'utf8'));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'grab', 'huawei.config.json'), 'utf8'));
  const pidOf = (p) => String(p.prdId ?? (p.url || '').match(/prdId=(\d+)/)?.[1] ?? '');
  for (const s of (sf.slots || [])) {
    const p = (cfg.products || []).find((x) => pidOf(x) === String(s.prdId));
    const want = p && Array.isArray(p.skuIds) ? p.skuIds.map(String).filter(Boolean) : [];
    const ok = !!p && p.enabled !== false && (!want.length || want.includes(String(s.sbomCode)));
    console.log(`  槽位 ${s.id}（端口 ${s.port}）→ ${ok ? '✓ 在商品列表内' : '✗ 不在商品列表/未勾选（会被拦截）'}`);
  }
} catch (e) {
  console.log(`  （槽位预演跳过：${e.message}）`);
}

if (PLAN) { console.log('--plan 模式：不做任何派发。'); process.exit(0); }

// ③ 已在运行 → 幂等成功
if (st.running) {
  console.log('驱动已在运行——按幂等处理为成功，不重复派发。');
  appendLog(`- ${now()} 检查：驱动已在运行，跳过派发（视为成功）`);
  process.exit(0);
}

// ④ 派发
const r = await jfetch(`${BRIDGE}/api/dispatch/launch`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ platform: 'huawei' }),
});
const j = r.json || {};
if (r.status === 200 && j.ok) {
  console.log(`✓ 已派发（pid ${j.pid}）。驱动值守到开售时刻自动抢。`);
  appendLog(`- ${now()} 已派发，pid ${j.pid}（startedAt ${j.startedAt}）`);
  try {
    await fetch(`${BRIDGE}/api/results/huawei`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: new Date().toISOString(), profileId: 'auto-dispatch', outcome: 'DISPATCHED', resultCode: 'DISPATCHED', message: `自动派发完成（pid ${j.pid}）` }),
    });
  } catch { /* 忽略 */ }
  process.exit(0);
}
if (r.status === 409 || /已在运行/.test(String(j.error || ''))) {
  console.log('桥接提示驱动已在运行——按成功处理。');
  appendLog(`- ${now()} 派发返回 409（已在运行），视为成功`);
  process.exit(0);
}
console.log(`✗ 派发失败：HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
appendLog(`- ${now()} 派发失败：HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
try {
  await fetch(`${BRIDGE}/api/results/huawei`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ at: new Date().toISOString(), profileId: 'auto-dispatch', outcome: 'FAILED', resultCode: 'DISPATCH_FAILED', message: `自动派发失败：HTTP ${r.status}` }),
  });
} catch { /* 忽略 */ }
process.exit(1);
