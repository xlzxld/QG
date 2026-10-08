#!/usr/bin/env node
/**
 * 内部通道延迟基准（2026-10-08）
 * =====================================================================
 * 目的：实测 cdp-rush.mjs「A 方案内部购买链」「确认页内部提交链」「兜底点击」
 *      在真实 Chrome + 真实 CDP 上的耗时，对照"除页面加载外全部 ≤0.1s"的要求。
 *
 * 方法：真实 Chrome（headless）里搭一个与生产同构的假结构：
 *   · 商品页：div#prd-botnav-rightbtn > div[tabindex]，fiber 上挂
 *     memoizedProps.onPress（真闭包，闭包里有 Yo / E.goBuy）——与生产中
 *     pickInternalEntry 走的路径完全一致（含 [[Scopes]] 通道）；
 *   · 确认页：可见「提交订单」按钮 + fiber 链上 handleOrderSubmit。
 * 直接复制 cdp-rush.mjs 的生产表达式原文（PICK_EXPR / INTERNAL_EXPR），
 * 逐跳测量耗时。仅测量，不连接 vmall，不产生任何真实请求。
 *
 * 用法：node verify/bench-internal-chain.mjs
 * =====================================================================
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CDP, trustedClick } from '../core/cdp-core.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9678;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-internal-'));
const now = () => Number(process.hrtime.bigint()) / 1e6;

/* ── 生产表达式原文（与 platforms/huawei/cdp-rush.mjs 一字不差） ── */

const LEGACY_EXPR = `(() => { try {
  const b = window.rush && window.rush.business;
  if (b && typeof b.doGoRush === 'function') { b.doGoRush(2); return 'FIRED'; }
  return 'NOFN';
} catch (e) { return 'ERR:' + e.message; } })()`;

const PICK_EXPR = `(() => {
        const root = document.getElementById('prd-botnav-rightbtn');
        if (!root) return null;
        const host = root.querySelector('div[tabindex]') || root.querySelector('[tabindex]');
        if (!host) return null;
        const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
        if (!key) return null;
        let cur = host[key], hops = 0;
        while (cur && hops < 25) {
          const p = cur.memoizedProps;
          if (p && typeof p.onPress === 'function') return { fn: p.onPress, hops };
          cur = cur.return; hops++;
        }
        return null;
      })()`;

const INTERNAL_EXPR = `(() => {
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
        try { p.handleOrderSubmit(); return { s: 'FIRED', hops }; }
        catch (e) { return { s: 'ERR', msg: String(e && e.message || e) }; }
      }
      node = node.return; hops++;
    }
    return { s: 'NO_ENTRY' };
  })()`;

/* ── 页面假结构 ── */

const SETUP_EXPR = `(() => {
  // 商品页：按钮锚点 + fiber（真闭包：Yo / E.goBuy）
  const outer = document.createElement('div');
  outer.id = 'prd-botnav-rightbtn';
  const host = document.createElement('div');
  host.setAttribute('tabindex', '0');
  outer.appendChild(host);
  document.body.appendChild(outer);
  (function buildFiber() {
    const Yo = function Yo() { window.__yo = (window.__yo || 0) + 1; return 1; };
    const E = { goBuy: function goBuy() { window.__gb = (window.__gb || 0) + 1; } };
    host['__reactFiber$bench01'] = {
      memoizedProps: { onPress: function onPress() { try { Yo(); } catch (e) {} void E; } },
      return: null,
    };
  })();
  // 确认页：「提交订单」按钮 + fiber 链上 handleOrderSubmit（隔 2 层）
  const sub = document.createElement('div');
  sub.textContent = '提交订单';
  sub.style.cssText = 'width:120px;height:40px;display:block;';
  document.body.appendChild(sub);
  const fn = function handleOrderSubmit() { window.__sub = (window.__sub || 0) + 1; };
  sub['__reactFiber$bench02'] = {
    memoizedProps: {},
    return: { memoizedProps: {}, return: { memoizedProps: { handleOrderSubmit: fn }, return: null } },
  };
  return 'ready';
})()`;

