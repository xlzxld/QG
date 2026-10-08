#!/usr/bin/env node
/**
 * 确认页「提交订单」内部入口 · 真机验证（2026-10-08）
 * =====================================================================
 * 回答一个问题：驱动的"提交走捷径（内部 handleOrderSubmit）"在真实确认页上
 * 到底能不能找到入口？——只查找、只报告，绝不调用任何提交函数、绝不产生订单。
 *
 * 全流程（安全边界）：
 *   1. 连专用窗口（默认 9401）→ 检查登录态 + 商品页「立即购买」可点
 *   2. 用与驱动同一套内部手势触发「立即购买」→ 打开确认订单页（草稿）
 *   3. 轮询测出「提交订单」按钮的挂载耗时（tab 出现 → 按钮可见）
 *   4. 用与 cdp-rush.mjs 一字不差的查找逻辑走 fiber 链（找到入口只报告，
 *      **不调用**）——即"如果是驱动跑到这里，会不会命中"
 *   5. 找不到 → 输出解剖信息（候选元素 + fiber 每层的函数型 props）供修
 *   6. 关闭确认页标签（草稿作废）——全程不含任何提交动作
 *
 * 用法：node grab-probe/verify-submit-entry.mjs [--port=9401]
 * =====================================================================
 */

import { CDP, sleep, trustedClick } from '../grab/cdp-core.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PORT = Number(args.port) || 9401;
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

/* 与 cdp-rush.mjs submitOrder 的 INTERNAL_EXPR 一字不差，唯一区别：
   命中后不调用 p.handleOrderSubmit()，只报告（含函数源码头）。 */
const FIND_ONLY_EXPR = `(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const textOf = (el) => clean(el && (el.innerText || el.textContent || ''));
    let hit = null;
    for (const el of document.querySelectorAll('a,button,div,span')) {
      const t = textOf(el);
      if (!t || t.length > 6 || !t.includes('提交订单')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      hit = el; break;
    }
    if (!hit) return { s: 'NO_BUTTON' };
    const key = Object.keys(hit).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
    let node = key ? hit[key] : null, hops = 0;
    while (node && hops < 30) {
      const p = node.memoizedProps || {};
      if (p && typeof p.handleOrderSubmit === 'function') {
        let src = ''; try { src = String(p.handleOrderSubmit).slice(0, 300); } catch (e) { src = '(读不到源码)'; }
        return { s: 'WOULD_FIRE', hops, tag: hit.tagName, btnText: clean(hit.innerText), src };
      }
      node = node.return; hops++;
    }
    return { s: 'NO_ENTRY', sawFiberKey: !!key, hops };
  })()`;

/* 解剖版：放宽文字条件（含"提交"即可），dump 候选元素 + fiber 每层的函数 props */
const ANATOMY_EXPR = `(() => {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const cand = [];
    for (const el of document.querySelectorAll('a,button,div,span')) {
      const t = clean(el.innerText);
      if (!t || t.length > 14 || !t.includes('提交')) continue;
      const r = el.getBoundingClientRect();
      cand.push({ tag: el.tagName, text: t, w: Math.round(r.width), h: Math.round(r.height), cls: String(el.className || '').slice(0, 36), fiber: Object.keys(el).some((k) => /^__react(Fiber|InternalInstance)\\$/.test(k)) });
      if (cand.length >= 8) break;
    }
    let hit = null;
    for (const el of document.querySelectorAll('a,button,div,span')) {
      const t = clean(el.innerText);
      if (!t || t.length > 14 || !t.includes('提交')) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      hit = el; break;
    }
    const levels = [];
    if (hit) {
      const key = Object.keys(hit).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
      let node = key ? hit[key] : null, hops = 0;
      while (node && hops < 40) {
        const p = node.memoizedProps || {};
        const fns = Object.keys(p).filter((k) => typeof p[k] === 'function').map((k) => {
          let head = ''; try { head = String(p[k]).replace(/\\n/g, ' ').slice(0, 80); } catch (e) { head = '?'; }
          return k + ' :: ' + head;
        });
        levels.push({ hops, type: (node.type && (node.type.name || node.type.displayName)) || typeof node.type, fns: fns.slice(0, 10) });
        node = node.return; hops++;
      }
    }
    return JSON.stringify({ candidates: cand, levelsFound: !!hit, levels });
  })()`;

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

/* ── 主流程 ── */
const tabs0 = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const baseIds = new Set(tabs0.map((t) => t.id));
const prodTab = tabs0.find((t) => /comdetail/.test(t.url || ''));
if (!prodTab) { log('❌ 窗口里没有商品页标签'); process.exit(1); }
log(`商品页：${(prodTab.url || '').slice(0, 100)}`);

