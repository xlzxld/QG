/**
 * 确认订单页"提交订单"内部入口侦察（只读 · 不提交订单）
 * =====================================================================
 * 目的：回答"确认页能不能像商品页一样走内部函数提速"。
 *   1. 连 acc1 专用窗口（9401），商品页触发一次内部入口（onPress/Yo）
 *   2. 等确认订单页（orderConfirm）新标签出现
 *   3. 解剖"提交订单"按钮：React fiber 向上走 30 层，收集每层的函数型 props
 *      （name / 挂载属性 / 源码长度 / 源码头 160 字）——看有没有能直接调用的提交入口
 *   4. 关闭确认页标签（草稿自动作废）——全程不点"提交订单"，不产生订单
 * 用法：node grab-probe/probe-confirm-entry.mjs
 * =====================================================================
 */
import { CDP, sleep, listTabs } from '../grab/cdp-core.mjs';

const PORT = 9401;
const PRODUCT_URL = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086050799772&sbomCode=2601010640424';
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

const tabs = await listTabs(PORT);
const tab = tabs.find((t) => /comdetail/.test(t.url || '')) || tabs[0];
if (!tab) { console.log('acc1 窗口里没有页面标签'); process.exit(1); }
log(`连接商品页标签：${(tab.url || '').slice(0, 80)}`);
const cdp = new CDP(tab.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');

// 商品页对位（保险）
const cur = await cdp.eval('location.href').catch(() => '');
if (!String(cur).includes('10086050799772')) {
  await cdp.send('Page.navigate', { url: PRODUCT_URL });
  await sleep(4000);
}

// ① 商品页：找购买入口（fiber → onPress）。★ 必须用 callFunctionOn + userGesture:true
//    触发——确认页是 window.open 开的新标签，没有用户手势会被弹窗拦截器静默拦下
//    （2026-10-07 实测：普通 evaluate 触发后确认页永远不出现）。
const r1 = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const root = document.getElementById('prd-botnav-rightbtn');
    if (!root) return null;
    const host = root.querySelector('div[tabindex]') || root.querySelector('[tabindex]');
    if (!host) return null;
    const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
    let node = host[key], hops = 0;
    while (node && hops < 25) {
      const p = node.memoizedProps;
      if (p && typeof p.onPress === 'function') return p.onPress;
      node = node.return; hops++;
    }
    return null;
  })()`,
  returnByValue: false,
});
const fnId = r1 && r1.result && r1.result.objectId;
if (!fnId) { log('商品页触发：没找到 onPress'); process.exit(1); }
const fire = await cdp.send('Runtime.callFunctionOn', {
  objectId: fnId,
  functionDeclaration: 'function(){ try { this(); return "FIRED"; } catch (e) { return "ERR:" + e.message; } }',
  returnByValue: true,
  userGesture: true, // ★ 关键：不带这个，确认页 window.open 会被拦截
});
log('商品页触发：', JSON.stringify(fire.result && fire.result.value));
if (!fire.result || fire.result.value !== 'FIRED') process.exit(1);

// ② 等确认订单页新标签
let confirmTab = null;
for (let i = 0; i < 24; i++) {
  await sleep(500);
  const ts = await listTabs(PORT).catch(() => []);
  confirmTab = ts.find((t) => /orderConfirm/.test(t.url || ''));
  if (confirmTab) break;
}
if (!confirmTab) { log('确认订单页没出现'); process.exit(1); }
log(`确认页出现：${(confirmTab.url || '').slice(0, 90)}`);
await sleep(2500); // 等页面渲染（React 挂载提交按钮）

// ③ 解剖"提交订单"按钮的 fiber 链
const cdp2 = new CDP(confirmTab.webSocketDebuggerUrl);
await cdp2.connect();
await cdp2.send('Runtime.enable');
const probe = await cdp2.eval(`(() => {
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
  if (!hit) return { ok: false, reason: 'NO_BUTTON' };
  const key = Object.keys(hit).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
  const chain = [];
  let node = key ? hit[key] : null, hops = 0;
  while (node && hops < 30) {
    const p = node.memoizedProps || {};
    const fns = [];
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (typeof v === 'function') {
        let src = '';
        try { src = String(v); } catch (e2) { src = ''; }
        fns.push({ prop: k, name: v.name || '(匿名)', len: src.length, head: src.slice(0, 160) });
      }
    }
    if (fns.length) {
      chain.push({
        hops,
        type: (node.type && node.type.name) ? String(node.type.name).slice(0, 40) : (typeof node.type),
        fns: fns.slice(0, 8),
      });
    }
    node = node.return; hops++;
  }
  return { ok: true, sawFiber: !!key, tag: hit.tagName, text: clean(hit.innerText).slice(0, 30), chains: chain.slice(0, 10) };
})()`);
console.log('=== 确认页「提交订单」fiber 侦察 ===');
console.log(JSON.stringify(probe, null, 2));

// ③b 深挖：收集 orderConfirmSubmit / handleOrderSubmit 的函数对象，dump [[Scopes]]
const r2 = await cdp2.send('Runtime.evaluate', {
  expression: `(() => {
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
    if (!hit) return [];
    const key = Object.keys(hit).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
    const out = [];
    let node = key ? hit[key] : null, hops = 0;
    while (node && hops < 30) {
      const p = node.memoizedProps || {};
      for (const k of Object.keys(p)) {
        const v = p[k];
        if (typeof v === 'function' && /orderConfirmSubmit|handleOrderSubmit/i.test(k)) {
          out.push({ hops, prop: k, name: v.name || '', src: String(v).slice(0, 600), fn: v });
        }
      }
      node = node.return; hops++;
    }
    return out;
  })()`,
  returnByValue: false,
});
const arrId = r2 && r2.result && r2.result.objectId;
if (arrId) {
  const seen = new Set();
  const arr = await cdp2.send('Runtime.getProperties', { objectId: arrId });
  for (const elem of (arr.result || [])) {
    if (!elem.value || !elem.value.objectId) continue;
    const elProps = await cdp2.send('Runtime.getProperties', { objectId: elem.value.objectId });
    let fnRef = null, meta = {};
    for (const pr of (elProps.result || [])) {
      if (pr.name === 'fn') fnRef = pr.value;
      else if (['hops', 'prop', 'name', 'src'].includes(pr.name)) meta[pr.name] = pr.value && pr.value.value;
    }
    if (!fnRef || !fnRef.objectId) continue;
    const fnProps = await cdp2.send('Runtime.getProperties', { objectId: fnRef.objectId });
    const scopesRef = (fnProps.internalProperties || []).find((x) => x.name === '[[Scopes]]');
    const fnKey = meta.prop + '#' + meta.hops;
    if (seen.has(fnKey)) continue;
    seen.add(fnKey);
    console.log(`\n=== ${meta.prop}（hops=${meta.hops}, name=${meta.name}）===`);
    console.log('源码：', (meta.src || '').slice(0, 600));
    if (!scopesRef || !scopesRef.value || !scopesRef.value.objectId) { console.log('  （无 [[Scopes]]）'); continue; }
    const scopes = await cdp2.send('Runtime.getProperties', { objectId: scopesRef.value.objectId });
    for (const sc of (scopes.result || [])) {
      if (!sc.value || !sc.value.objectId) continue;
      const vars = await cdp2.send('Runtime.getProperties', { objectId: sc.value.objectId });
      const lines = [];
      for (const v of (vars.result || [])) {
        const val = v.value || {};
        if (val.type === 'function') {
          let src = '';
          try { const d = await cdp2.send('Runtime.getProperties', { objectId: val.objectId, ownProperties: true }); src = d.internalProperties?.find((x) => x.name === '[[FunctionLocation]]') ? 'fn' : 'fn'; } catch { src = 'fn'; }
          try { const ev = await cdp2.send('Runtime.callFunctionOn', { objectId: val.objectId, functionDeclaration: 'function(){ return String(this).slice(0, 220); }', returnByValue: true }); src = ev.result.value.value || ev.result.value; } catch { /* 跳过 */ }
          lines.push(`    ${v.name}(): ${String(src).replace(/\s+/g, ' ').slice(0, 220)}`);
        } else if (val.type !== 'object' || (val.subtype !== 'object' && val.subtype !== 'array')) {
          const sv = val.value === undefined ? 'undefined' : JSON.stringify(val.value);
          lines.push(`    ${v.name} = ${String(sv).slice(0, 120)}`);
        } else {
          lines.push(`    ${v.name}: ${val.subtype || val.type}（键略）`);
        }
      }
      console.log(`  [${sc.value.description || 'scope'}]`);
      console.log(lines.join('\n') || '    （空）');
    }
  }
}

// ④ 收摊：关掉确认页标签（草稿自动作废），绝不提交
try { await fetch(`http://127.0.0.1:${PORT}/json/close/${confirmTab.id}`); } catch { /* 已关 */ }
log('已关闭确认页标签（草稿作废，未提交订单）');
process.exit(0);
