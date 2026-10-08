#!/usr/bin/env node
/**
 * probe-rush-entry.mjs —— A 方案（内部函数触发器）入口侦察器
 * =====================================================================
 * 2026-10-07 侦察结论：vmall 商品页「立即购买」按钮是 RNW（react-native-web）
 * Pressable 组件；真正的业务回调在 React fiber 树上——从按钮内层
 * div[tabindex] 的 fiber 沿 return 链向上找，memoizedProps.onPress 即
 * "立即购买"业务逻辑（约 790 字，内含 buttonMode / rushBuyPrd / 节流门 /
 * Do.onPress() 与 Yo() 双分支）。
 * 调用它 = 等效点击，但不产生 DOM 事件 → 不存在 isTrusted 检测问题。
 * （2020 版全局对象路径 window.rush.business.doGoRush 已随改版移除。）
 *
 * 三层能力，可单独或组合执行：
 *   1. 默认      只读侦察：定位入口链（anchor→pressable→fiber→onPress），
 *                打印层数 / 源码长度 / 签名（buttonMode、rushBuyPrd 等）；
 *   2. --dump-closure  读 onPress 闭包变量（[[Scopes]] 法，无副作用；
 *                读不到时提示改用断点法）。关键目标：Uo（节流阈值）、
 *                Yo（抢购分支函数）、E.buttonMode、R.ZP（枚举表）；
 *   3. --fire    调用一次 onPress（=「立即购买」，本身不产生订单），
 *                监测确认订单页是否出现（只读确认页金额）。
 *
 * ★ 安全硬性：本脚本不含任何"提交订单"相关代码；fire 后只观察不点击。
 * ★ 白名单：--nav 目标与当前页面商品都必须来自 huawei.config.json 的
 *   products[]（用户 2026-10-07 硬规则：清单外的商品一律不操作）。
 *
 * 用法：
 *   node grab-probe/probe-rush-entry.mjs                       # 只读侦察（默认端口 9401）
 *   node grab-probe/probe-rush-entry.mjs --dump-closure        # + 读闭包变量
 *   node grab-probe/probe-rush-entry.mjs --fire                # + 调一次并监测确认页
 *   node grab-probe/probe-rush-entry.mjs --nav --prdId=10086384648661 --sbomCode=2601010640917 --fire
 *   node grab-probe/probe-rush-entry.mjs --json                # stdout 输出 JSON 报告
 *
 * 产物：
 *   grab-probe/output/rush-entry-probe.json     （scan + fire 报告）
 *   grab-probe/output/rush-entry-closure.json   （--dump-closure 报告）
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CDP, listTabs, sleep } from '../grab/cdp-core.mjs';

// ── 参数 ──
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const PORT = Number(args.port || 9401);
const WATCH_MS = Number(args['watch-secs'] || 60) * 1000;
const OUT_DIR = fileURLToPath(new URL('./output/', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('../data/grab/huawei.config.json', import.meta.url));

const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// ── 白名单（用户 2026-10-07 硬规则：清单外商品一律不操作）──
const prdFromUrl = (u) => (String(u || '').match(/prdId=(\d+)/) || [])[1] || null;

function loadAllowedPrdIds() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const s = new Set();
    for (const p of cfg.products || []) {
      if (p && p.enabled !== false) {
        const id = prdFromUrl(p.url);
        if (id) s.add(String(id));
      }
    }
    return s;
  } catch (e) {
    log(`⚠ 读不到 ${CONFIG_PATH}（${e.message}）——白名单校验将跳过（仅限你在调试时如此）`);
    return null;
  }
}

// ── 页面表达式 ──

/** 定位入口链（只读） */
const SCAN_EXPR = `(() => {
  const out = { webpack: !!window.webpackChunk_N_E };
  try {
    out.url = location.href.slice(0, 140);
    out.title = document.title;
    const root = document.getElementById('prd-botnav-rightbtn');
    out.anchor = !!root;
    if (root) out.btnText = (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    const host = root && (root.querySelector('div[tabindex]') || root.querySelector('[tabindex]'));
    out.pressable = !!host;
    if (host) {
      const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
      out.fiberKey = key ? key.replace(/\\$.*/, '$…') : null;
      let cur = key ? host[key] : null, hops = 0;
      while (cur && hops < 25) {
        const p = cur.memoizedProps;
        if (p && typeof p.onPress === 'function') {
          out.found = true; out.hops = hops; out.disabled = p.disabled === true;
          const src = String(p.onPress);
          out.srcLen = src.length;
          out.srcHead = src.slice(0, 320);
          out.signature = {
            buttonMode: /buttonMode/.test(src),
            rushBuyPrd: /rushBuyPrd/.test(src),
            depositrush: /depositrushBuyPrd/.test(src),
            throbbing: /throbbing/.test(src),
          };
          break;
        }
        cur = cur.return; hops++;
      }
    }
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out);
})()`;