/* ── 统计小工具 ── */
function stats(arr, label) {
  if (!arr.length) return { label, n: 0 };
  const a = [...arr].filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const r = (v) => +v.toFixed(2);
  return { label, n: a.length, min: r(a[0]), p50: r(q(0.5)), p90: r(q(0.9)), max: r(a[a.length - 1]), mean: r(mean) };
}
function printStats(s) {
  if (!s.n) { console.log(`  ${s.label}: 无数据`); return; }
  console.log(`  ${s.label.padEnd(24)} n=${String(s.n).padStart(3)}  min=${String(s.min).padStart(7)}  p50=${String(s.p50).padStart(7)}  p90=${String(s.p90).padStart(7)}  max=${String(s.max).padStart(7)}  mean=${String(s.mean).padStart(7)}  (ms)`);
}

/* ── 启动 Chrome 并接入 ── */
const child = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

async function waitTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) {
        const list = (await r.json()).filter((t) => t.type === 'page');
        if (list.length) return list[0];
      }
    } catch { /* 还没起来 */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('Chrome 调试端口未就绪');
}

try {
  const t = await waitTarget();
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  const ready = await cdp.eval(SETUP_EXPR);
  const ver = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())['Browser'];
  console.log(`页面就绪：${ready}｜${ver}`);
  console.log('\n（单位 ms；headless 空页面 + 假 fiber，CDP RTT 与专用窗口同量级）\n');

  /* ── ① 基线：单次 Runtime.evaluate RTT ── */
  {
    const xs = [];
    for (let i = 0; i < 30; i++) { const t0 = now(); await cdp.eval('1+1'); xs.push(now() - t0); }
    printStats(stats(xs, 'Runtime.evaluate 基线'));
    console.log('');
  }

  /* ── ② 内部购买链（= 生产中 internalFire 一轮，逐跳） ── */
  {
    const total = [];
    const hop = { legacy: [], pickEval: [], propsFn: [], propsScopes: [], propsScopeList: [], propsClosure: [], propsE: [], call: [] };
    let scopeInfo = '';
    let fired = 0;
    for (let i = -3; i < 30; i++) { // 前 3 轮热身
      const h = {};
      const t0 = now();
      // 0) legacy 全局路径探测（生产每轮先做）
      let s = now(); await cdp.eval(LEGACY_EXPR); h.legacy = now() - s;
      // 1) pickInternalEntry 全链
      s = now();
      const r1 = await cdp.send('Runtime.evaluate', { expression: PICK_EXPR, returnByValue: false, objectGroup: 'internal-fire' });
      h.pickEval = now() - s;
      s = now();
      const outProps = await cdp.send('Runtime.getProperties', { objectId: r1.result.objectId, ownProperties: true });
      h.propsFn = now() - s;
      const fnId = (outProps.result || []).find((v) => v.name === 'fn')?.value?.objectId;
      s = now();
      const p1 = await cdp.send('Runtime.getProperties', { objectId: fnId, ownProperties: false });
      h.propsScopes = now() - s;
      const scopesRef = (p1.internalProperties || []).find((x) => x.name === '[[Scopes]]');
      s = now();
      const sl = await cdp.send('Runtime.getProperties', { objectId: scopesRef.value.objectId, ownProperties: true });
      h.propsScopeList = now() - s;
      let yoId = null, eId = null, scanned = 0; let closureLen = 0;
      h.propsClosure = 0;
      for (const sc of sl.result || []) {
        if (!sc.value || !sc.value.objectId || !/Closure/.test(sc.value.description || '')) continue;
        scanned++;
        s = now();
        const vars = await cdp.send('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: true });
        h.propsClosure += now() - s;
        if (!closureLen) closureLen = JSON.stringify(vars).length;
        for (const v of vars.result || []) {
          if (v.name === 'Yo' && v.value && v.value.objectId) yoId = v.value.objectId;
          if (v.name === 'E' && v.value && v.value.objectId && v.value.subtype !== 'null') eId = v.value.objectId;
        }
        if (yoId) break;
      }
      s = now();
      const ep = await cdp.send('Runtime.getProperties', { objectId: eId, ownProperties: true });
      h.propsE = now() - s;
      const goBuyId = (ep.result || []).find((v) => /^gobuy$/i.test(v.name))?.value?.objectId || null;
      // 2) 调用（生产：Yo / goBuy 交替）
      s = now();
      const rr = await cdp.send('Runtime.callFunctionOn', {
        objectId: i % 2 === 0 ? yoId : goBuyId,
        functionDeclaration: i % 2 === 0
          ? 'function(){ try { this(); return "YO"; } catch (e) { return "ERR:" + e.message; } }'
          : 'function(){ try { this("buy_now_button","rushbuy"); return "GOBUY"; } catch (e) { return "ERR:" + e.message; } }',
        returnByValue: true, userGesture: true,
      });
      h.call = now() - s;
      const dt = now() - t0;
      // 与生产一致：release 不 await（fire-and-forget，单 socket 顺序安全）
      cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'internal-fire' }).catch(() => {});
      if (String(rr.result?.value || '').startsWith('ERR')) console.log(`  ⚠ 第 ${i} 轮 call 返回：${rr.result?.value}`);
      else fired++;
      if (i >= 0) {
        total.push(dt);
        for (const [k, v] of Object.entries(h)) (hop[k] = hop[k] || []).push(v);
        if (i === 0) {
          scopeInfo = `单轮细节：scopes 列表 ${(sl.result || []).length} 项，扫到含 Yo 的闭包前扫了 ${scanned} 个；call=${JSON.stringify(rr.result?.value)}；payload≈ evaluate:${JSON.stringify(r1).length}c scopeList:${JSON.stringify(sl).length}c closure:${closureLen}c；yo=${!!yoId} goBuy=${!!goBuyId}`;
        }
      }
    }
    printStats(stats(total, '内部购买链 全链合计'));
    for (const [k, arr] of Object.entries(hop)) printStats(stats(arr, `  · ${k}`));
    console.log(`  ${scopeInfo}`);
    console.log(`  成功调用轮数（含热身外的 ERR 会单列）：共 ${fired} 轮\n`);
  }

  /* ── ③ 内部提交链（单次 evaluate = FIRED 路径） ── */
  {
    const xs = [];
    for (let i = -3; i < 30; i++) {
      const t0 = now();
      const r = await cdp.send('Runtime.evaluate', { expression: INTERNAL_EXPR, returnByValue: true, userGesture: true });
      const dt = now() - t0;
      if (i >= 0) xs.push(dt);
      if (i === 0) console.log(`  提交表达式返回：${JSON.stringify(r.result?.value)}`);
    }
    printStats(stats(xs, '内部提交链 单次 evaluate'));
    console.log('');
  }

  /* ── ④ 兜底：trustedClick 派发（3 个 Input 事件 + 30ms 硬睡） ── */
  {
    const xs = [];
    for (let i = 0; i < 10; i++) { const t0 = now(); await trustedClick(cdp, 200, 200); xs.push(now() - t0); }
    printStats(stats(xs, 'trustedClick 兜底点击'));
  }

  /* ── ⑤ listTabs（/json/list HTTP 拉取） ── */
  {
    const xs = [];
    for (let i = 0; i < 10; i++) { const t0 = now(); await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()); xs.push(now() - t0); }
    printStats(stats(xs, 'listTabs (/json/list)'));
    console.log('');
  }

  /* ── ⑥ 提交兜底完整链（滚动 + 300ms 渲染等待 + 重取坐标 + 点击）── */
  {
    const SCROLL_EXPR = `(() => {
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
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    })()`;
    const POS_EXPR = `(() => {
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
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`;
    const xs = [];
    for (let i = 0; i < 5; i++) {
      const t0 = now();
      await cdp.eval(SCROLL_EXPR);
      await new Promise((r) => setTimeout(r, 300)); // 生产里固定的 300ms 渲染稳定等待
      const pos = await cdp.eval(POS_EXPR);
      await trustedClick(cdp, pos.x, pos.y);
      xs.push(now() - t0);
    }
    printStats(stats(xs, '提交兜底链(含300ms硬睡)'));
    console.log('');
  }

  console.log('基准完成。');
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 临时目录，删不掉就算了 */ }
}
process.exit(0);