const cdp = new CDP(prodTab.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

let confirmTab = null;
try {
  // ① 登录态（凭据为准）
  const ck = await cdp.send('Network.getAllCookies', {});
  const hit = (ck.cookies || []).filter((c) => ['sid', 'hwid_cas_sid'].includes(c.name) && /id1\.cloud\.huawei\.com$/.test(c.domain));
  log(`登录态：${hit.length ? '已登录' : '❌ 未登录（无法开确认页）'}`);
  if (!hit.length) process.exit(1);

  // ② 商品页可买检查
  const anchor = await cdp.eval(`(() => { const a = document.getElementById('prd-botnav-rightbtn'); return a ? (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 30) : null; })()`);
  log(`商品页按钮：${anchor || '（找不到锚点）'}`);
  if (!anchor || !/立即购买|立即申购|马上抢|立即抢购/.test(anchor)) {
    log('⚠ 当前按钮不是可买状态（锁定/缺货），无法开出确认页。换一个现货商品或稍后再试。');
    process.exit(1);
  }

  // ③ 触发「立即购买」（与驱动同款内部手势；只开草稿）
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
    log(`内部手势触发：${fire.result && fire.result.value}`);
  }
  if (!fired) {
    const pos = await cdp.eval(`(() => { const a = document.getElementById('prd-botnav-rightbtn'); if (!a) return null; const r = a.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!pos) { log('❌ 触发失败：既没拿到内部入口也没拿到按钮坐标'); process.exit(1); }
    log(`回落可信点击 (${pos.x},${pos.y})`);
    await trustedClick(cdp, pos.x, pos.y);
  }

  // ④ 等确认订单页（新标签）
  let tAppear = 0;
  for (let i = 0; i < 40 && !confirmTab; i++) {
    await sleep(300);
    const ts = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
    confirmTab = ts.find((t) => /orderConfirm/.test(t.url || '') && !baseIds.has(t.id)) || null;
    if (confirmTab) tAppear = Date.now();
  }
  if (!confirmTab) { log('❌ 等 12 秒确认页没出现（内部手势+点击都没开出来？）'); process.exit(1); }
  log(`确认页出现：${(confirmTab.url || '').slice(0, 110)}`);

  const cdp2 = new CDP(confirmTab.webSocketDebuggerUrl);
  await cdp2.connect();
  await cdp2.send('Runtime.enable');

  // ⑤ 测「提交订单」按钮挂载耗时（tab 出现 → 按钮可见）
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
  let mounted = 0;
  for (let i = 0; i < 80 && !mounted; i++) {
    await sleep(250);
    try { if (await cdp2.eval(MOUNT_CHECK)) mounted = Date.now(); } catch { /* 加载中 */ }
  }
  log(mounted ? `提交按钮挂载耗时（确认页出现 → 按钮可见）：${mounted - tAppear} ms` : '⚠ 20 秒内提交按钮一直不可见');

  // ⑤b 按钮没出现 → 把页面实际长相打出来（标题/正文头/截图），判断是会话问题还是结构问题
  if (!mounted) {
    const state = await cdp2.eval(`JSON.stringify({
      title: document.title,
      url: location.href.slice(0, 180),
      ready: document.readyState,
      text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 400),
    })`).catch((e) => '读取失败：' + e.message);
    console.log('页面实际状态：', state);
    try {
      await cdp2.send('Page.enable').catch(() => {});
      const shot = await cdp2.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      const f = fileURLToPath(new URL(`./output/submit-entry-${PORT}-no-button.jpg`, import.meta.url));
      fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
      console.log('页面截图：', f);
    } catch { /* 截图失败不影响结论 */ }
  }

  // ⑥ 生产版查找逻辑（只找不调）
  let res = null;
  for (let i = 0; i < 20; i++) {
    res = await cdp2.send('Runtime.evaluate', { expression: FIND_ONLY_EXPR, returnByValue: true, userGesture: true })
      .then((r) => r.result && r.result.value).catch((e) => ({ s: 'EVAL_ERR', msg: e.message }));
    if (res && res.s !== 'NO_BUTTON') break;
    await sleep(300);
  }
  console.log('\n===== 生产版查找逻辑结果（只查不调）=====');
  console.log(JSON.stringify(res, null, 2));
  if (res && res.s === 'WOULD_FIRE') {
    console.log(`✅ 能命中：向上 ${res.hops} 层找到 handleOrderSubmit（驱动跑到这里会走"捷径"）`);
  } else {
    console.log('⚠ 没命中——下面是解剖信息（候选元素 + fiber 每层的函数型 props）：');
    const an = await cdp2.eval(ANATOMY_EXPR);
    try { console.log(JSON.stringify(JSON.parse(an), null, 1).slice(0, 4000)); } catch { console.log(String(an).slice(0, 3000)); }
  }
} finally {
  // ⑦ 收摊：关掉本次开出的确认页（草稿作废），绝不提交
  try {
    const ts = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
    for (const t of ts) {
      if (/orderConfirm/.test(t.url || '') && !baseIds.has(t.id)) {
        await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
      }
    }
  } catch { /* ignore */ }
  log('已关闭确认页标签（草稿作废，未提交订单）。');
  process.exit(0);
}