/** 取 onPress 函数对象本体（给 [[Scopes]] 用，returnByValue=false） */
const FN_OBJ_EXPR = `(() => {
  const root = document.getElementById('prd-botnav-rightbtn');
  const host = root && (root.querySelector('div[tabindex]') || root.querySelector('[tabindex]'));
  if (!host) return null;
  const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
  let cur = key ? host[key] : null, hops = 0;
  while (cur && hops < 25) {
    const p = cur.memoizedProps;
    if (p && typeof p.onPress === 'function') return p.onPress;
    cur = cur.return; hops++;
  }
  return null;
})()`;

/** 定位 + 调用（原子，只调「立即购买」） */
const FIRE_EXPR = `(() => { try {
  const root = document.getElementById('prd-botnav-rightbtn');
  if (!root) return 'NO_ANCHOR';
  const host = root.querySelector('div[tabindex]') || root.querySelector('[tabindex]');
  if (!host) return 'NO_PRESSABLE';
  const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
  if (!key) return 'NO_FIBER';
  let cur = host[key], hops = 0;
  while (cur && hops < 25) {
    const p = cur.memoizedProps;
    if (p && typeof p.onPress === 'function') {
      p.onPress();
      return 'FIRED@' + hops;
    }
    cur = cur.return; hops++;
  }
  return 'NO_ONPRESS';
} catch (e) { return 'ERR:' + (e && e.message); } })()`;

/** 通用对象浅层导出（给闭包 dump 用） */
const SHAPE_FN = `function(){ try {
  if (this === null || typeof this !== 'object') return '[' + typeof this + '] ' + String(this);
  const ks = Object.keys(this).slice(0, 80);
  const o = {};
  for (const k of ks) {
    const v = this[k];
    o[k] = (typeof v === 'function') ? ('[fn] ' + String(v).slice(0, 90))
         : (v && typeof v === 'object') ? ('[obj] keys:' + Object.keys(v).slice(0, 24).join(','))
         : v;
  }
  return JSON.stringify(o).slice(0, 6000);
} catch (e) { return 'ERR:' + e.message; } }`;

// ── 侦察 ──

async function scanEntry(cdp) {
  const raw = await cdp.eval(SCAN_EXPR);
  try { return JSON.parse(raw); } catch { return { err: 'scan 解析失败', raw: String(raw).slice(0, 400) }; }
}

function printScan(scan) {
  log('─── 入口链侦察 ───');
  log(`  页面        ：${scan.title || ''} | ${scan.url || ''}`);
  log(`  锚点        ：${scan.anchor ? '✅ #prd-botnav-rightbtn 存在' : '❌ 缺失'}` + (scan.btnText ? `（按钮文案「${scan.btnText}」）` : ''));
  log(`  Pressable   ：${scan.pressable ? '✅' : '❌'}   fiber key：${scan.fiberKey || '—'}`);
  if (scan.found) {
    log(`  onPress     ：✅ 命中（向上 ${scan.hops} 层） · 源码 ${scan.srcLen} 字 · disabled=${scan.disabled}`);
    log(`  签名        ：buttonMode=${scan.signature.buttonMode} rushBuyPrd=${scan.signature.rushBuyPrd} depositrush=${scan.signature.depositrush} throbbing=${scan.signature.throbbing}`);
    log(`  源码头      ：${(scan.srcHead || '').slice(0, 200).replace(/\s+/g, ' ')}…`);
  } else {
    log(`  onPress     ：❌ 未找到（anchor=${scan.anchor} pressable=${scan.pressable}）`);
  }
  log(`  webpack 环境：${scan.webpack ? 'webpackChunk_N_E 存在（备选路线）' : '无'}`);
}

async function dumpClosure(cdp) {
  const report = { at: new Date().toISOString(), scopes: [], vars: [], err: null };
  const r1 = await cdp.send('Runtime.evaluate', {
    expression: FN_OBJ_EXPR, returnByValue: false, objectGroup: 'probe-closure',
  }).catch((e) => ({ error: { message: e.message } }));
  const fnObjId = r1.result && r1.result.objectId;
  if (!fnObjId) { report.err = '拿不到 onPress 对象（页面当前没有可定位的 Pressable）'; return report; }

  const p1 = await cdp.send('Runtime.getProperties', { objectId: fnObjId, ownProperties: false });
  const scopesRef = (p1.internalProperties || []).find((x) => x.name === '[[Scopes]]');
  if (!scopesRef || !scopesRef.value || !scopesRef.value.objectId) {
    report.err = 'onPress 没有 [[Scopes]]（改用断点法：setBreakpointOnFunctionCall + evaluateOnCallFrame）';
    return report;
  }
  const sl = await cdp.send('Runtime.getProperties', { objectId: scopesRef.value.objectId, ownProperties: true });
  for (const s of sl.result || []) {
    report.scopes.push({ name: s.name, desc: (s.value && s.value.description) || null });
  }
  const closureScopes = (sl.result || []).filter((s) => s.value && s.value.objectId && /Closure/.test(s.value.description || ''));
  for (const cs of closureScopes) {
    const vars = await cdp.send('Runtime.getProperties', { objectId: cs.value.objectId, ownProperties: true });
    for (const v of vars.result || []) {
      const val = v.value || {};
      const entry = { scope: cs.value.description, name: v.name, type: val.type };
      try {
        if (val.type === 'function' && val.objectId) {
          const s = await cdp.send('Runtime.callFunctionOn', {
            objectId: val.objectId,
            functionDeclaration: 'function(){ try { return String(this); } catch(e){ return "ERR:"+e.message; } }',
            returnByValue: true,
          });
          entry.src = String((s.result && s.result.value) || '').slice(0, 3000);
        } else if (val.type === 'object' && val.objectId) {
          const s = await cdp.send('Runtime.callFunctionOn', {
            objectId: val.objectId, functionDeclaration: SHAPE_FN, returnByValue: true,
          });
          entry.shape = String((s.result && s.result.value) || '');
        } else {
          entry.value = val.value;
        }
      } catch (e) { entry.dumpErr = e.message; }
      report.vars.push(entry);
    }
  }
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'probe-closure' }).catch(() => {});
  return report;
}

/** 关注的闭包变量名（从 onPress 源码中读到的标识符清单） */
const KEY_VARS = ['Uo', 'Vo', 'Ho', 'Yo', 'Do', 'E', 'R', 'K', 'Re', 'O', 'P',
  'No', 'Ao', 'ye', 'Ie', 'At', 'Yt', 'Jo', 'Kt', 'Wo', 'Zo'];

function printClosure(closure) {
  log('─── onPress 闭包变量 ───');
  if (closure.err) { log(`  ⚠ ${closure.err}`); return; }
  log(`  作用域链：${closure.scopes.map((s) => s.desc || s.name).join(' → ')}`);
  const byName = new Map();
  for (const v of closure.vars) byName.set(v.name, v);
  for (const name of KEY_VARS) {
    const v = byName.get(name);
    if (!v) continue;
    if (v.value !== undefined) log(`  ★ ${name} = ${JSON.stringify(v.value)}（${v.type}）`);
    else if (v.src !== undefined) log(`  ★ ${name}（函数，${v.src.length} 字）：${v.src.slice(0, 220).replace(/\s+/g, ' ')}…`);
    else if (v.shape !== undefined) log(`  ★ ${name}（对象）：${String(v.shape).slice(0, 260)}`);
  }
  const others = closure.vars.filter((v) => !KEY_VARS.includes(v.name));
  log(`  其余变量 ${others.length} 个：${others.map((v) => `${v.name}:${v.type}`).join(', ').slice(0, 900)}`);
}

// ── fire + 确认页监测 ──

async function watchConfirm(port, baseline, watchMs) {
  const w0 = Date.now();
  while (Date.now() - w0 < watchMs) {
    const tabs = await listTabs(port).catch(() => []);
    const conf = tabs.find((t) => !baseline.has(t.id) && (/orderConfirm/.test(t.url || '') || /确认订单/.test(t.title || '')));
    if (conf) return conf;
    await sleep(500);
  }
  return null;
}

// ── 主流程 ──

async function main() {
  const report = { at: new Date().toISOString(), port: PORT, args, scan: null, closure: null, fire: null };
  const allowed = loadAllowedPrdIds();
  log(`端口 ${PORT} · 白名单 ${allowed ? `已加载（${allowed.size} 个商品）` : '未加载'}`);

  const tabs = await listTabs(PORT).catch(() => []);
  const tab = tabs.find((t) => /comdetail/.test(t.url || ''));
  if (!tab) throw new Error(`端口 ${PORT} 上没有商品页标签（现有：${tabs.map((t) => (t.url || '').slice(0, 60)).join(' | ') || '无'}）`);
  log(`目标标签：${tab.url.slice(0, 120)}`);

  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  // --nav：导航到指定 SKU（白名单先行，闸门在副作用之前）
  if (args.nav) {
    const prdId = String(args.prdId || '');
    const sbomCode = String(args.sbomCode || '');
    if (!prdId) throw new Error('--nav 需要 --prdId=...（--sbomCode 可选）');
    if (allowed && !allowed.has(prdId)) {
      throw new Error(`⛔ 商品 ${prdId} 不在 huawei.config.json 的 products[] 里——拒绝导航（用户硬规则：清单外商品一律不操作）`);
    }
    const url = `https://item.vmall.com/product/comdetail/index.html?prdId=${prdId}${sbomCode ? `&sbomCode=${sbomCode}` : ''}`;
    log(`导航到：${url}`);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });
    let ready = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      ready = await cdp.eval('document.readyState').catch(() => null);
      if (ready === 'complete') break;
    }
    log(`导航完成（readyState=${ready}），等 2.5s 水合…`);
    await sleep(2500);
  }

  // 白名单复核（当前页面）：不在清单 → 本探针不操作
  const pageInfo = await cdp.eval('JSON.stringify({ url: location.href, title: document.title })').then(JSON.parse).catch(() => null);
  const curPrd = prdFromUrl(pageInfo && pageInfo.url);
  if (allowed && curPrd && !allowed.has(curPrd)) {
    throw new Error(`⛔ 当前页面商品 ${curPrd}（${pageInfo.title}）不在清单里——本探针不操作它（用户硬规则）`);
  }

  // 1) SCAN
  const scan = await scanEntry(cdp);
  report.scan = scan;
  printScan(scan);

  // 2) dump-closure
  if (args['dump-closure']) {
    const closure = await dumpClosure(cdp);
    report.closure = { err: closure.err, scopes: closure.scopes, varsCount: closure.vars.length };
    printClosure(closure);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_DIR + 'rush-entry-closure.json', JSON.stringify(closure, null, 2));
    log(`闭包报告已落盘：grab-probe/output/rush-entry-closure.json`);
  }

  // 3) fire
  if (args.fire) {
    if (!scan.found && !(args['force-fire'])) {
      log('⚠ 当前未定位到 onPress，fire 取消（可加 --force-fire 强制尝试）。');
    } else {
      const baseline = new Set((await listTabs(PORT)).map((t) => t.id));
      log('调用 onPress（=「立即购买」，不产生订单；本脚本绝不提交订单）…');
      let r = null;
      try { r = await cdp.eval(FIRE_EXPR); } catch (e) { r = 'EVAL_ERR:' + e.message; }
      log(`fire 返回：${r}`);
      const fired = typeof r === 'string' && (/^FIRED@/.test(r) || /context|destroyed|Target closed/i.test(r));
      report.fire = { result: r, fired, confirmFound: null, confirmText: null, pay: null };
      if (!fired) {
        log('未调用成功，跳过确认页监测。');
      } else {
        log(`监测确认订单页（${WATCH_MS / 1000}s，只看新标签）…`);
        const conf = await watchConfirm(PORT, baseline, WATCH_MS);
        if (conf) {
          let pay = null, head = '';
          try {
            const c2 = new CDP(conf.webSocketDebuggerUrl);
            await c2.connect();
            const txt = await c2.eval('document.body ? document.body.innerText : ""').catch(() => '');
            pay = ((String(txt).match(/应付[金额总额][:：]?\s*¥?\s*([\d,.]+)/) || [])[1]) || null;
            head = String(txt).replace(/\s+/g, ' ').slice(0, 300);
            c2.ws.close();
          } catch { /* 读不到不影响结论 */ }
          log(`✅ 确认订单页出现${pay ? `（应付 ¥${pay}）` : ''}：${conf.url.slice(0, 110)}`);
          report.fire.confirmFound = true;
          report.fire.confirmUrl = conf.url;
          report.fire.pay = pay;
          report.fire.confirmTextHead = head;
        } else {
          log(`⚠ ${WATCH_MS / 1000}s 内未见确认订单页（未开售/未登录态下属预期；可购态应出现）。`);
          report.fire.confirmFound = false;
        }
      }
    }
  }

  cdp.ws.close();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_DIR + 'rush-entry-probe.json', JSON.stringify(report, null, 2));
  log('报告已落盘：grab-probe/output/rush-entry-probe.json');
  if (args.json) console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
