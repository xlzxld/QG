#!/usr/bin/env node
/**
 * 华为抢购 · CDP 真点击驱动（多槽位并行版）
 *
 * 槽位模型：一个槽位 = 一个专用 Chrome 窗口 = 一个华为账号 = 一个要抢的 SKU。
 * 槽位配置在 data/grab/rush-slots.huawei.json（按平台命名，控制台可编辑）；
 * 商品与开售时间在 huawei.config.json。
 *
 * 为什么需要 CDP：油猴脚本里的 DOM .click() 是 isTrusted=false 的合成事件，
 * vmall 的下单按钮直接无视（2026-10-06 演练实测）。本脚本通过 Chrome 官方调试
 * 接口（CDP）的 Input 域派发鼠标事件，isTrusted=true，与真人点击无异。
 *
 * 用法：
 *   node platforms/huawei/cdp-rush.mjs                 # 所有槽位并行
 *   node platforms/huawei/cdp-rush.mjs --slot=acc1     # 只跑一个槽位
 *   （控制台「派发」按钮也是拉起本脚本）
 *
 * 流程（每个槽位独立执行）：
 *   启动/复用专用窗口 → 就位商品页（按槽位绑定的 SKU）→ 等人登录（第一次）
 *   → 对表华为服务器钟（中点法+中位数，T0-10s 再精校一次）→ 官方接口拿开售时刻
 *   （没有才用配置的 saleAt）→ 到点（服务器钟口径）不刷新页面高频盯按钮 → 触发
 *   「立即购买」（triggerMode：click=可信点击 / internal=直接调页面内部下单函数
 *   rush.business.doGoRush，失败自动回落点击）→ 保险丝：开售后 1s 按钮仍未出现
 *   就绕缓存强刷一次（仅一次）→ 排队/确认页绝不刷新。演练模式停在确认订单页；
 *   真模式继续可信点击「提交订单」并读真实订单号。
 *
 * B 方案（响应拦截，config.intercept.enabled）：
 *   通过 CDP Fetch 域在「本机浏览器收到的内容」上做手脚——不构造、不重放、
 *   不伪造任何请求，所有流量仍由页面自己的代码发起：
 *   R1 抢购信息提前解锁（queryRushbuyInfo.json 的 startTime 提前 leadMs）；
 *   R2 排队页/排队脚本落盘留证（真实样本到手后才做接管，见 intercept/rules.mjs）；
 *   R3 确认订单页零延迟信号（浏览器级 Target 事件，window.open 新标签瞬间即知）。
 *   拦截任何失败一律原样放行，绝不阻断页面。
 *
 *   → 没抢到（缺货/超时）且 config.monitor.enabled=true：进入回流监控——守到
 *   活动 endTime（上限 maxMs）：Node 侧轻量轮询 queryRushbuyInfo（字段一变立刻
 *   醒）+ 周期绕缓存刷新商品页看按钮（唯一可信信号），付款超时峰窗口（默认
 *   开启后 40 分钟内）加密轮询。捕获回流走与正抢完全相同的触发链路。
 *
 * 时间口径：一律以华为服务器钟为准（本地钟默认 7 天才同步一次、实测可偏差数百毫秒）。
 * 校时接口免鉴权（2026-10-07 实测可用）：
 *   https://openapi.vmall.com/serverTime.json                   → serverTimeMs
 *   https://buy.vmall.com/queryRushbuyInfo.json?sbomCodes=<SKU> → currentTime + 各 SKU 开售 startTime
 *
 * 安全边界（与油猴脚本一致）：
 *   · dryRun=true（默认）绝不点“提交订单”；
 *   · 遇到验证码/登录挑战一律停下转人工，不做任何绕过；
 *   · 支付永远人工完成。
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import {
  sleep, sleepUntil, logFor, ON_LOGIN_PAGE, readLoginState, probeLoginApi,
  CDP, listTabs, waitTab, trustedClick, ensureSlotWindow, judgeVmallLoginBody,
} from '../../core/cdp-core.mjs';
import { installInterception } from './intercept/install.mjs';
import { probeServerTime, calibrateClock, probeRushbuyInfo, fetchSaleStartServerMs } from './vmall-api.mjs';

const BRIDGE = 'http://127.0.0.1:3100';
const PLATFORM = 'huawei';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const fmtLocal = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

const CHALLENGE = /验证码|安全验证|滑块|拖动滑块|完成拼图/;

/* ── 真场取证（2026-10-08）：抢没抢到都要拿到全套现场数据 ──────────────────
 * 每次驱动运行建一个 evidence/rush-<启动时间>/<槽位>/ 目录，落四类东西：
 *   events.jsonl  机器可读时间线（每行 {at, tRelT0(服务器钟相对T0毫秒), event, detail}）
 *   netlog.jsonl  全部 vmall API 请求/响应（时间、方法、状态码、URL、POST 摘要）
 *   bodies.jsonl  关键响应体原文（下单/提交/抢购信息/库存刷新，拒单理由就在这）
 *   *.jpg / *.txt 关键时刻截图（点完购买、提交后）与确认页全文
 * 设计纪律：热路径零阻塞——事件/网络都是同步追加小文件；响应体抓取 fire-and-forget；
 * 截图只在出手之后拍。复盘用 verify/collect-rush-evidence.mjs 汇总成报告。 */
const RUSH_STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
function makeEvidence(slotId) {
  const dir = fileURLToPath(new URL(`../../data/grab/evidence/rush-${RUSH_STAMP}/${slotId}/`, import.meta.url));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 磁盘问题不拦抢购 */ }
  const files = {
    ev: path.join(dir, 'events.jsonl'),
    net: path.join(dir, 'netlog.jsonl'),
    body: path.join(dir, 'bodies.jsonl'),
  };
  const state = { t0Server: null, offset: 0 }; // 校准后填：tRelT0 = 本地钟 − offset − t0Server
  const rel = () => (state.t0Server != null ? Math.round(Date.now() - state.offset - state.t0Server) : null);
  const append = (f, row) => { try { fs.appendFileSync(f, JSON.stringify(row) + '\n'); } catch { /* 忽略 */ } };
  return {
    dir,
    state,
    ev: (event, detail = '') => append(files.ev, {
      at: new Date().toISOString(), tRelT0: rel(), event,
      detail: typeof detail === 'string' ? detail.slice(0, 500) : detail,
    }),
    net: (row) => append(files.net, { at: new Date().toISOString(), tRelT0: rel(), ...row }),
    body: (row) => append(files.body, { at: new Date().toISOString(), tRelT0: rel(), ...row }),
    shot: async (cdp2, name) => {
      try {
        const s = await cdp2.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 });
        fs.writeFileSync(path.join(dir, `${name}.jpg`), Buffer.from(s.data, 'base64'));
      } catch { /* 截图失败不影响流程 */ }
    },
    text: (name, t) => { try { fs.writeFileSync(path.join(dir, `${name}.txt`), String(t).slice(0, 12000)); } catch { /* 忽略 */ } },
  };
}
/** 给 CDP 会话装网络记录：vmall API 全记，buy.vmall.com / order / rushbuy / refreshSbom
 *  的响应体尽力抓原文（与 Fetch 拦截竞争时 900ms 后补抓一次；全部 fire-and-forget）。 */
function attachNetRecorder(cdp2, E) {
  const interesting = (u) => /vmall\.com|huawei\.com/i.test(u) && !/\.(js|css|png|jpe?g|webp|svg|woff2?|gif|mp4)(\?|$)/i.test(u);
  const bodyWorthy = (u) => /buy\.vmall\.com/i.test(u) || /order|submit|trade|rushbuy|refreshSbom|inventory/i.test(u);
  cdp2.on('Network.requestWillBeSent', (p) => {
    try {
      const u = (p.request && p.request.url) || '';
      if (!interesting(u)) return;
      E.net({ req: 1, m: p.request.method, u: u.slice(0, 160), post: String(p.request.postData || '').slice(0, 400) });
    } catch { /* 忽略 */ }
  });
  cdp2.on('Network.responseReceived', (p) => {
    try {
      const u = (p.response && p.response.url) || '';
      if (!interesting(u)) return;
      E.net({ resp: 1, st: p.response.status, u: u.slice(0, 160) });
      if (bodyWorthy(u) && p.requestId) {
        const rid = p.requestId;
        const grab = () => cdp2.send('Network.getResponseBody', { requestId: rid })
          .then((r) => E.body({
            st: p.response.status, u: u.slice(0, 140),
            b: String(r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body).slice(0, 3000),
          }))
          .catch(() => {});
        grab();
        setTimeout(grab, 900);
      }
    } catch { /* 忽略 */ }
  });
}

/* 风控判定必须跳过登录/账号页（2026-10-07 实测误杀）：
 * 登录页满屏"短信验证码/滑块"字样——用户还在输验证码时，值守把"短信验证码登录"
 * 当成了风控验证，双槽位全部停车。登录页的验证码是登录流程的一部分，不是风控；
 * 真正的风控拦的是 vmall 商品页，用域名 + 登录页特征区分。 */
const isLoginPage = (url, title) => ON_LOGIN_PAGE.test(((url || '') + ' ' + (title || '')))
  || /id1\.cloud\.huawei\.com/i.test(url || '');
const looksLikeRiskControl = (s) => !!s && CHALLENGE.test(s.text || '') && !isLoginPage(s.url, s.title);
const NOT_LOGIN = /请登录|立即登录|账号登录/;

/** 与油猴脚本同一套按钮挑选规则（v0.3.1：精确文案 > BUY 序 > 真标签 > 短文本 > 深层级） */
const buyExpr = (doScroll) => `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const textOf = (el) => clean(el && (el.innerText || el.textContent || ''));
  const BUY = ['立即购买', '立即申购', '加入购物车', '立即预订', '马上抢', '立即抢购'];
  const isActionable = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    if (el.hasAttribute('disabled')) return false;
    if (typeof el.className === 'string' && /disabled|is-disabled|btn-disabled/.test(el.className)) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  };
  const hits = [];
  for (const el of document.querySelectorAll('a,button,div,span')) {
    const t = textOf(el);
    if (!t || t.length > 12) continue;
    if (!BUY.some((k) => t.includes(k))) continue;
    if (el.tagName === 'A' && el.querySelector('a')) continue;
    hits.push(el);
  }
  const kwOrder = (t) => BUY.findIndex((k) => t.includes(k));
  const depth = (el) => { let d = 0; for (let n = el; n && n !== document.body; n = n.parentElement) d++; return d; };
  const cands = hits.filter(isActionable).sort((a, b) => {
    const ta = textOf(a), tb = textOf(b);
    const ea = BUY.some((k) => ta === k) ? 0 : 1, eb = BUY.some((k) => tb === k) ? 0 : 1;
    if (ea !== eb) return ea - eb;
    if (ea === 0 && kwOrder(ta) !== kwOrder(tb)) return kwOrder(ta) - kwOrder(tb);
    const ga = (a.tagName === 'BUTTON' || a.tagName === 'A') ? 0 : 1;
    const gb = (b.tagName === 'BUTTON' || b.tagName === 'A') ? 0 : 1;
    if (ga !== gb) return ga - gb;
    if (ta.length !== tb.length) return ta.length - tb.length;
    return depth(b) - depth(a);
  });
  const el = cands[0];
  if (!el) return null;
  ${doScroll ? "el.scrollIntoView({ block: 'center', inline: 'center' });" : ''}
  const r = el.getBoundingClientRect();
  return { label: textOf(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

const stateExpr = `(() => ({
  url: location.href,
  title: document.title,
  ready: document.readyState,
  text: (document.body ? document.body.innerText : ''),
}))()`;

/**
 * 高频轻量检查（一次 evaluate 出全部信号，取代慢速路径的两次全页评估）：
 * ① 优先直查 PC 端已知按钮位 #prd-botnav-rightbtn（hw_seckill 与 greasyfork
 *    393577 双源确认），锁定态在 needText=false 时不读全文——一轮微秒级；
 * ② needText=true（开售后/每 10 轮）才读 body.innerText，出缺货/风控/登录/
 *    已选信号，且只在文本出现购买关键词时才做全页兜底扫描（页面变体容错）。
 * 2026-10-07 实测瓶颈：旧路径每轮两次全页评估（上千元素逐个 innerText）耗时
 * 几百毫秒，150ms 睡眠根本不是节拍主项——先治这个，轮询间隔才有意义。
 */
const fastCheckExpr = (needText) => `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const BUY = ['立即购买', '立即申购', '加入购物车', '立即预订', '马上抢', '立即抢购'];
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    if (el.hasAttribute('disabled')) return false;
    if (typeof el.className === 'string' && /disabled|is-disabled|btn-disabled/.test(el.className)) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  };
  const pickFrom = (el) => {
    if (!el || !visible(el)) return null;
    let hit = el;
    if (!BUY.some((k) => clean(hit.innerText).includes(k))) {
      for (const c of hit.querySelectorAll('a,button,div,span')) {
        const t = clean(c.innerText);
        if (t && t.length <= 12 && BUY.some((k) => t.includes(k)) && visible(c)) { hit = c; break; }
      }
    }
    const t = clean(hit.innerText);
    if (!t || t.length > 12 || !BUY.some((k) => t.includes(k)) || !visible(hit)) return null;
    hit.scrollIntoView({ block: 'center', inline: 'center' });
    const r = hit.getBoundingClientRect();
    return { label: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const NEED = ${needText ? 'true' : 'false'};
  let buy = null;
  const anchor = document.getElementById('prd-botnav-rightbtn');
  if (anchor) {
    buy = pickFrom(anchor);
    if (!buy && !NEED) return { buy: null, lite: true }; // 锁定态：不读全文，极轻一轮
  }
  const text = document.body ? document.body.innerText : '';
  if (!buy && BUY.some((k) => text.includes(k))) {
    const hits = [];
    for (const el of document.querySelectorAll('a,button,div,span')) {
      const t = clean(el.innerText);
      if (!t || t.length > 12) continue;
      if (!BUY.some((k) => t.includes(k))) continue;
      if (el.tagName === 'A' && el.querySelector('a')) continue;
      hits.push(el);
    }
    const kwOrder = (t) => BUY.findIndex((k) => t.includes(k));
    const depth = (e) => { let d = 0; for (let n = e; n && n !== document.body; n = n.parentElement) d++; return d; };
    const cands = hits
      .filter(visible)
      .sort((a, b) => {
        const ta = clean(a.innerText), tb = clean(b.innerText);
        const ea = BUY.some((k) => ta === k) ? 0 : 1, eb = BUY.some((k) => tb === k) ? 0 : 1;
        if (ea !== eb) return ea - eb;
        if (ea === 0 && kwOrder(ta) !== kwOrder(tb)) return kwOrder(ta) - kwOrder(tb);
        const ga = (a.tagName === 'BUTTON' || a.tagName === 'A') ? 0 : 1;
        const gb = (b.tagName === 'BUTTON' || b.tagName === 'A') ? 0 : 1;
        if (ga !== gb) return ga - gb;
        if (ta.length !== tb.length) return ta.length - tb.length;
        return depth(b) - depth(a);
      });
    buy = pickFrom(cands[0]);
  }
  return {
    buy,
    lite: false,
    oos: /暂时缺货|售罄|无货|补货中/.test(text),
    // 风控判定跳过登录/账号页（2026-10-07 误杀实测）：登录页满屏"短信验证码/滑块"字样，
    // 那是登录流程的一部分；真正的风控拦在 vmall 页面上，域名判断即可区分。
    challenge: !/(^|\.)id1\.cloud\.huawei\.com$/i.test(location.hostname) && !/login|passport/i.test(location.pathname)
      && /验证码|安全验证|滑块|拖动滑块|完成拼图/.test(text),
    notLogin: /请登录|立即登录|账号登录/.test(text),
    yixuan: (text.match(/已选[：:][^\\n]{1,60}/) || [''])[0],
  };
})()`;

const extractPrdId = (url) => (String(url).match(/prdId=(\d+)/) || [])[1] || null;

// 登录态判据（readLoginState）已抽到 cdp-core.mjs，与体检共用同一份实现。
// 为什么不用页面文案：见 cdp-core.mjs 里 SESSION_COOKIE_NAMES 上方的实测取证。

// 服务器时钟校准与官方接口探测已抽到 vmall-api.mjs（体检脚本共用同一份解析）。

// ── 槽位绑定 vs 页面已选核对 ──
// URL 里的 sbomCode 对，不等于页面选中的规格就是它（页面可能用默认/缓存规格）。
// 2026-10-07 用户实测：两槽位派发后页面选了同一个规格（控制台生成 bug，已修）。
// 这里是驱动侧保险丝：页面"已选：X·Y"必须包含槽位规格的全部属性值，否则拒绝抢。
let CATALOG = null;
/** 跨商品预热留下的确认页草稿（key = "port:tabId"）——收尾统一关，绝不误当成果页 */
const warmupConfirmTabs = new Map();
function catalogSku(prdId, sbomCode) {
  try {
    if (!CATALOG) CATALOG = JSON.parse(readFileSync(new URL('../../data/grab/huawei.catalog.json', import.meta.url), 'utf8'));
    const prod = (CATALOG.products || []).find((p) => String(p.prdId) === String(prdId));
    return ((prod && prod.skus) || []).find((s) => String(s.sbomCode) === String(sbomCode)) || null;
  } catch { return null; }
}
/** 返回 false=一致；null=页面没有"已选"行无法判断；对象=不一致 { got, missing } */
function skuPageMismatch(text, prdId, sbomCode) {
  const sku = catalogSku(prdId, sbomCode);
  if (!sku || !sku.attrs) return null;
  const vals = Object.values(sku.attrs).map((v) => String(v || '').replace(/\s+/g, '')).filter(Boolean);
  if (!vals.length) return null;
  const m = String(text || '').match(/已选[：:]\s*([^\n]{1,60})/);
  if (!m) return null;
  const got = m[1].replace(/\s+/g, '');
  const missing = vals.filter((v) => !got.includes(v));
  return missing.length ? { got: m[1].trim(), missing } : false;
}

async function makeReporter(config, slot, stateRef) {
  return async function report(payload) {
    const record = {
      at: new Date().toISOString(),
      profileId: slot.id,
      pageUrl: stateRef.last.url,
      userAgent: stateRef.ua,
      ...payload,
    };
    try {
      const res = await fetch(`${BRIDGE}/api/results/${PLATFORM}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
      });
      stateRef.log(`结果已回传：${record.outcome}${res.ok ? '' : `（HTTP ${res.status}）`}`, res.ok ? '' : 'warn');
    } catch (e) {
      stateRef.log(`结果回传失败（${e.message}）`, 'warn');
    }
  };
}

/** 单槽位完整流程。返回 { ok, outcome }。 */
async function runSlot(slot, config) {
  const log = logFor(slot.id);
  const stateRef = { last: { url: '', title: '', text: '' }, ua: '', log };
  const report = await makeReporter(config, slot, stateRef);
  const dryRun = config.dryRun !== false;
  // 真场取证黑匣子（见 makeEvidence 注释）：早于一切动作创建，闸门拦截也留痕
  const E = makeEvidence(slot.id);
  E.ev('SLOT_START', `prdId=${slot.prdId} sbomCode=${slot.sbomCode} dryRun=${dryRun} mode=${config.mode || 'rush'}`);

  // ── 白名单闸门（必须在任何浏览器动作之前）──
  // 商品列表 = huawei.config.json 的 products[]。不在列表里的商品，脚本一律不碰：
  // 不开窗口、不加载页面、不点击、不改写任何响应。
  // 槽位文件是手写的，很容易写下没配过的 prdId 或忘了勾选的 sbomCode，
  // 以前 `|| {}` 会静默兜底继续抢——那等于对没登记的商品下真实订单。
  const product = (config.products || []).find((p) => extractPrdId(p.url) === String(slot.prdId));
  if (!product) {
    const list = (config.products || []).map((p) => `${p.id || '?'}(prdId=${extractPrdId(p.url) || '?'})`).join('、') || '（空）';
    const msg = `槽位 ${slot.id} 的商品 prdId=${slot.prdId} 不在商品列表里，本槽位不做任何操作。商品列表：${list}`;
    log(`⛔ ${msg}`, 'warn');
    await report({ outcome: 'SKIPPED_NOT_IN_LIST', resultCode: 'PRODUCT_NOT_IN_LIST', message: msg });
    return { ok: false, outcome: 'SKIPPED_NOT_IN_LIST' };
  }
  if (product.enabled === false) {
    const msg = `商品「${product.id || slot.prdId}」在商品列表里已停用（enabled=false），本槽位不做任何操作`;
    log(`⛔ ${msg}`, 'warn');
    await report({ outcome: 'SKIPPED_DISABLED', resultCode: 'PRODUCT_DISABLED', message: msg, targetId: product.id });
    return { ok: false, outcome: 'SKIPPED_DISABLED' };
  }
  // SKU 也过一遍列表：skuIds 非空 = 只抢勾选过的规格；留空 = 该商品全部规格都算目标。
  const wantSboms = Array.isArray(product.skuIds) ? product.skuIds.map(String).filter(Boolean) : [];
  if (wantSboms.length && !wantSboms.includes(String(slot.sbomCode))) {
    const msg = `规格 ${slot.sbomCode} 不在商品「${product.id || slot.prdId}」勾选的规格里（已勾选：${wantSboms.join('、')}），本槽位不做任何操作`;
    log(`⛔ ${msg}`, 'warn');
    await report({ outcome: 'SKIPPED_NOT_IN_LIST', resultCode: 'SKU_NOT_IN_LIST', message: msg, targetId: product.id });
    return { ok: false, outcome: 'SKIPPED_NOT_IN_LIST' };
  }

  const saleAtIso = slot.saleAt || product.saleAt || null;
  const saleAtMs = saleAtIso ? new Date(saleAtIso).getTime() : null;
  const targetUrl = `https://item.vmall.com/product/comdetail/index.html?prdId=${slot.prdId}&sbomCode=${slot.sbomCode}`;
  const port = slot.port;

  log(`槽位启动。SKU=${slot.sbomCode}  模式=${dryRun ? '演练（dryRun）' : '真抢（会提交订单！）'}${saleAtIso ? `  开售=${saleAtIso}` : '  开售=看到可买就抢'}`);

  await ensureSlotWindow(slot, targetUrl, log);

  const tab = await waitTab(port, slot.prdId, slot.sbomCode);
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // Network 域：登录态改为读浏览器凭据（getAllCookies 需要本域启用）。
  await cdp.send('Network.enable', { maxResourceBufferSize: 10 * 1024 * 1024 }).catch(() => {});
  // 真场取证：给商品页会话装网络记录（黑匣子见 makeEvidence 注释）
  attachNetRecorder(cdp, E);
  // 每槽位方案覆盖（2026-10-08 三方案实验用）：slot.triggerMode / slot.intercept
  // 可覆盖全局配置——一个窗口跑纯点击、一个跑大提前量、一个跑默认，互不影响。
  const planTriggerMode = slot.triggerMode || config.triggerMode || 'click';
  const planIntercept = { ...config, intercept: { ...((config.intercept) || {}), ...((slot.intercept) || {}) } };
  E.ev('PLAN', `triggerMode=${planTriggerMode} leadMs=${planIntercept.intercept.leadMs ?? 300} intercept.enabled=${planIntercept.intercept.enabled !== false}`);
  // B 方案：Fetch 域响应拦截（R1 抢购信息提前解锁 / R2 排队页留证）。
  // 失败不阻断抢购：icStat = null 即未启用，行为与旧版完全一致。
  let icStat = null;
  try { icStat = await installInterception(cdp, planIntercept, log); }
  catch (e) { log(`拦截安装失败（${e.message}），本槽位不启用改写。`, 'warn'); }
  stateRef.ua = await cdp.eval('navigator.userAgent');

  // R3：确认订单页零延迟信号。确认页是点击后 window.open 新开的标签，
  // 浏览器级 Target 事件让它在出现的瞬间（而非轮询的下一拍）被感知。
  const confirmSignal = { targetId: null, waiters: [] };
  const waitConfirmSignal = (ms) => new Promise((resolve) => {
    const w = () => resolve(true);
    confirmSignal.waiters.push(w);
    setTimeout(() => {
      const i = confirmSignal.waiters.indexOf(w);
      if (i >= 0) confirmSignal.waiters.splice(i, 1);
      resolve(false);
    }, ms);
  });
  let tabBaseline = new Set(); // 点击前已有的标签 = 旧标签；之后新出现的确认页才是成果

  // 浏览器级连接（保持常开）：① 窗口拉起并最大化（复用的窗口可能被最小化/缩成
  // 半屏；Chrome 规矩：最小化状态下直接设 maximized 会被忽略，要先 normal 再
  // maximized）；② 订阅 Target 事件给 R3 供信号。
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { bws.addEventListener('open', res, { once: true }); bws.addEventListener('error', rej, { once: true }); });
    let bid = 0;
    const bpend = new Map();
    const bEv = new Map();
    bws.addEventListener('message', (ev2) => {
      const m = JSON.parse(ev2.data);
      if (m.id && bpend.has(m.id)) { bpend.get(m.id)(m.result); bpend.delete(m.id); }
      else if (m.method) for (const cb of bEv.get(m.method) || []) { try { cb(m.params); } catch { /* 事件回调异常不影响主流程 */ } }
    });
    const bsend = (method, params = {}) => new Promise((res) => {
      const i = ++bid; bpend.set(i, res); bws.send(JSON.stringify({ id: i, method, params }));
    });
    const win = await bsend('Browser.getWindowForTarget', { targetId: tab.id });
    if (win.bounds?.windowState !== 'maximized') {
      await bsend('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      await sleep(200);
      await bsend('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'maximized' } });
      log('专用窗口已最大化');
    }
    await bsend('Target.setDiscoverTargets', { discover: true });
    const noteTarget = (p) => {
      const t = p.targetInfo || {};
      if (t.type !== 'page') return;
      if (!/orderConfirm|确认订单/.test((t.url || '') + (t.title || ''))) return;
      confirmSignal.targetId = t.targetId;
      const ws = confirmSignal.waiters.splice(0);
      for (const w of ws) w();
    };
    for (const m of ['Target.targetCreated', 'Target.targetInfoChanged']) {
      if (!bEv.has(m)) bEv.set(m, new Set());
      bEv.get(m).add(noteTarget);
    }
  } catch { /* 最大化/事件订阅失败不影响抢购，确认页发现退回轮询兜底 */ }

  // 关掉多余的 comdetail 标签（历史探测/重试残留），窗口里只留本槽位的工作标签
  for (const t of await listTabs(port)) {
    if (t.id !== tab.id && /comdetail/.test(t.url)) {
      await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
    }
  }

  async function state() {
    stateRef.last = await cdp.eval(stateExpr);
    return stateRef.last;
  }
  /** 等页面加载完 + 页头水合（页头会先短暂显示“请登录”再变回登录态，别误判） */
  async function waitPageReady(settleMs = 2500) {
    for (let i = 0; i < 80; i++) {
      await state();
      if (stateRef.last.ready === 'complete' && stateRef.last.text) break;
      await sleep(500);
    }
    await sleep(settleMs);
    await state();
  }

  await waitPageReady();
  const onRightSku = stateRef.last.url.includes(String(slot.prdId))
    && (!slot.sbomCode || stateRef.last.url.includes(slot.sbomCode));
  if (!onRightSku) {
    log('当前不在槽位绑定的 SKU 页，导航过去…');
    await cdp.send('Page.navigate', { url: targetUrl });
    await waitPageReady();
  }
  // 页面"已选"规格核对（防静默抢错规格，详见 skuPageMismatch 注释）。
  // ★ 2026-10-08：回流扫描按设计"不切回"，跑完页面常停在清单里的其他规格上——
  //   再次派发遇到不一致时先刷新拉回绑定规格（页面刷新遵循 URL 的 sbomCode），
  //   拉不回才停车。绝不变更规格、绝不抢错规格。
  {
    let mm = skuPageMismatch(stateRef.last.text, slot.prdId, slot.sbomCode);
    if (mm) {
      log(`页面已选「${mm.got}」≠ 绑定规格（缺 ${mm.missing.join('/')}）——刷新拉回绑定规格…`, 'warn');
      await cdp.send('Page.navigate', { url: targetUrl });
      await waitPageReady(800);
      mm = skuPageMismatch(stateRef.last.text, slot.prdId, slot.sbomCode);
      if (mm) {
        log(`刷新后已选仍是「${mm.got}」，停止，不抢错规格。`, 'err');
        await report({ outcome: 'FAILED', resultCode: 'WRONG_SKU', message: `页面已选「${mm.got}」≠ 槽位绑定规格`, evidence: ev(stateRef) });
        return { ok: false, outcome: 'WRONG_SKU' };
      }
      log('已拉回绑定规格。', 'ok');
    }
  }

  // 清掉历史演练/重试留下的确认订单页标签（本次点击会弹新的）
  for (const t of await listTabs(port)) {
    if (/orderConfirm/.test(t.url) && t.id !== tab.id) {
      await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
    }
  }

  // ── 风控 & 登录 ──
  let st = await state();
  if (looksLikeRiskControl(st)) {
    log('检测到风控验证，按设计停下等人，不做任何绕过。', 'err');
    await report({ outcome: 'WAITING_HUMAN', resultCode: 'CAPTCHA', message: '页面出现验证/风控，脚本已停止', humanAction: '请人工完成验证后重跑', evidence: ev(stateRef) });
    return { ok: false, outcome: 'WAITING_HUMAN' };
  }
/**
   * 登录是否就绪。判据顺序（2026-10-07 定稿）：
   *   ① probeLoginApi —— 问页面自己的 queryUserInfo 接口（**最权威**：
   *      能识别"Cookie 还残留但服务端会话已死"这种情况）
   *   ② readLoginState —— 退回浏览器凭据（接口问不出来时）
   */
  async function loginSettled() {
    const api = await probeLoginApi(cdp);
    if (api.loggedIn !== null) {
      log(api.loggedIn ? `登录态：已登录（${api.evidence}）` : `登录态：未登录（${api.evidence}）`, api.loggedIn ? 'ok' : 'warn');
      return api.loggedIn;
    }
    log(`${api.evidence}，退回浏览器凭据判断。`, 'warn');
    const ck = await readLoginState(cdp);
    if (ck.loggedIn !== null) {
      log(ck.loggedIn ? `登录态：已登录（${ck.evidence}）` : `登录态：未登录（${ck.evidence}）`, ck.loggedIn ? 'ok' : 'warn');
      return ck.loggedIn;
    }
    // 两条都问不出来 → 退到页面文案（旧行为，双拍确认防页头水合期误判）
    log(`${ck.evidence}，退回页面文案判断。`, 'warn');
    if (NOT_LOGIN.test((await state()).text)) return false;
    await sleep(1500);
    return !NOT_LOGIN.test((await state()).text);
  }
  /**
   * 登录等待流程：等人登录。默认最多等 15 分钟；值守阶段传入开售时刻，
   * 会一直守到开售——用户随时登回来都自动续上，不放弃。
   *
   * 判据：凭据（便宜，每 2 秒看一次）一出现就去问接口确认；没出现则每 8 秒
   * 主动问一次接口（用户在别的标签页登录也会被及时发现）。
   * 接口问不出来时，浏览器凭据在位也算登录成功，避免网络异常死等。
   */
  async function waitLoginFlow(deadlineMs) {
    log('未登录。请在专用窗口里登录华为账号（点“请登录”），登录后自动继续。', 'warn');
    await report({ outcome: 'WAITING_HUMAN', resultCode: 'NEEDS_LOGIN', message: '等待登录', humanAction: '请在专用窗口完成登录（登录一次以后长期有效）' });
    const deadline = deadlineMs || Date.now() + 15 * 60 * 1000;
    let lastApi = 0;
    while (Date.now() < deadline) {
      await sleep(2000);
      const ck = await readLoginState(cdp);
      const dueForApi = Date.now() - lastApi >= 8000;
      if (ck.loggedIn !== true && !dueForApi) continue;
      lastApi = Date.now();
      const api = await probeLoginApi(cdp);
      // ★ 页面正在跳转时（短信/滑块提交瞬间）探针会抛 "Inspected target navigated
      // or closed"——此时不能拿 Cookie 宣布成功：2026-10-07 实测，用户还在登录页
      // 输验证码，流程就带着"已登录"跑走了。导航中的探测视为"未知"，等下一轮再问。
      const navigating = api.loggedIn === null && /navigated or closed/i.test(api.evidence || '');
      const done = api.loggedIn === true || (!navigating && api.loggedIn === null && ck.loggedIn === true);
      if (done) {
        log(`已检测到登录（${api.evidence || ck.evidence}）`, 'ok');
        await state();
        if (!stateRef.last.url.includes(String(slot.prdId))) {
          await cdp.send('Page.navigate', { url: targetUrl });
          await waitPageReady();
        }
        return;
      }
      if (api.loggedIn === false && ck.loggedIn === true) {
        log(`浏览器还留着登录 Cookie，但服务端说未登录（${api.evidence}）——继续等你重新登录。`, 'warn');
      }
    }
    throw new Error('等待登录超时，脚本退出');
  }
  if (!(await loginSettled())) {
    await waitLoginFlow();
    log('检测到登录成功，继续', 'ok');
  }

  // ── 价格上限 ──
  if (product.maxPrice != null) {
    const price = await cdp.eval(`(() => {
      const scope = document.querySelector('#prd-detail') || document.body;
      let best = null;
      for (const el of scope.querySelectorAll('*')) {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 12 || el.children.length > 2) continue;
        const m = t.match(/^[¥￥]?\\s*([\\d,]{4,}(?:\\.\\d{1,2})?)$/);
        if (!m) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
        if (!best || fs > best.fs) best = { fs, v: parseFloat(m[1].replace(/,/g, '')) };
      }
      return best ? best.v : null;
    })()`);
    if (price == null) log('未能读到可信价格，价格上限校验本次跳过，请人工确认。', 'warn');
    else if (price > product.maxPrice) {
      log(`页面价格 ¥${price} 高于上限 ¥${product.maxPrice}，不执行。`, 'err');
      await report({ outcome: 'FAILED', resultCode: 'PRICE_EXCEEDED', message: `价格 ¥${price} 超过上限 ¥${product.maxPrice}`, amount: price });
      return { ok: false, outcome: 'PRICE_EXCEEDED' };
    } else log(`页面价格 ¥${price}，上限 ¥${product.maxPrice}`);
  } else {
    log('价格上限：不限');
  }

  // ── 校时 + 开售时刻：一律以华为服务器钟为准 ──
  const limits = config.limits || {};
  const hotMs = limits.pollIntervalHotMs ?? 150;
  const slowMs = limits.pollIntervalMs ?? 3000;
  const hotWindowMs = limits.hotWindowMs ?? 10000;
  const earlyMs = (config.earlyEnterSec ?? 90) * 1000;
  const fuseDelayMs = limits.fuseRefreshDelayMs ?? 1000;
  // 内部喊话节奏（毫秒）：走捷径调页面内部入口的最低间隔。
  // 2026-10-08 从写死 300 改为可调（控制台「抢购行为 → 内部喊话节奏」）；默认 50 = 与热窗轮询同速。
  const internalFireMs = limits.internalFireMs ?? 50;
  const monitorCfg = config.monitor || {};
  const monitorEnabled = monitorCfg.enabled === true;
  // 跨商品预热配置：enabled（默认 true）/ beforeSec 兼容保留
  const warmupCfg = config.warmup || {};

  /* ── 会话保活（2026-10-08 根因实验定稿）─────────────────────────────────
   * 实测：sid/hwid_cas_sid 这对登录凭据 Cookie 本身有 400 天有效期，"登录存活短"
   * 的真凶是 vmall 侧的滚动短命 Cookie——cluster（负载均衡路由粘性，15 分钟窗口）、
   * cartId（数小时）等。值守期间长时间零请求 → 它们过期 → 下一次请求被路由到
   * 别的后端节点 → 会话对不上 = "掉线"（Cookie 还在但服务端认不得）。
   * 对策：每 8 分钟（limits.sessionPingMs 可调）从页面上下文发一次轻请求：
   * ① www.vmall.com（实测会把 cluster 续期出新的 15 分钟窗口）；② queryUserInfo
   * 顺带验活（'out' = 服务端会话真没了 → 走等登录流程）。
   */
  const sessionPingMs = limits.sessionPingMs ?? 8 * 60 * 1000;
  let lastSessionPingAt = 0;
  // 每次保活后重摇下一次的间隔（±20%）：固定 8 分钟整也是节拍指纹。
  // 上限 9.6 分钟，离 cluster 15 分钟滚动窗口仍有余量。
  let sessionPingNextGapMs = sessionPingMs;
  /** 一次保活探测。返回 'ok'｜'out'（服务端会话没了）｜'err'/null（网络抖动，不当掉线） */
  async function sessionPing(force = false) {
    if (!force && Date.now() - lastSessionPingAt < sessionPingNextGapMs) return null;
    lastSessionPingAt = Date.now();
    sessionPingNextGapMs = Math.round(sessionPingMs * (0.8 + Math.random() * 0.4));
    const r = await cdp.eval(`(async () => {
      try { await fetch('https://www.vmall.com/', { credentials: 'include', mode: 'no-cors' }); } catch (e) {}
      try {
        const r = await fetch('https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN', { credentials: 'include' });
        return (await r.text()).slice(0, 300);
      } catch (e) { return 'err'; }
    })()`).catch(() => 'err');
    // 判定挪到宿主侧（judgeVmallLoginBody 抗 vmall 挖 s 混淆，原文正则会把已登录误判成掉线）
    const verdict = r === 'err' ? 'err' : judgeVmallLoginBody(r);
    if (verdict === 'ok') log('会话保活：已续命（vmall 轻请求 + 登录接口探测正常）。');
    if (verdict === null && r !== 'err') log(`会话保活：响应读不懂（不当掉线）：${String(r).replace(/\s+/g, ' ').slice(0, 80)}`, 'warn');
    // 黑匣子也要有保活记录：复盘报告靠 events.jsonl 汇总，只写驱动日志会丢线索
    if (verdict !== 'err' || r === 'err') E.ev('SESSION_PING', verdict === 'ok' ? '已续命' : verdict === 'out' ? '服务端会话已失效，等人重登' : '探测出错（网络抖动，不算掉线）');
    return verdict;
  }

  /* SKU 扫描/回流监控共用的绑定信息（必须在下方 mode 检查之前初始化，避免 TDZ）
   * scanTargetList：回流随机切换的目标清单（monitorCfg.scanSboms > 勾选规格 > 全部规格）。
   * scanTargets 是函数声明（块内提升），这里可直接调用；它只依赖上方已声明的量。 */
  const scanTargetList = scanTargets();
  const deadlineRef = { now: 0 }; // 回流监控的截止时刻（fireOnScan 里等登录要用）


  // 开售时刻（服务器钟口径）：官方接口 startTime 优先，配置 saleAt 兜底
  let serverT0Ms = saleAtMs;
  // ignoreApiStart（槽位/商品均可设）：演练用——无视官方接口的开售时刻，强制用配置的
  // saleAt。不然纯定时商品永远被官方 10:08 压着，人工设时刻的演练根本跑不起来。
  const ignoreApiStart = slot.ignoreApiStart === true || product.ignoreApiStart === true;
  const apiStart = ignoreApiStart || !slot.sbomCode ? null : await fetchSaleStartServerMs(slot.sbomCode, stateRef.ua);
  if (apiStart && apiStart > Date.now() - 60000) {
    if (saleAtMs && Math.abs(apiStart - saleAtMs) > 10000) {
      log(`注意：官方接口开售时刻与配置 saleAt 不一致（接口 ${fmtLocal(apiStart)}，配置 ${saleAtIso}），以官方接口为准。`, 'warn');
    } else if (!saleAtMs) {
      log(`官方接口给出开售时刻：${fmtLocal(apiStart)}（配置没填 saleAt，自动采用）`);
    }
    serverT0Ms = apiStart;
  } else if (apiStart) {
    log('官方接口的开售时刻已是过去时（现货/已开售），忽略。');
  } else if (saleAtMs) {
    log('官方接口没查到该 SKU 的开售场次，使用配置的 saleAt。');
  }

  let clockOffsetMs = 0;
  let triggerLocalMs = null;
  if (serverT0Ms) {
    try {
      const clock = await calibrateClock(stateRef.ua, log, limits.clockSyncSamples ?? 5);
      clockOffsetMs = clock ? clock.offsetMs : 0;
    } catch (e) {
      log(`校时失败（${e.message}），按本地钟执行`, 'warn');
    }
    // 本地钟上的触发点：本地 Date.now() 走到它时，服务器钟正好是 serverT0Ms
    triggerLocalMs = serverT0Ms + clockOffsetMs;
    E.state.t0Server = serverT0Ms; E.state.offset = clockOffsetMs;
    E.ev('CLOCK_T0', `serverT0=${fmtLocal(serverT0Ms)} offset=${clockOffsetMs}ms`);
    log(`开售触发点（换算到本地钟）：${fmtLocal(triggerLocalMs)}`);
  }

  // 现货+定时：T0-60s 预开确认页，T0 只提交（热循环也要用）。
  // ★ 2026-10-08 修复：声明必须放在首次使用之前——原声明在下方热循环区，
  //   预开块上移后（19:50 修复）触发 TDZ 崩溃：ReferenceError: Cannot access
  //   'preOpenedConfirm' before initialization（tsc TS2448 ×4 @ 651/654/659/661）。
  let preOpenedConfirm = false;

  if (triggerLocalMs && Date.now() < triggerLocalMs) {
    const ahead = triggerLocalMs - Date.now();
    if (ahead > earlyMs) {
      log(`距开售还有 ${Math.round(ahead / 1000)} 秒，值守等待：每 5 分钟做一次轻操作保温（移动+滚动），每 30 秒查一次登录。`);
      let lastAct = Date.now();
      let lightActGapMs = 5 * 60 * 1000; // 保温间隔每次重摇（4~7 分钟），固定 5 分钟整=节拍指纹
      while (Date.now() < triggerLocalMs - earlyMs) {
        await sleep(30000);
        const s = await state();
        // 会话保活：值守里最长的"零请求"空窗就是登录杀手（见 sessionPing 注释）
        const ping = await sessionPing();
        if (ping === 'out') {
          log('保活探测发现登录已失效（服务端会话不在了）。等你重新登录，脚本继续值守不放弃。', 'warn');
          await report({
            outcome: 'WAITING_HUMAN', resultCode: 'NEEDS_LOGIN',
            message: '值守期间登录失效（脚本继续值守，不放弃）',
            humanAction: '随时在专用窗口重新登录即可，脚本自动续上',
          });
          await waitLoginFlow(triggerLocalMs);
          log('登录恢复，继续值守', 'ok');
        }
        if (looksLikeRiskControl(s)) {
          log('值守期间出现风控验证，停止并转人工。', 'err');
          await report({
            outcome: 'WAITING_HUMAN', resultCode: 'CAPTCHA',
            message: '值守等待中出现风控验证', humanAction: '请人工处理后重跑',
            evidence: ev(stateRef),
          });
          return { ok: false, outcome: 'WAITING_HUMAN' };
        }
        if (ON_LOGIN_PAGE.test(s.url + ' ' + s.title) || NOT_LOGIN.test(s.text)) {
          // 先看浏览器凭据：凭据在 → 只是页面文案抖动（页头水合/缓存），别冤枉
          const lr = await readLoginState(cdp);
          if (lr.loggedIn === true) {
            log(`页面文案像掉线，但登录凭据仍在（${lr.evidence}），判定为文案抖动，继续值守。`);
          } else {
            // 凭据缺失或读不到 → 刷新一次确认；仍掉线就报备并守到开售
            log('值守期间疑似登录掉线，刷新确认…', 'warn');
            await cdp.send('Page.navigate', { url: targetUrl });
            await waitPageReady(800);
            const lr2 = await readLoginState(cdp);
            const stillOut = lr2.loggedIn === false
              || (lr2.loggedIn === null && (ON_LOGIN_PAGE.test(stateRef.last.url + ' ' + stateRef.last.title) || NOT_LOGIN.test(stateRef.last.text)));
            if (stillOut) {
              log(`确认登录掉线（${lr2.evidence}）：脚本继续值守到开售，你随时登回来都自动续上。`, 'warn');
              await report({
                outcome: 'WAITING_HUMAN', resultCode: 'NEEDS_LOGIN',
                message: '值守期间登录掉线（脚本继续值守，不放弃）',
                humanAction: '随时在专用窗口重新登录即可，脚本自动续上',
              });
              await waitLoginFlow(triggerLocalMs);
              log('登录恢复，继续值守', 'ok');
            } else {
              log('刷新后登录正常（刚才是页面状态旧了）。', 'ok');
            }
          }
        }
        if (Date.now() - lastAct > lightActGapMs) {
          await lightActivity(cdp);
          lastAct = Date.now();
          lightActGapMs = (4 + Math.random() * 3) * 60 * 1000;
          log(`已做保温操作（移动鼠标+上下滚动，真实输入事件），下次约 ${Math.round(lightActGapMs / 60000 * 10) / 10} 分钟后`);
        }
        // 值守期间页面"已选"被人手动切走过 → 拉回绑定的规格（槽位绑定是唯一契约）
        const mmw = skuPageMismatch(s.text, slot.prdId, slot.sbomCode);
        if (mmw) {
          log(`值守期间页面已选变成「${mmw.got}」（可能被手动切过），导航回绑定的规格。`, 'warn');
          await cdp.send('Page.navigate', { url: targetUrl });
          await waitPageReady(800);
        }
      }
    }
    log('就位：刷新商品页（拿最新状态）…');
    await cdp.send('Page.navigate', { url: targetUrl });
    await waitPageReady(1500);
    // ★ 预开确认订单页——必须在 sleepUntil(T0-2s) 之前！2026-10-07 踩坑：放在睡眠后，
    //    "距 T0 > 65s"的条件永远不成立，预开从未执行（19:45 轮实测）。
    //    现货+定时：现在就开确认页（草稿，不提交），T0 只提交——把"立即购买→确认页
    //    加载"的 3~5 秒挪出关键路径（成熟秒杀项目标准做法）。自门控：真定时商品按钮
    //    锁定，开不出确认页 → 自动走回常规流程，对实战零影响。
    if (Date.now() < triggerLocalMs - 65 * 1000) {
      log('定时场景：T0-60s 预开确认订单页（草稿，不提交）——成功则 T0 直接提交。');
      const pick = await pickInternalEntry().catch(() => null);
      if (pick && pick.s === 'OK') {
        await cdp.send('Runtime.callFunctionOn', {
          objectId: pick.yoId,
          functionDeclaration: 'function(){ try { this(); } catch (e) {} }',
          returnByValue: true, userGesture: true,
        }).catch(() => {});
      } else {
        const pos0 = await cdp.eval(buyExpr(true)).catch(() => null);
        if (pos0) await trustedClick(cdp, pos0.x, pos0.y);
      }
      for (let i = 0; i < 20 && !preOpenedConfirm; i++) {
        await sleep(500);
        const ts = await listTabs(port).catch(() => []);
        if (ts.some((t) => /orderConfirm/.test(t.url || ''))) { preOpenedConfirm = true; break; }
        // 按钮迟迟没解锁（真定时商品）→ 别傻等，放弃预开走常规流程
        const st0 = await state().catch(() => null);
        if (st0 && st0.text && !/立即购买|立即申购|马上抢|立即抢购/.test(st0.text) && /开始|待开售|预售|开售/.test(st0.text)) break;
      }
      log(preOpenedConfirm
        ? '✔ 确认订单页已预开（草稿就绪），T0 只提交。'
        : '预开确认页未成功（按钮未解锁或页面未出）——走常规流程。', preOpenedConfirm ? 'ok' : 'warn');
      E.ev('PREOPEN', preOpenedConfirm ? 'ok' : 'fail');
    }
    // ── 跨商品预热（2026-10-08 实测验证，verify-warm-cross.mjs）─────────────
    // 纯定时商品按钮锁定、开不出自己的确认页 → 用另一个现货商品的确认页把
    // buy.vmall.com / www.vmall.com 的确认页静态资源焐热。实测：清缓存后预热商品
    // 挂载 852ms、紧随其后的目标商品挂载 501ms（对照冷启动 ~5.8s）。T0 点开目标
    // 确认页时直接吃到热缓存。预热确认页只是草稿：不提交、不关（关了缓存也在），
    // 且在下方 tabBaseline 捕获之前开好 → 绝不会被误当成购买成果页。
    if (warmupCfg.enabled !== false && triggerLocalMs && !preOpenedConfirm
      && Date.now() < triggerLocalMs - 45 * 1000) {
      // 任何预热失败都不许影响抢购主流程；截止 T0-15s——宁可少焐一会儿也不吃热窗
      try { await openWarmupConfirm(triggerLocalMs - 15 * 1000); }
      catch (e) { log(`跨商品预热异常（${e.message}），跳过，不影响抢购。`, 'warn'); }
    }
    const toHot = triggerLocalMs - hotWindowMs - Date.now();
    if (toHot > 0) {
      log(`已就位，${Math.round(toHot / 1000)} 秒后进入高频监听。`);
      await sleepUntil(triggerLocalMs - hotWindowMs);
    }
    // T0-10s 精校（与默认热窗 10s 对齐，bytehola 同款做法）
    if (Date.now() < triggerLocalMs - 500) {
      try {
        const fine = await calibrateClock(stateRef.ua, log, limits.clockSyncFineSamples ?? 3);
        if (fine) {
          clockOffsetMs = fine.offsetMs;
          triggerLocalMs = serverT0Ms + clockOffsetMs;
        }
      } catch { /* 沿用粗校结果 */ }
    }
    // ★ 方案B专用（slot.t0SpecSwitch，2026-10-08 证据定案）：T0-1.5s 主动"切走→切回"
    // 目标规格，强制页面重拉目标 SKU 的内存状态——10-08 真场证实：内部入口读的是
    // 页面内存里的按钮状态，数据不新鲜调一万次也空转（出手窗口内零购买请求）。
    if (slot.t0SpecSwitch === true && scanTargetList.length >= 2 && Date.now() < triggerLocalMs - 500) {
      // ★ 连续快切（2026-10-08 用户定稿）：像人一样在 T0 前后不停来回切（每 ~0.5s 一个来回），
      // 每次落回目标规格都强制重拉内存状态并查按钮；按钮一亮立即出手。
      await sleepUntil(triggerLocalMs - 1200);
      const bound2 = catalogSku(slot.prdId, slot.sbomCode);
      const back2 = { sbomCode: String(slot.sbomCode), attrs: (bound2 && bound2.attrs) || {} };
      const others2 = scanTargetList.filter((t) => String(t.sbomCode) !== String(slot.sbomCode));
      const away2 = others2[Math.floor(Math.random() * others2.length)];
      log(`方案B·连续快切开始（${away2.sbomCode} ⇄ ${slot.sbomCode}，每来回约0.5s，按钮一亮就出手）…`);
      const canAct2 = () => !triggerLocalMs || Date.now() >= triggerLocalMs - Math.max(500, ((planIntercept.intercept || {}).leadMs || 300) + 200);
      for (let i = 0; Date.now() < triggerLocalMs + 4000; i++) {
        await switchToScanTarget(away2);
        await sleep(160);
        await switchToScanTarget(back2);
        await sleep(160);
        const fc = await cdp.eval(fastCheckExpr(false)).catch(() => null);
        if (i % 8 === 0) E.ev('T0_SWITCH_ROUND', `${i} buy=${!!(fc && fc.buy)}`);
        if (fc && fc.buy && canAct2()) {
          E.ev('T0_SWITCH_HIT', `round=${i} T0${(Date.now() - triggerLocalMs >= 0 ? '+' : '') + (Date.now() - triggerLocalMs)}ms`);
          log(`方案B·快切第 ${i} 个来回就看到「${fc.buy.label}」，直接出手！`, 'ok');
          const r = await clickBuyFlow(fc.buy);
          if (r && r.done) return r.done;
          if (r && r.relogin) { await waitLoginFlow(); continue; }
        }
      }
      E.ev('T0_SWITCH_END', 'window over');
      log('方案B·快切窗口结束（未见到可买），回落常规热循环。', 'warn');
    }
    // 开售前抓一帧官方状态接口：观察按钮到底靠什么解锁（页面自动变 or 要重新拉数据）
    const preT0 = slot.sbomCode ? await probeRushbuyInfo(slot.sbomCode, stateRef.ua) : null;
    if (preT0 && preT0.item) log(`开售前状态接口快照：${JSON.stringify(preT0.item).slice(0, 400)}`);
    log('进入高频监听，到点即点（到点本身不刷新页面）。', 'ok');
    E.ev('HOT_ENTER');
  } else if (triggerLocalMs) {
    log(`开售时刻 ${fmtLocal(triggerLocalMs)} 已过或就在眼前，直接开抢。`);
  }

  // ── 盯按钮 + 可信点击 ──
  const giveUpAt = triggerLocalMs
    ? triggerLocalMs + (limits.giveUpAfterMs ?? 30 * 60 * 1000)
    : Date.now() + (limits.giveUpAfterMs ?? 30 * 60 * 1000);
  // 购买点击重试次数：立即购买本身不会产生订单（不点提交订单就没交易），重试安全。
  // 提交订单另在 submitOrder() 里严格只点一次。
  const maxBuyRetry = limits.cdpBuyRetry ?? 3;
  let attempts = 0;
  let fuseUsed = false; // 保险丝：开售后按钮迟迟不出现就绕缓存强刷一次（仅一次）
  let sawOutOfStock = false; // 缺货转回流监控的路标
  if (!triggerLocalMs) log(`开始盯购买按钮（每 ${hotMs}ms 一查）。购买点击最多尝试 ${maxBuyRetry} 次。`);
  // 点击前的标签基线：之后新出现的确认订单页 = 本次点击的成果
  tabBaseline = new Set((await listTabs(port)).map((t) => t.id));

  // ── A 方案触发器（config.triggerMode = "internal" 才启用）──
  // 2026-10-07 走通版。华为改版后 2020 的全局对象路径（window.rush.business.doGoRush）
  // 已被移除；新入口在 React fiber 上——「立即购买」按钮（RNW Pressable）的 fiber
  // 向上 2 层，memoizedProps.onPress 是按钮业务回调；其闭包里 Yo() 是抢购分发函数、
  // E.goBuy() 是购买执行入口。三层入口均经现货 SKU 实测真实开出「确认订单」页：
  //   Yo     —— 无节流；未开售时静默无害，按钮文案一到「立即购买」即命中购买分支；
  //   goBuy  —— 直达购买执行（"buy_now_button","rushbuy"），跳过全部前置判断；
  //   onPress——保真最高，但有 1s 连点节流（Uo=1000），仅作后备口径记录。
  // ★ 关键：调用必须带 userGesture:true —— 确认页由 window.open 打开，无用户手势
  //   会被浏览器弹窗拦截器静默拦下（第一版"没走通"就栽在这里）。
  // 保真边界：只调页面自己的函数、页面自己组装下单请求（不构造/不重放 HTTP）。
  // 侦察/复现工具：verify/history/probe-rush-entry.mjs（--dump-closure / --fire）。
  let internalArmed = planTriggerMode === 'internal';
  let lastInternalAt = 0;
  let internalFiredAt = 0;
  let internalRound = 0;        // 调用轮计数（解锁后 Yo/goBuy 交替）
  let internalMissStreak = 0;   // 连续不可达/出错计数（日志用）
  let internalMissSince = 0;    // 连续不可达起始时刻（2026-10-08：失效判定改时间窗 10s，替代 200 次计数≈60s 的旧口径）
  let internalBusy = false;     // 上一轮没跑完就跳过（CDP 链别排队）
  let unlockSeen = false;       // 解锁信号（fastCheck 看到可点按钮）→ 之后 Yo/goBuy 交替
  let lastFireLogAt = 0;
  let lastConfirmScan = 0;
  const confirmHandled = new Set();
  if (internalArmed) log(`triggerMode=internal：热窗内每 ≥${Math.max(internalFireMs, hotMs)}ms 调一次内部入口（失败自动回落真点击）。`);

  /**
   * 跨商品预热：另开一个标签去「别的现货商品」点立即购买，把确认页开成草稿——
   * 目的是焐热 buy.vmall.com 的确认页静态资源，让目标商品 T0 开出的确认页直接走
   * 热加载（实测冷 ~5.8s → 热 ~0.5s）。重资源挂载完成后**立即关闭**草稿页（磁盘
   * 缓存不随标签关闭失效；挂着反而让账号名下多一张确认订单页，疑似干扰真实提交）。
   * 全程不动本槽位工作标签；warmupConfirmTabs 只兜底登记关闭失败的残留；绝不提交。
   */
  async function openWarmupConfirm(hardDeadlineMs = Date.now() + 120000) {
    const pidOf = (u) => (String(u || '').match(/prdId=(\d+)/) || [])[1] || null;
    // 候选来源（2026-10-08 按用户要求改）：warmup.url 指定哪个商品就用哪个（推荐配一个
    // 长期现货的商品，稳定可依赖）；没填才退回"商品列表里除本商品外的其他商品"。
    const warmUrl = String(warmupCfg.url || '').trim();
    let cands;
    if (warmUrl) {
      if (!pidOf(warmUrl)) {
        log(`跨商品预热：warmup.url 里读不到 prdId（${warmUrl.slice(0, 80)}），跳过预热。`, 'warn');
        return false;
      }
      cands = [{ id: '指定预热商品', url: warmUrl, skuIds: [(String(warmUrl).match(/sbomCode=(\d+)/) || [])[1] || ''], _fromUrl: true }];
    } else {
      cands = (config.products || []).filter((p) => p && p.enabled !== false
        && pidOf(p.url) && pidOf(p.url) !== String(slot.prdId));
    }
    log(`跨商品预热：开始（${warmUrl ? '用指定 URL' : `候选 ${cands.length} 个`}，开确认页草稿焐热结算页资源）…`);
    E.ev('WARMUP_START', warmUrl ? 'url' : `cands=${cands.length}`);
    for (const p of cands) {
      const prdId = pidOf(p.url);
      const sku = (Array.isArray(p.skuIds) && p.skuIds[0]) || (String(p.url).match(/sbomCode=(\d+)/) || [])[1] || '';
      const wurl = `https://item.vmall.com/product/comdetail/index.html?prdId=${prdId}${sku ? `&sbomCode=${sku}` : ''}`;
      let warmTab = null;
      try {
        // 新标签打开候选商品（新版 Chrome 要求 PUT；失败退回 GET）
        warmTab = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(wurl)}`, { method: 'PUT' })
          .then((r) => r.json()).catch(() => null)
          || await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(wurl)}`)
            .then((r) => r.json()).catch(() => null);
        if (!warmTab || !warmTab.id) continue;
        const wcdp = new CDP(warmTab.webSocketDebuggerUrl);
        await wcdp.connect();
        await wcdp.send('Runtime.enable');
        try {
          // 等按钮就绪：锚点文字一出来就判断——可买→继续；锁定/售罄→立刻换下一个
          let btnOk = null;
          let locked = false;
          for (let i = 0; i < 40 && !btnOk && !locked && Date.now() < hardDeadlineMs; i++) {
            await sleep(500);
            const t = await wcdp.eval(`(() => { const a = document.getElementById('prd-botnav-rightbtn'); return a ? (a.innerText || '').replace(/[\\s]+/g, ' ').trim().slice(0, 20) : null; })()`).catch(() => null);
            if (!t) continue; // 锚点还没渲染
            if (/立即购买|立即申购|马上抢|立即抢购/.test(t)) btnOk = 1;
            else if (/开始|售罄|缺货|预约|暂不|已结束/.test(t)) locked = true;
          }
          if (!btnOk) {
            log(`预热候选「${p.id || prdId}」${locked ? '按钮锁定/售罄' : '不可买或没加载出来'}，换下一个。`);
            continue;
          }
          // 用它自己的内部入口触发立即购买（= 开确认页草稿，不提交）
          const r1 = await wcdp.send('Runtime.evaluate', {
            expression: `(() => {
              const root = document.getElementById('prd-botnav-rightbtn');
              if (!root) return null;
              const host = root.querySelector('div[tabindex]') || root.querySelector('[tabindex]');
              if (!host) return null;
              const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
              let node = key ? host[key] : null, hops = 0;
              while (node && hops < 25) {
                const p = node.memoizedProps;
                if (p && typeof p.onPress === 'function') { globalThis.__qpWarmPress = p.onPress; return 'ARMED'; }
                node = node.return; hops++;
              }
              return null;
            })()`,
            returnByValue: true,
          }).catch(() => null);
          let fired = false;
          if (r1 && r1.result && r1.result.value === 'ARMED') {
            const g = await wcdp.send('Runtime.evaluate', { expression: 'globalThis.__qpWarmPress', returnByValue: false });
            const fr = await wcdp.send('Runtime.callFunctionOn', {
              objectId: g.result.objectId,
              functionDeclaration: 'function(){ try { this(); return "FIRED"; } catch (e) { return "ERR:" + e.message; } }',
              returnByValue: true, userGesture: true,
            }).catch(() => null);
            fired = !!(fr && fr.result && fr.result.value === 'FIRED');
          }
          if (!fired) {
            const pos = await wcdp.eval(`(() => { const a = document.getElementById('prd-botnav-rightbtn'); if (!a) return null; const r = a.getBoundingClientRect(); if (r.width <= 0) return null; return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`).catch(() => null);
            if (pos) await trustedClick(wcdp, pos.x, pos.y);
          }
          // 等确认页出现并挂载完重资源（「提交订单」按钮可见 = 预热真正完成）。
          // ★ 2026-10-08：预热完立刻关闭草稿页——磁盘缓存不随标签关闭失效，
          //   而挂着它等于开售时账号名下同时开着两张确认订单页，疑似会干扰
          //   真实提交（02:58 真场两个账号都被"商品火爆"拒单时它都开着）。
          let ok = false;
          let confirmInfo = null;
          for (let i = 0; i < 24 && !ok && Date.now() < hardDeadlineMs; i++) {
            await sleep(500);
            const ts = await listTabs(port).catch(() => []);
            const cf = ts.find((t) => /orderConfirm/.test(t.url || '') && t.id !== warmTab.id);
            if (cf) { ok = true; confirmInfo = cf; break; }
          }
          if (ok) {
            // 等「提交订单」按钮挂载（重资源加载完成的标志），最多 10s / 截止时刻
            let mounted = false;
            try {
              const ccdp = new CDP(confirmInfo.webSocketDebuggerUrl);
              await ccdp.connect();
              await ccdp.send('Runtime.enable');
              const MOUNT = `(() => {
                const clean = (s) => (s || '').replace(/[\\s]+/g, ' ').trim();
                for (const el of document.querySelectorAll('a,button,div,span')) {
                  const t = clean(el.innerText);
                  if (!t || t.length > 6 || !t.includes('提交订单')) continue;
                  const r = el.getBoundingClientRect();
                  if (r.width > 0 && r.height > 0) return true;
                }
                return false;
              })()`;
              for (let i = 0; i < 20 && !mounted && Date.now() < hardDeadlineMs; i++) {
                try { mounted = await ccdp.eval(MOUNT); } catch { /* 加载中 */ }
                if (!mounted) await sleep(500);
              }
              try { ccdp.ws.close(); } catch { /* 已关 */ }
            } catch { /* 探测失败也按已预热处理（页面已打开，资源基本拉过） */ }
            // 关闭草稿确认页（缓存已在磁盘，不受影响）
            await fetch(`http://127.0.0.1:${port}/json/close/${confirmInfo.id}`).catch(() => {});
            warmupConfirmTabs.delete(`${port}:${confirmInfo.id}`);
            log(`✔ 跨商品预热完成：用「${p.id || prdId}」的确认页把结算页资源焐热${mounted ? '' : '（按钮未及挂载，按已加载处理）'}，草稿页已关闭——目标商品 T0 开页走热加载。`, 'ok');
            E.ev('WARMUP_OK', `${p.id || prdId} mounted=${mounted ? 1 : 0}`);
            return true;
          }
          log(`预热候选「${p.id || prdId}」没开出确认页，换下一个。`, 'warn');
        } finally {
          await fetch(`http://127.0.0.1:${port}/json/close/${warmTab.id}`).catch(() => {});
          try { wcdp.ws.close(); } catch { /* 已关 */ }
        }
      } catch (e) {
        log(`预热标签出错（${e.message}），换下一个候选。`, 'warn');
        if (warmTab && warmTab.id) await fetch(`http://127.0.0.1:${port}/json/close/${warmTab.id}`).catch(() => {});
      }
    }
    log('跨商品预热：没有可用的现货候选（都不可买/没开出确认页）——目标页将走常规加载。', 'warn');
    return false;
  }

  /**
   * 从「当前渲染」的按钮闭包里取内部入口（Yo / E.goBuy）。
   * 闭包变量无法从页面 JS 直接访问，必须走 CDP 的 [[Scopes]] 通道；全链实测 ~5ms。
   * 每轮现取不缓存——React 每次重渲染生成新闭包，现取现调天然拿到最新按钮状态
   * （按键文案 qo / 商品数据 buttonMode），不会用上过期快照。
   */
  async function pickInternalEntry() {
    const r1 = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
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
      })()`,
      returnByValue: false, objectGroup: 'internal-fire',
    }).catch(() => null);
    if (!r1 || !r1.result || !r1.result.objectId) return { s: 'NO_ANCHOR' };
    const outProps = await cdp.send('Runtime.getProperties', { objectId: r1.result.objectId, ownProperties: true });
    const fnId = (outProps.result || []).find((v) => v.name === 'fn')?.value?.objectId;
    if (!fnId) return { s: 'NO_ONPRESS' };
    const p1 = await cdp.send('Runtime.getProperties', { objectId: fnId, ownProperties: false });
    const scopesRef = (p1.internalProperties || []).find((x) => x.name === '[[Scopes]]');
    if (!scopesRef || !scopesRef.value || !scopesRef.value.objectId) return { s: 'NO_SCOPES' };
    const sl = await cdp.send('Runtime.getProperties', { objectId: scopesRef.value.objectId, ownProperties: true });
    let yoId = null, eId = null;
    for (const sc of sl.result || []) {
      if (!sc.value || !sc.value.objectId || !/Closure/.test(sc.value.description || '')) continue;
      const vars = await cdp.send('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: true });
      let scYo = null, scE = null;
      for (const v of vars.result || []) {
        if (v.name === 'Yo' && v.value && v.value.objectId) scYo = v.value.objectId;
        if (v.name === 'E' && v.value && v.value.objectId && v.value.subtype !== 'null') scE = v.value.objectId;
      }
      // 只认"定义了 Yo 的那个闭包"（组件闭包）——模块作用域里同名变量会串台
      if (scYo) { yoId = scYo; eId = scE; break; }
    }
    if (!yoId) return { s: 'NO_ENTRY' };
    let goBuyId = null;
    if (eId) {
      const ep = await cdp.send('Runtime.getProperties', { objectId: eId, ownProperties: true }).catch(() => null);
      goBuyId = (ep?.result || []).find((v) => /^gobuy$/i.test(v.name))?.value?.objectId || null;
    }
    return { s: 'OK', yoId, goBuyId };
  }

  /**
   * 一轮内部触发（调用方不 await；轮内自带上锁，重叠轮直接丢）。
   * "成功"= 至少调到了一个入口，不等于必然进确认页——确认页由 maybePickConfirm 拾取。
   * 停用只在"结构失效"时发生（连续 ~10s 不可达/出错）；未开售/重渲染瞬间的
   * 短时取不到只计数继续——实测未解锁调用零副作用（未开售 fire 页面毫无变化）。
   */
  async function internalFire() {
    if (internalBusy) return;
    internalBusy = true;
    internalRound++;
    try {
      // 候选 0：2020 全局对象路径（历史保留，万一华为换回来；每 20 轮探一次足够，省每轮 0.5ms）
      if (internalRound % 20 === 1) {
        const legacy = await cdp.eval(`(() => { try {
          const b = window.rush && window.rush.business;
          if (b && typeof b.doGoRush === 'function') { b.doGoRush(2); return 'FIRED'; }
          return 'NOFN';
        } catch (e) { return 'ERR:' + e.message; } })()`).catch(() => 'NOFN');
        if (legacy === 'FIRED') { internalFiredAt = Date.now(); internalMissStreak = 0; internalMissSince = 0; return; }
      }

      // 候选 1/2：fiber 闭包里的 Yo（主力）与 goBuy（解锁后交替双发）
      const pick = await pickInternalEntry();
      if (pick.s !== 'OK') {
        internalMissStreak++;
        if (!internalMissSince) internalMissSince = Date.now();
        if (internalMissStreak === 1 || internalMissStreak % 40 === 0) {
          log(`A 方案：内部入口暂不可达（${pick.s}），继续等待（未开售/重渲染瞬间都会这样）。`);
        }
        if (Date.now() - internalMissSince >= 10000) { // 持续 10s 不可达 → 结构失效
          internalArmed = false;
          log('A 方案：内部入口持续 10 秒不可达，判定结构失效，停用并回落真点击。', 'warn');
        }
        return;
      }
      internalMissStreak = 0;
      internalMissSince = 0;

      const useGoBuy = unlockSeen && pick.goBuyId && internalRound % 2 === 0;
      const targetId = useGoBuy ? pick.goBuyId : pick.yoId;
      const rr = await cdp.send('Runtime.callFunctionOn', {
        objectId: targetId,
        functionDeclaration: useGoBuy
          ? 'function(){ try { this("buy_now_button","rushbuy"); return "GOBUY"; } catch (e) { return "ERR:" + e.message; } }'
          : 'function(){ try { this(); return "YO"; } catch (e) { return "ERR:" + e.message; } }',
        returnByValue: true,
        userGesture: true,   // ★ window.open 开确认页需要用户手势，否则被弹窗拦截
      }).catch((e) => ({ result: { value: 'ERR:' + e.message } }));
      const res = rr.result?.value;
      if (typeof res === 'string' && res.startsWith('ERR')) {
        internalMissStreak++;
        if (!internalMissSince) internalMissSince = Date.now();
        if (internalMissStreak === 1 || internalMissStreak % 40 === 0) log(`A 方案调用异常（${res}），继续重试。`, 'warn');
        if (Date.now() - internalMissSince >= 10000) { internalArmed = false; log('A 方案：连续 10 秒出错，停用并回落真点击。', 'warn'); }
        return;
      }
      internalFiredAt = Date.now();
      if (internalFiredAt - lastFireLogAt >= 2000) {
        lastFireLogAt = internalFiredAt;
        E.ev('INTERNAL_FIRED', `${res}${useGoBuy ? ' goBuy' : ' Yo'}`);
        log(`A 方案：已调用内部入口（${res}${useGoBuy ? ' · goBuy' : ' · Yo'}）。`);
      }
    } catch (e) {
      internalMissStreak++;
      if (!internalMissSince) internalMissSince = Date.now();
      if (internalMissStreak % 20 === 1) log(`A 方案执行出错（${e.message}），继续重试。`, 'warn');
      if (Date.now() - internalMissSince >= 10000) { internalArmed = false; log('A 方案：连续 10 秒出错，停用并回落真点击。', 'warn'); }
    } finally {
      internalBusy = false;
      cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'internal-fire' }).catch(() => {});
    }
  }
  if (internalArmed) {
    pickInternalEntry().then((pre) => {
      if (pre.s === 'OK') log(`A 方案武装预检：入口可达（Yo ✓${pre.goBuyId ? ' · goBuy ✓' : ' · goBuy ✗'}）。`, 'ok');
      else log(`A 方案武装预检：入口暂不可达（${pre.s}），热窗内会持续重试。`, 'warn');
    }).catch(() => {});
  }
  /** A 方案触发后的确认页拾取：优先浏览器级 Target 信号（瞬时），500ms 周期扫描兜底。 */
  async function maybePickConfirm() {
    if (!internalFiredAt || Date.now() - internalFiredAt >= 30000) return null;
    const viaSignal = confirmSignal.targetId && !confirmHandled.has(confirmSignal.targetId);
    if (!viaSignal && Date.now() - lastConfirmScan < 500) return null;
    lastConfirmScan = Date.now();
    const tabs = await listTabs(port).catch(() => []);
    const t = tabs.find((x) => /orderConfirm/.test(x.url) && !tabBaseline.has(x.id) && !confirmHandled.has(x.id));
    if (!t) return null;
    confirmHandled.add(t.id);
    confirmSignal.targetId = null;
    log('A 方案：确认订单页已出现，进入收尾流程。', 'ok');
    return await finishConfirmed(t, null);
  }

  // 模式开关（控制台「抢购行为→模式」，之前保存了但驱动没读，2026-10-07 接上）：
  //   rush（默认）= 到点抢购，失败自动转回流监控；
  //   monitor = 不抢首发，直接守回流（适合明知没首发货/错过首发只想捡回流的场次）。
  if ((config.mode || 'rush') === 'monitor') {
    log('monitor 模式：跳过正抢，直接进入回流监控。');
    const r = await runMonitor();
    if (r) return r;
    await report({ outcome: 'FAILED', resultCode: 'NO_ACTIVITY', message: 'monitor 模式：无可监控的活动窗口，结束', evidence: ev(stateRef) });
    return { ok: false, outcome: 'NO_ACTIVITY' };
  }

  /**
   * （可选）可信点击购买 → 等确认订单页出现。
   * ★ 实测大坑（2026-10-07）：vmall 的“立即购买”被真点击后是**新开标签页**
   * 进确认订单页的（window.open），本标签的 URL 根本不变！所以判定成败必须
   * 扫整个窗口的标签列表，不能只盯着本标签。
   * pos=null = 只等确认页不点击（A 方案内部函数已自己发起流程时用）。
   * 等待由浏览器级 Target 信号唤醒（R3），信号不可用时退化为 600ms 轮询。
   */
  async function attemptBuy(pos, deadlineMs = 30000) {
    if (pos) await trustedClick(cdp, pos.x, pos.y);
    let confirmTab = null;
    let after = st;
    const navDeadline = Date.now() + deadlineMs;
    while (Date.now() < navDeadline) {
      await waitConfirmSignal(600);
      const tabs = await listTabs(port).catch(() => []); // Chrome 瞬断不再炸整槽（审计 P1-6）
      confirmTab =
        tabs.find((t) => /orderConfirm/.test(t.url) && !tabBaseline.has(t.id)) ||
        tabs.find((t) => /orderConfirm|确认订单/.test((t.url || '') + (t.title || '')) && !tabBaseline.has(t.id));
      if (confirmTab) break;
      const loginSeen = tabs.some((t) => ON_LOGIN_PAGE.test((t.url || '') + ' ' + (t.title || '')));
      after = await state(); // 本标签也可能自己跳转（某些路径不开新标签）
      if (/orderConfirm|确认订单/.test(after.url + ' ' + after.title)) { confirmTab = tab; break; }
      if (loginSeen || ON_LOGIN_PAGE.test(after.url + ' ' + after.title)) return { kind: 'LOGIN_LOST', after };
    }
    if (!confirmTab) return { kind: 'NO_CONFIRM', after };
    return { kind: 'CONFIRMED', confirmTab, after };
  }

  /** 确认订单页到手后的收尾：演练模式读金额即停；真模式提交订单。 */
  async function finishConfirmed(confirmTab, pos, viaMonitor = false) {
    if (confirmTab.id !== tab.id) {
      // 激活确认页让人看得见；重试导致的重复确认页只留一个
      const newConfirms = (await listTabs(port)).filter((t) => /orderConfirm/.test(t.url) && !tabBaseline.has(t.id));
      for (const t of newConfirms.slice(1)) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {});
      confirmTab = newConfirms[0] || confirmTab;
      await fetch(`http://127.0.0.1:${port}/json/activate/${confirmTab.id}`).catch(() => {});
    }
    log('确认订单页已打开，自动提交流程启动（滚动→点提交→轮询结果全自动）。');
    if (dryRun) {
      let payNote = '';
      try {
        const c2 = new CDP(confirmTab.webSocketDebuggerUrl);
        await c2.connect();
        const m = await c2.eval('(() => (document.body.innerText.match(/应付[金额总额][:：]?\\s*¥?\\s*([\\d,.]+)/) || [])[1] || null)()');
        if (m) payNote = `（应付 ¥${m}）`;
        c2.ws.close();
      } catch { /* 读不到金额不影响结论 */ }
      log(`✅ 已进入确认订单页${payNote}。演练模式到此为止，不点“提交订单”。`, 'ok');
      await report({
        outcome: 'DRY_RUN_OK', resultCode: null,
        message: (viaMonitor ? '回流捕获·演练模式：可信点击已进入确认订单页，未提交订单' : '演练模式：可信点击已进入确认订单页，未提交订单'),
        evidence: ev(stateRef, null, pos),
      });
      return { ok: true, outcome: 'DRY_RUN_OK' };
    }
    const confirmCdp = new CDP(confirmTab.webSocketDebuggerUrl);
    await confirmCdp.connect();
    await confirmCdp.send('Runtime.enable');
    await confirmCdp.send('Network.enable', { maxResourceBufferSize: 10 * 1024 * 1024 }).catch(() => {});
    attachNetRecorder(confirmCdp, E); // ★ 拒单的原始响应体就在这里抓
    E.ev('CONFIRM_TAB', String(confirmTab.url || '').slice(0, 160));
    // 确认页是新标签，Fetch 拦截按标签会话生效——排队页样本留证（R2）要在这里
    // 再装一次；改写规则在同一会话上对确认页同样安全（失败自动放行）。
    try { await installInterception(confirmCdp, planIntercept, log); }
    catch (e) { log(`确认页拦截安装失败（${e.message}），该标签不留证。`, 'warn'); }
    await submitOrder(confirmCdp, { config, report, stateRef, log, E });
    return { ok: true, outcome: 'ORDER_FLOW_DONE' };
  }

  /** 触发一次内部购买入口（Yo）。返回是否成功调用。
   *  ★ 2026-10-08 实测：当前 RNW 版页面上 CDP 真点击连购买按钮也打不动了
   *   （probe-click-debug.mjs：锚点/host 真点击均无反应，内部 onPress 稳定开出确认页），
   *   所以出手链路一律"内部优先、真点击兜底"。 */
  async function triggerBuyInternal() {
    try {
      const pick = await pickInternalEntry();
      if (pick.s !== 'OK') return false;
      const rr = await cdp.send('Runtime.callFunctionOn', {
        objectId: pick.yoId,
        functionDeclaration: 'function(){ try { this(); return "YO"; } catch (e) { return "ERR:" + e.message; } }',
        returnByValue: true, userGesture: true,
      }).catch(() => null);
      return !!(rr && rr.result && rr.result.value === 'YO');
    } catch { return false; }
  }
  /** 统一出手：内部入口优先（8s 窗），没出确认页再用真点击兜底（30s 窗）。
   *  slot.forceClick=true 时跳过内部入口、只用真点击（三方案实验的 A 组：
   *  复刻最初"真点击→排队页"路线，测排队链路全程耗时）。 */
  async function triggerBuyFlow(pos) {
    if (slot.forceClick === true) {
      E.ev('BUY_VIA', 'force-click');
      return await attemptBuy(pos, 30000);
    }
    if (await triggerBuyInternal()) {
      const r = await attemptBuy(null, 8000);
      if (r.kind === 'CONFIRMED' || r.kind === 'LOGIN_LOST') return r;
    }
    return await attemptBuy(pos, 30000);
  }

  /** 发现可买后的完整动作链：点击→等确认页→登录/重试处理。
   *  返回 { done } = runSlot 应立即返回该结果；{ relogin } = 已等登录，继续循环；null = 未中，继续循环。
   *  ★ 热路径等确认页窗口 30s→8s（审计 P1-5）：点击"立即购买"本身不产生订单，
   *    8 秒没出确认页基本就是没点上，快重试比傻等强；30s 长窗口留给回流监控段。 */
  async function clickBuyFlow(pos) {
    attempts++;
    const relT0 = serverT0Ms != null ? Math.round(Date.now() - clockOffsetMs - serverT0Ms) : null;
    log(`发现可买「${pos.label}」，出手（内部入口优先，真点击兜底）${relT0 != null ? `（服务器钟 T0${relT0 >= 0 ? '+' : ''}${relT0}ms）` : ''}…`);
    E.ev('BUY_SEEN', `${pos.label} T0${relT0 != null ? (relT0 >= 0 ? '+' : '') + relT0 + 'ms' : '?'}`);
    const r = await triggerBuyFlow(pos);
    E.ev('BUY_RESULT', r.kind);
    E.shot(cdp, 'product-after-buy').catch?.(() => {}) ?? E.shot(cdp, 'product-after-buy');
    if (r.kind === 'LOGIN_LOST') {
      log('点击后被带到登录页——会话未登录。等登录后自动回商品页重来（不计失败）。', 'warn');
      await waitLoginFlow();
      attempts = 0;
      return { relogin: true };
    }
    if (r.kind === 'CONFIRMED') return { done: await finishConfirmed(r.confirmTab, pos) };
    log(`点击后 8 秒内未出现确认订单页（本标签仍在「${r.after.title || r.after.url.slice(0, 60)}」）。`);
    if (attempts >= maxBuyRetry) {
      log('购买点击已达重试上限仍无确认页，停止。', 'warn');
      await report({
        outcome: 'FAILED', resultCode: 'BUY_NO_EFFECT',
        message: `可信点击 ${attempts} 次均未进入确认订单页`, evidence: ev(stateRef, null, pos),
      });
      return { done: { ok: false, outcome: 'BUY_NO_EFFECT' } };
    }
    return null;
  }

  /* ── SKU 切换扫描（2026-10-08 实测验证，任务”回流不刷页”）──────────────
   * 原理：在商品页上切换规格，页面会在 ~150ms 内自发重拉该 SKU 的实时状态
   * （refreshSbomRealInfoV3 / sbomDetailParamCacheInfo），购买按钮随之重渲染——
   * 这就是"切规格"替代"刷页面"的依据（probe-sku-switch.mjs 实证）。
   * 收益：一轮切换 ≈1.5s、只发 2~4 个轻接口；整页刷新要 5~10s、一次拖全量资源。
   * 2026-10-08 按用户要求定稿：在指定 SKU 清单（monitor.scanSboms > 商品勾选规格 >
   * 全部规格）里随机切、不切回；出现可买按钮只对清单内的 SKU 出手（页面组合被
   * 平台吸附到清单外时不出手）；连续失败熔断回整页刷新；整页刷新保留低频兜底。
   */
  /** 用芯片自己的 onPress 切规格（真点击对 RNW 规格芯片不生效——2026-10-08 实测） */
  async function switchSpecByPress(text) {
    const arm = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const want = ${JSON.stringify(text)};
        for (const el of document.querySelectorAll('div[tabindex]')) {
          const t = (el.innerText || '').replace(/[\\s]+/g, ' ').trim();
          if (t !== want) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const key = Object.keys(el).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
          let node = key ? el[key] : null, hops = 0;
          while (node && hops < 25) {
            const p = node.memoizedProps;
            if (p && typeof p.onPress === 'function') { globalThis.__qpSpecTarget = p.onPress; return 'ARMED'; }
            node = node.return; hops++;
          }
        }
        globalThis.__qpSpecTarget = null;
        return 'NOFN';
      })()`,
      returnByValue: true,
    }).catch(() => null);
    if (!arm || arm.result.value !== 'ARMED') return arm ? arm.result.value : 'EVAL_ERR';
    const g = await cdp.send('Runtime.evaluate', { expression: 'globalThis.__qpSpecTarget', returnByValue: false, objectGroup: 'spec-scan' });
    const fr = await cdp.send('Runtime.callFunctionOn', {
      objectId: g.result.objectId,
      functionDeclaration: 'function(){ try { this({ preventDefault(){}, stopPropagation(){} }); return "FIRED"; } catch (e) { return "ERR:" + e.message; } }',
      returnByValue: true, userGesture: true,
    }).catch((e) => ({ result: { value: 'ERR:' + e.message } }));
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'spec-scan' }).catch(() => {});
    return fr.result && fr.result.value;
  }
  /** 一轮 SKU 扫描：切走 → 切回绑定规格 → 查按钮 → 有货立即走正抢链路 */
  /** 参与回流随机切换的目标 SKU 清单（2026-10-08 定稿，多账号各配各的）：
   *  ① 槽位自己的 scanSboms（rush-slots 文件里按账号配，控制台槽位表格可编辑）
   *  ② 默认 = 该商品勾选要抢的规格（product.skuIds，即"需要抢购的那些"）
   *  ③ 都没有 = 该商品全部规格。
   *  在这些 SKU 里随机切、**不切回**——出现可买按钮时只允许买清单内的 SKU。 */
  function scanTargets() {
    if (!CATALOG) return [];
    const prod = (CATALOG.products || []).find((p) => String(p.prdId) === String(slot.prdId));
    const all = (prod && prod.skus || []).map((s) => ({ sbomCode: String(s.sbomCode ?? s.skuId), attrs: s.attrs || {} }));
    const byCode = new Map(all.map((s) => [s.sbomCode, s]));
    const fromSlot = (slot.scanSboms || []).map(String).filter(Boolean);
    if (fromSlot.length) return fromSlot.map((c) => byCode.get(c)).filter(Boolean);
    const checked = (product.skuIds || []).map(String).filter(Boolean);
    if (checked.length) return checked.map((c) => byCode.get(c)).filter(Boolean);
    return all;
  }
  /** 已选行落在本轮允许清单里吗？返回命中的 SKU（null=不在清单，绝不出手） */
  function matchScanTarget(yixuanText) {
    const got = String(yixuanText || '').replace(/\s+/g, '');
    if (!got) return null;
    for (const t of scanTargetList) {
      const vals = Object.values(t.attrs || {}).map((v) => String(v || '').replace(/\s+/g, '')).filter(Boolean);
      if (vals.length && vals.every((v) => got.includes(v))) return t;
    }
    return null;
  }
  /** 把页面按目标 SKU 的规格值逐维按下（颜色→版本→…），页面自己解析到具体 SKU */
  async function switchToScanTarget(target) {
    const vals = Object.values(target.attrs || {}).filter(Boolean);
    if (!vals.length) return 'NO_ATTRS';
    let last = 'FIRED';
    for (const v of vals) {
      const r = await switchSpecByPress(v);
      if (r !== 'FIRED') last = r; // 某一维芯片没找到（如 CPU 自动推导）不致命
      await sleep(250);
    }
    return last;
  }
  async function skuScanCheck() {
    if (!scanTargetList.length) return { fatal: 'NO_TARGETS' };
    // 读当前已选，挑一个和当前不同的目标（切相同值页面不重拉数据）
    const curSel = (await cdp.eval("((document.body.innerText.match(/已选[：:]([^\\n]{1,60})/) || [''])[1] || '').replace(/\\s+/g, '')").catch(() => '')) || '';
    const pool = scanTargetList.filter((t) => {
      const vals = Object.values(t.attrs || {}).map((v) => String(v || '').replace(/\s+/g, '')).filter(Boolean);
      return !(vals.length && vals.every((v) => curSel.includes(v)));
    });
    const target = (pool.length ? pool : scanTargetList)[Math.floor(Math.random() * (pool.length ? pool.length : scanTargetList.length))];
    const t0 = Date.now();
    E.ev('SCAN_ROUND', target.sbomCode);
    const sw = await switchToScanTarget(target);
    if (sw !== 'FIRED' && sw !== 'NO_ATTRS') { E.ev('SCAN_FAIL', String(sw)); return { fail: `切换失败（${sw}）` }; }
    await sleep(450 + Math.random() * 350); // 等页面重拉实时状态（实测 ~150ms 出请求，留裕量）
    const fc = await cdp.eval(fastCheckExpr(true)).catch(() => null);
    if (!fc) return { fail: '页面读取失败' };
    if (fc.challenge) {
      log('扫描期间出现风控验证，停止并转人工。', 'err');
      await report({ outcome: 'WAITING_HUMAN', resultCode: 'CAPTCHA', message: '回流扫描中出现风控验证', humanAction: '请人工处理后重跑', evidence: ev(stateRef) });
      return { done: { ok: false, outcome: 'WAITING_HUMAN' } };
    }
    if (fc.buy) {
      // ★ 出手闸门：当前已选必须落在允许清单里（页面组合可能被平台吸附到别的 SKU）
      const hit = matchScanTarget(fc.yixuan);
      if (!hit) {
        log(`扫描发现可买，但已选「${(fc.yixuan || '').trim()}」不在允许清单里——不出手，继续切。`, 'warn');
        return { fail: '规格不在清单，放弃出手' };
      }
      return await fireOnScan(fc.buy, t0);
    }
    return {}; // 本轮无货
  }
  /** 扫描发现可买后的出手（内部优先+点击兜底，与正抢同一链路） */
  async function fireOnScan(buy, tScan) {
    const waitedMin = Math.round((Date.now() - (triggerLocalMs || tScan)) / 60000);
    log(`🎉 回流捕获（SKU 切换扫描，开售后约 ${waitedMin} 分钟）：「${buy.label}」出现，出手…`, 'ok');
    const pos = await cdp.eval(buyExpr(true)).catch(() => buy);
    const r = await triggerBuyFlow(pos);
    if (r.kind === 'LOGIN_LOST') {
      log('点击后被带到登录页，等登录后继续监控。', 'warn');
      try { await waitLoginFlow(deadlineRef.now); } catch { return { done: { ok: false, outcome: 'MONITOR_GIVE_UP' } }; }
      return {};
    }
    if (r.kind === 'CONFIRMED') return { done: await finishConfirmed(r.confirmTab, pos, true) };
    const tip = (r.after.text.match(/抱歉[^\n]{0,24}|已售完[^\n]{0,16}|超过购买上限[^\n]{0,16}|暂不可购买[^\n]{0,16}/) || [])[0];
    log(`点击后未进确认页${tip ? `（页面提示：${tip.trim()}）` : ''}，继续监控。`, 'warn');
    return {};
  }

  /**
   * 回流监控：没抢到后继续守到活动结束。依据（2026-10-07 调研+实测，详见 docs/README）：
   * 未付款订单约 15 分钟超时回流（收银台实测”15分钟内完成支付，否则订单将自动取消”），
   * 抢购活动窗口实测 2 小时（startTime→endTime）。
   * 双信号：① Node 轻量轮询 queryRushbuyInfo，字段一变立刻查页面（实测 skuStatus
   * 会随销售状态翻转；字段语义无人解读，只当预警不当依据）；② 页面信号——默认用
   * SKU 切换扫描（2026-10-08 起，不刷新页面、每轮 ~1.5s、接口开销极小），整页刷新
   * 降级为低频兜底与故障回退。捕获后走与正抢相同的可信点击链路。
   */
  async function runMonitor() {
    const m = monitorCfg;
    const pollMs = (m.pollSecs ?? 60) * 1000;
    const densePollMs = (m.densePollSecs ?? 30) * 1000;
    const jitterMs = (m.jitterSecs ?? 15) * 1000;
    const ifaceMs = (m.interfacePollSecs ?? 15) * 1000;
    const maxMs = m.maxMs ?? 2 * 60 * 60 * 1000;
    const scanMode = m.scanMode === 'refresh' ? 'refresh' : 'sku';
    const skuScanMs = (m.skuScanSecs ?? 10) * 1000;
    const skuJitterMs = (m.skuScanJitterSecs ?? 5) * 1000;
    const skuFallbackRefreshMs = (m.skuFallbackRefreshSecs ?? 600) * 1000;
    const skuScanMaxFails = m.skuScanMaxFails ?? 5;
    const monStart = Date.now();
    const denseUntil = monStart + (m.denseWindowMin ?? 40) * 60 * 1000;
    let deadline = monStart + maxMs;
    deadlineRef.now = deadline;

    const info0 = slot.sbomCode ? await probeRushbuyInfo(slot.sbomCode, stateRef.ua) : null;
    const endMs = info0 && info0.item && Number(info0.item.endTime) > 1e12 ? Number(info0.item.endTime) : null;
    if (endMs && endMs > Date.now()) {
      deadline = Math.min(deadline, endMs + 5 * 60 * 1000);
      deadlineRef.now = deadline;
      log(`回流监控启动：活动窗口至 ${fmtLocal(endMs)}，守到那为止（受 maxMs 上限约束）。`, 'ok');
    } else if (!m.ignoreActivityEnd) {
      log('官方接口无有效活动窗口（已结束/无场次），不启动回流监控。', 'warn');
      return null;
    } else {
      log(`回流监控启动：官方活动窗口不可用，按 maxMs=${Math.round(maxMs / 60000)} 分钟兜底（ignoreActivityEnd）。`, 'warn');
    }
    await report({
      outcome: 'WAITING_HUMAN', resultCode: 'MONITORING',
      message: `抢购未中，已进入回流监控至 ${fmtLocal(deadline)}；捕获回流后自动可信点击`,
      humanAction: '无需操作，保持电脑不休眠；弹验证码/掉线时在专用窗口处理即可',
    });

    try {
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    } catch { /* 内核不支持就算了，&_r= 参数也能破 URL 级缓存 */ }

    let lastSig = info0 ? JSON.stringify(info0.item || null) : null;
    let nextIface = 0;
    let lastPageCheckAt = 0;
    let pageFailures = 0;
    let mismatchRestores = 0;
    let rounds = 0;
    let lastHeartbeat = Date.now();
    let scanFails = 0;
    let lastFullRefresh = Date.now();
    let skuModeLive = scanMode === 'sku' && scanTargetList.length >= 2;
    if (scanMode === 'sku' && !scanTargetList.length) {
      log('SKU 扫描清单是空的（商品没勾规格、目录没采到），退回整页刷新模式。', 'warn');
      skuModeLive = false;
    } else if (scanMode === 'sku' && scanTargetList.length === 1) {
      log('SKU 扫描清单只有 1 个规格——切自己不会触发数据重拉，改用整页刷新探测。要切换模式就在槽位里把清单配成多个规格。', 'warn');
      skuModeLive = false;
    } else if (skuModeLive) {
      const via = (slot.scanSboms || []).filter(Boolean).length ? '槽位指定清单' : '该商品勾选的抢购规格';
      log(`回流监控用「SKU 随机切换扫描」：每 ${(skuScanMs / 1000) | 0}±${(skuJitterMs / 2000) | 0}s 在 ${scanTargetList.length} 个规格里随机切一个（${via}，不切回），按钮一亮就出手；每 ${Math.round(skuFallbackRefreshMs / 60000)} 分钟整页刷新兜底。`);
    }
    while (Date.now() < deadline) {
      // ① 轻量接口信号：字段变化 → 尽快查页面（限频 20s，防字段抖动引发检查风暴）
      if (Date.now() >= nextIface) {
        nextIface = Date.now() + ifaceMs + Math.random() * 5000;
        const p = await probeRushbuyInfo(slot.sbomCode, stateRef.ua).catch(() => null);
        if (p) {
          const sig = JSON.stringify(p.item || null);
          if (sig !== lastSig) {
            log(`状态接口字段变化：${(lastSig || '∅').slice(0, 160)} → ${sig.slice(0, 160)}，立即查页面！`, 'warn');
            lastSig = sig;
            if (Date.now() - lastPageCheckAt > 20000) {
              const got = skuModeLive ? await skuScanCheck() : await monitorCheck();
              if (got && got.done) return got.done;
            }
          }
        }
      }
      // ② 页面信号：sku 扫描（默认）或整页刷新（旧模式/回退）
      if (skuModeLive) {
        await sleep(skuScanMs + Math.random() * skuJitterMs);
        if (Date.now() >= deadline) break;
        rounds++;
        const got = await skuScanCheck();
        if (got && got.done) return got.done;
        if (got && got.fatal) { skuModeLive = false; log(`SKU 扫描不可用（${got.fatal}），整轮改用整页刷新。`, 'warn'); continue; }
        if (got && got.fail) {
          scanFails++;
          if (scanFails === 1 || scanFails % 5 === 0) log(`SKU 扫描异常：${got.fail}（第 ${scanFails} 次）`, 'warn');
          if (scanFails >= skuScanMaxFails) {
            skuModeLive = false;
            log(`SKU 扫描连续失败 ${scanFails} 次，本监控剩余时间改用整页刷新。`, 'warn');
          }
        } else if (got && !got.fail) scanFails = 0;
        // 低频整页刷新兜底（页面级”地面真值”）
        if (Date.now() - lastFullRefresh >= skuFallbackRefreshMs) {
          lastFullRefresh = Date.now();
          const got2 = await monitorCheck();
          if (got2 && got2.done) return got2.done;
          lastPageCheckAt = Date.now();
        }
      } else {
        await sleep((Date.now() < denseUntil ? densePollMs : pollMs) + Math.random() * jitterMs);
        if (Date.now() >= deadline) break;
        rounds++;
        const got = await monitorCheck();
        if (got && got.done) return got.done;
      }
      // ③ 会话保活（sku 模式不刷页，vmall 侧 Cookie 全靠它续命）
      const pr = await sessionPing();
      if (pr === 'out') {
        log('保活探测发现登录已失效（服务端会话不在了），等人登回，监控继续。', 'warn');
        await report({ outcome: 'WAITING_HUMAN', resultCode: 'NEEDS_LOGIN', message: '回流监控中登录掉线（监控值守不放弃）', humanAction: '随时在专用窗口重新登录即可' });
        try { await waitLoginFlow(deadline); } catch { return { ok: false, outcome: 'MONITOR_GIVE_UP' }; }
      }
      if (Date.now() - lastHeartbeat > 10 * 60 * 1000) {
        lastHeartbeat = Date.now();
        log(`监控心跳：已扫 ${rounds} 轮，仍无可买按钮（距监控截止 ${Math.round((deadline - Date.now()) / 60000)} 分钟）。`);
      }
      if (pageFailures >= 5) {
        log('连续 5 轮页面检查失败，回流监控中止。', 'err');
        break;
      }
    }
    log(`回流监控结束（守了 ${Math.round((Date.now() - monStart) / 60000)} 分钟，未等到回流）。`, 'warn');
    await report({ outcome: 'FAILED', resultCode: 'MONITOR_GIVE_UP', message: '回流监控到期，未出现可买状态', evidence: ev(stateRef) });
    return { ok: false, outcome: 'MONITOR_GIVE_UP' };

    /** 一轮整页刷新检查（sku 模式的兜底 / refresh 模式的主路径） */
    async function monitorCheck() {
      lastPageCheckAt = Date.now();
      try {
        await cdp.send('Page.navigate', { url: `${targetUrl}&_r=${Date.now()}` });
        await waitPageReady(1200);
        pageFailures = 0;
      } catch (e) {
        pageFailures++;
        log(`监控轮刷新页面失败（${e.message}）`, 'warn');
        return null;
      }
      const s = await state().catch(() => ({ url: '', title: '', text: '' }));
      if (looksLikeRiskControl(s)) {
        log('监控期间出现风控验证，停止并转人工。', 'err');
        await report({ outcome: 'WAITING_HUMAN', resultCode: 'CAPTCHA', message: '回流监控中出现风控验证', humanAction: '请人工处理后重跑', evidence: ev(stateRef) });
        return { done: { ok: false, outcome: 'WAITING_HUMAN' } };
      }
      if (ON_LOGIN_PAGE.test(s.url + ' ' + s.title) || NOT_LOGIN.test(s.text)) {
        const lr = await readLoginState(cdp);
        if (lr.loggedIn === true) {
          log(`监控期间文案像掉线，但登录凭据仍在（${lr.evidence}），忽略文案抖动。`);
        } else {
          log(`监控期间登录掉线（${lr.evidence}）：等人登回，监控继续（恢复后自动续上）。`, 'warn');
          await report({ outcome: 'WAITING_HUMAN', resultCode: 'NEEDS_LOGIN', message: '回流监控中登录掉线（监控值守不放弃）', humanAction: '随时在专用窗口重新登录即可' });
          try { await waitLoginFlow(deadline); } catch { return { done: { ok: false, outcome: 'MONITOR_GIVE_UP' } }; }
          return null;
        }
      }
      {
        const mm = skuPageMismatch(s.text, slot.prdId, slot.sbomCode);
        if (mm) {
          mismatchRestores++;
          if (mismatchRestores >= 3) {
            log(`页面已选「${mm.got}」连续拉不回绑定规格，停止（防抢错）。`, 'err');
            await report({ outcome: 'FAILED', resultCode: 'WRONG_SKU', message: `页面已选「${mm.got}」≠ 槽位绑定规格`, evidence: ev(stateRef) });
            return { done: { ok: false, outcome: 'WRONG_SKU' } };
          }
          log(`监控轮发现页面已选「${mm.got}」≠ 绑定规格，导航回绑定规格。`, 'warn');
          try { await cdp.send('Page.navigate', { url: targetUrl }); await waitPageReady(800); } catch { /* 下一轮再试 */ }
          return null;
        }
        mismatchRestores = 0;
      }
      const buy = await cdp.eval(buyExpr(false)).catch(() => null);
      if (!buy) return null;
      const pos = await cdp.eval(buyExpr(true)).catch(() => null);
      if (!pos) return null;
      const waitedMin = Math.round((Date.now() - (triggerLocalMs || monStart)) / 60000);
      log(`🎉 回流捕获（整页刷新，开售后约 ${waitedMin} 分钟）：「${pos.label}」出现，出手…`, 'ok');
      const r = await triggerBuyFlow(pos);
      if (r.kind === 'LOGIN_LOST') {
        log('点击后被带到登录页，等登录后继续监控。', 'warn');
        try { await waitLoginFlow(deadline); } catch { return { done: { ok: false, outcome: 'MONITOR_GIVE_UP' } }; }
        return null;
      }
      if (r.kind === 'CONFIRMED') return { done: await finishConfirmed(r.confirmTab, pos, true) };
      // 回流可能是幻觉或瞬间被抢走：读一眼提示语（已售完/超上限等），继续监控
      const tip = (r.after.text.match(/抱歉[^\n]{0,24}|已售完[^\n]{0,16}|超过购买上限[^\n]{0,16}|暂不可购买[^\n]{0,16}/) || [])[0];
      log(`点击后未进确认页${tip ? `（页面提示：${tip.trim()}）` : ''}，继续监控。`, 'warn');
      return null;
    }
  }

  // T0 出手闸门（2026-10-07）：设了开售时间（triggerLocalMs）就严格到点前 ~500ms 才允许出手。
  // 背景：现货商品挂人工 saleAt 测速时，按钮一开始就是"立即购买"，没有这个闸门会
  // 一进监听就提前出手。真抢场景零影响：R1 在 T0-leadMs 解锁按钮，闸门（≥500ms 或
  // leadMs+200 取大）比解锁更早放开，出手仍落在解锁瞬间；按钮锁定期间本就无可买状态。
  const T0_ACT_LEAD_MS = Math.max(500, (((config.intercept || {}).leadMs) || 300) + 200);
  let hotIter = 0;
  let oosStreak = 0; // 缺货信号连续轮数（防 T0 刚过按钮未渲染+文案误报 → 提前转监控）
  while (Date.now() < giveUpAt) {
    const inHot = !triggerLocalMs || Date.now() >= triggerLocalMs - hotWindowMs;
    const canAct = !triggerLocalMs || Date.now() >= triggerLocalMs - T0_ACT_LEAD_MS;
    if (!inHot) {
      // —— 慢速重检查路径（离 T0 还远）：全文状态 + 完整按钮扫描，不差这点时间 ——
      try { st = await state(); } catch { await sleep(slowMs); continue; }
      if (looksLikeRiskControl(st)) {
        log('运行中出现风控验证，停止并转人工。', 'err');
        await report({ outcome: 'WAITING_HUMAN', resultCode: 'CAPTCHA', message: '运行中检测到风控验证', humanAction: '请人工处理后重跑', evidence: ev(stateRef) });
        return { ok: false, outcome: 'WAITING_HUMAN' };
      }
      if (ON_LOGIN_PAGE.test(st.url + ' ' + st.title) || NOT_LOGIN.test(st.text)) {
        const lr = await readLoginState(cdp);
        if (lr.loggedIn === true) {
          log(`文案像掉线，但登录凭据仍在（${lr.evidence}），忽略文案抖动。`);
        } else {
          await waitLoginFlow();
          attempts = 0; // 登录恢复不算失败
          log('登录恢复，重新盯按钮', 'ok');
        }
        continue;
      }
      // 页面"已选"≠绑定规格（比如被人手动切过）→ 拉回绑定规格再盯
      {
        const mmr = skuPageMismatch(st.text, slot.prdId, slot.sbomCode);
        if (mmr) {
          log(`页面已选「${mmr.got}」≠ 绑定规格，导航回绑定规格再继续。`, 'warn');
          await cdp.send('Page.navigate', { url: targetUrl });
          await waitPageReady(800);
          await sleep(slowMs);
          continue;
        }
      }
      let buy = null;
      try { buy = await cdp.eval(buyExpr(false)); } catch { await sleep(slowMs); continue; }
      if (buy && canAct) {
        const pos = await cdp.eval(buyExpr(true)).catch(() => buy);
        const r = await clickBuyFlow(pos);
        if (r && r.done) return r.done;
        if (r && r.relogin) continue;
      }
      await sleep(slowMs);
      continue;
    }
    // —— 高频轻量路径（T0 前热窗 + 开售后）：一轮一次 evaluate，锁定态微秒级 ——
    hotIter++;
    const postT0 = !triggerLocalMs || Date.now() >= triggerLocalMs;
    // 预开确认页路径：提交时机对准 T0（不再沿用 T0-500ms 的点击提前量——
    // 审计 P1-2：太早发会被服务器以"未开始"拒收且旧版失败不补发）。
    // limits.preOpenSubmitLeadMs 默认 0 = 服务器钟 T0 一到就发（请求到达 ≈T0+网络延迟，
    // 宁可晚到几十毫秒也不被拒）；实测网络延迟后可调到 50~150ms 让请求"踩点到达"。
    const preOpenAct = !triggerLocalMs || Date.now() >= triggerLocalMs - (limits.preOpenSubmitLeadMs ?? 0);
    if (preOpenAct && preOpenedConfirm) {
      try {
        const ts = await listTabs(port).catch(() => []);
        const ct = ts.find((t) => /orderConfirm/.test(t.url || ''));
        if (ct) {
          log('到点：在预开的确认订单页上直接提交。');
          const done = await finishConfirmed(ct, null);
          if (done) return done;
        }
        preOpenedConfirm = false;
        log('预开的确认页不可用，回落常规抢购流程。', 'warn');
      } catch (e) {
        preOpenedConfirm = false;
        log(`预开页提交异常（${e.message}），回落常规抢购流程。`, 'warn');
      }
    }
    // A 方案：热窗内按节拍调页面内部入口（不 await——调用要快，确认页拾取交给
    // maybePickConfirm）。实测未解锁时调用零副作用（未开售 fire 页面毫无变化），
    // 所以从进热窗就开调——R1 提前解锁生效时这里直接收益；失败自动停用回落真点击。
    if (internalArmed && canAct && !preOpenedConfirm && Date.now() - lastInternalAt >= Math.max(internalFireMs, hotMs)) {
      lastInternalAt = Date.now();
      internalFire();
    }
    if (postT0) {
      const picked = await maybePickConfirm();
      if (picked) return picked;
    }
    const fc = await cdp.eval(fastCheckExpr(postT0 || hotIter % 10 === 0)).catch(() => null);
    if (!fc) { await sleep(hotMs); continue; }
    if (fc.challenge) {
      log('运行中出现风控验证，停止并转人工。', 'err');
      await report({ outcome: 'WAITING_HUMAN', resultCode: 'CAPTCHA', message: '运行中检测到风控验证', humanAction: '请人工处理后重跑', evidence: ev(stateRef) });
      return { ok: false, outcome: 'WAITING_HUMAN' };
    }
    if (fc.notLogin) {
      // 文案报警 → 用浏览器凭据核实（热路径每轮读 Cookie 太贵，只在报警时读）
      const lr = await readLoginState(cdp);
      if (lr.loggedIn === false || lr.loggedIn === null) {
        log(`高频监听中发现掉线（${lr.evidence}），等登录恢复。`, 'warn');
        await waitLoginFlow();
        attempts = 0;
      } else {
        log(`文案显示"请登录"，但登录凭据仍在（${lr.evidence}），按文案抖动忽略。`);
      }
      continue;
    }
    if (fc.yixuan) {
      const mmr = skuPageMismatch(fc.yixuan, slot.prdId, slot.sbomCode);
      if (mmr) {
        log(`页面已选「${mmr.got}」≠ 绑定规格，导航回绑定规格再继续。`, 'warn');
        await cdp.send('Page.navigate', { url: targetUrl });
        await waitPageReady(800);
        await sleep(hotMs);
        continue;
      }
    }
    if (fc.buy && canAct && !preOpenedConfirm) {
      unlockSeen = true; E.ev('UNLOCK_SEEN', fc.buy.label); // 解锁信号：internal 从下一轮起 Yo/goBuy 交替（每轮只调一个，不会双开）
      const r = await clickBuyFlow(fc.buy);
      if (r && r.done) return r.done;
      if (r && r.relogin) continue;
    } else {
      // 缺货判定只在开售时刻之后才生效，且要连续 2 轮 + T0 后 2 秒（防按钮未渲染期误判）
      if (fc.oos && postT0) {
        oosStreak++;
        const oosDue = oosStreak >= 2 && (!triggerLocalMs || Date.now() >= triggerLocalMs + 2000);
        if (oosDue) {
          if (monitorEnabled) {
            // 未抢到 → 不退出，转回流监控（等未付款超时/退单回流的库存）
            log('SKU 缺货（未抢到，连续 2 轮确认）：转回流监控。', 'warn');
            E.ev('OOS_TO_MONITOR', fc.yixuan || '');
            sawOutOfStock = true;
            break;
          }
          log('槽位绑定的 SKU 缺货（页面无购买按钮且显示缺货），rush 模式结束。', 'warn');
          await report({ outcome: 'FAILED', resultCode: 'OUT_OF_STOCK', message: 'SKU 缺货：' + (fc.yixuan || ''), evidence: ev(stateRef) });
          return { ok: false, outcome: 'OUT_OF_STOCK' };
        }
      } else {
        oosStreak = 0;
      }
      // 保险丝：开售后按钮迟迟不出现 → 绕缓存强刷一次（仅一次）
      if (triggerLocalMs && !fuseUsed && Date.now() >= triggerLocalMs + fuseDelayMs) {
        fuseUsed = true;
        const fuseInfo = slot.sbomCode ? await probeRushbuyInfo(slot.sbomCode, stateRef.ua) : null;
        if (fuseInfo && fuseInfo.item) log(`强刷前状态接口快照：${JSON.stringify(fuseInfo.item).slice(0, 400)}`, 'warn');
        log(`开售后 ${(Date.now() - triggerLocalMs) / 1000 | 0} 秒按钮仍未出现：绕缓存强刷一次（保险丝，仅此一次）…`, 'warn');
        try {
          await cdp.send('Network.enable');
          await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        } catch { /* 内核不支持就算了，&_r= 参数也能破 URL 级缓存 */ }
        try {
          await cdp.send('Page.navigate', { url: `${targetUrl}&_r=${Date.now()}` });
          await waitPageReady(1200);
        } catch (e) {
          log(`强刷后等页面出错（${e.message}），继续盯按钮`, 'warn');
        }
      }
    }
    await sleep(hotMs);
  }
  if (monitorEnabled && (sawOutOfStock || Date.now() >= giveUpAt)) {
    const r = await runMonitor();
    if (r) return r;
    if (sawOutOfStock) {
      // 监控没能启动（活动已结束等）→ 按缺货收尾
      log('回流监控未启动，按缺货收尾。');
      await report({ outcome: 'FAILED', resultCode: 'OUT_OF_STOCK', message: 'SKU 缺货且无可监控的活动窗口', evidence: ev(stateRef) });
      return { ok: false, outcome: 'OUT_OF_STOCK' };
    }
  }
  if (Date.now() >= giveUpAt) {
    log('超时放弃（giveUpAfterMs）。', 'warn');
    E.ev('GIVE_UP');
    await report({ outcome: 'FAILED', resultCode: 'GIVE_UP', message: '盯盘超时，未发现可买', evidence: ev(stateRef) });
    return { ok: false, outcome: 'GIVE_UP' };
  }
  return { ok: false, outcome: 'STOPPED' };

  function ev(ref, buy, pos) {
    return {
      visibleTextLength: ref.last.text.length,
      visibleTextHead: ref.last.text.slice(0, 6000),
      ...(buy ? { buyLabel: buy.label } : {}),
      ...(pos ? { clickPoint: pos } : {}),
    };
  }
}

/** 轻量保温操作：动鼠标 + 上下滚动（全部真实输入事件，不碰页面任何请求）。
 *  坐标/幅度/节奏都随机（2026-10-08）：每次一模一样的轨迹也是机器人指纹。 */
async function lightActivity(cdp) {
  const rnd = (min, max) => Math.round(min + Math.random() * (max - min));
  const [x1, y1, x2, y2] = [rnd(300, 700), rnd(200, 500), rnd(300, 700), rnd(200, 500)];
  const down = rnd(180, 480), up = -rnd(180, 480);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, pointerType: 'mouse' });
  await sleep(rnd(120, 500));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x1, y: y1, deltaX: 0, deltaY: down, pointerType: 'mouse' });
  await sleep(rnd(200, 700));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: x1, y: y1, deltaX: 0, deltaY: up, pointerType: 'mouse' });
  await sleep(rnd(120, 400));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x2, y: y2, pointerType: 'mouse' });
}

/** 真模式（dryRun=false）才会走到这里。同样只做可信点击，读真实结果，绝不编造。 */
async function submitOrder(cdp, ctx) {
  const { config, report, stateRef, log } = ctx;
  const EV = ctx.E || { ev() {}, shot() {}, text() {} }; // 老调用方没传 E 也能跑
  const tClick0 = Date.now();
  let pos = null; // 兜底点击坐标（evidence 里要带；内部路径成功时保持 null）
  // 提交按钮挂载探测节拍：2026-10-08 从 300ms 收紧到 100ms（真机实测按钮可见要
  // ~5.8s，探测节拍直接决定"提交发出去"的时刻；100ms 在 CPU 上可忽略）
  const PROBE_MS = 100;

  /** 等待「提交订单」按钮挂载（真机实测确认页出现→按钮可见要 3~6s，高峰 5.8s） */
  async function waitSubmitButton(deadlineMs) {
    const CHECK = `(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      for (const el of document.querySelectorAll('a,button,div,span')) {
        const t = clean(el.innerText);
        if (!t || t.length > 6 || !t.includes('提交订单')) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    })()`;
    while (Date.now() < deadlineMs) {
      try { if (await cdp.eval(CHECK)) return true; } catch { /* 页面跳转瞬时 */ }
      await sleep(PROBE_MS);
    }
    return false;
  }

  // ① 内部提交入口（2026-10-07 侦察实证 probe-confirm-entry.mjs）：确认页"提交订单"
  //    按钮的 fiber 向上 8~13 层挂着 handleOrderSubmit——按钮自己的处理器（内部走
  //    防抖的 orderConfirmSubmit）。直接调它 = 免滚动、免坐标、免渲染依赖，后台照常
  //    执行，语义与点击完全一致。失败自动回落真实点击；config.internalSubmit=false 关闭。
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
  /** 发一次提交（内部优先）。返回 'internal' | 'click' | null（没发出去） */
  async function submitOnce() {
    if (config.internalSubmit !== false) {
      const waitDeadline = Date.now() + 30000;
      let entryRetries = 0;
      let evalErrs = 0;
      while (Date.now() < waitDeadline) {
        const iv = await cdp.send('Runtime.evaluate', {
          expression: INTERNAL_EXPR, returnByValue: true, userGesture: true,
        }).then((r) => r.result && r.result.value)
          .catch((e) => ({ s: 'EVAL_ERR', msg: e.message }));
        if (iv && iv.s === 'FIRED') {
          log(`内部提交入口已调用（handleOrderSubmit，向上 ${iv.hops} 层，从接管起等待 ${((Date.now() - tClick0) / 1000).toFixed(1)}s）——提交请求由页面自身发出。`);
          EV.ev('SUBMIT_VIA', 'internal hops=' + iv.hops + ' wait=' + ((Date.now() - tClick0) / 1000).toFixed(1) + 's');
          return 'internal';
        }
        if (iv && iv.s === 'NO_BUTTON') { evalErrs = 0; await sleep(PROBE_MS); continue; } // 页面还在挂载，等
        if (iv && iv.s === 'EVAL_ERR') {
          evalErrs++;
          if (evalErrs >= 10) break;
          await sleep(PROBE_MS); continue;
        }
        if (iv && iv.s === 'NO_ENTRY') {
          entryRetries++;
          if (entryRetries <= 2) { await sleep(PROBE_MS); continue; } // 按钮刚出、fiber 还没挂稳：只给 2 轮（0.2s）就回落点击
          break;
        }
        if (iv && iv.s === 'ERR') break; // 调用报错不重试（防重复提交），转点击
        break;
      }
      log('内部提交入口不可用，回落真实点击。', 'warn');
    }
    // 兜底：真实点击（等按钮挂载 → 滚动 → 坐标稳定 → 点击）
    if (!(await waitSubmitButton(Date.now() + 30000))) {
      log('未找到「提交订单」按钮，可能已进收银台或结构变了，停止等待人工。', 'warn');
      await report({ outcome: 'WAITING_HUMAN', resultCode: 'SUBMIT_NOT_FOUND', message: '提交阶段没找到提交订单按钮', humanAction: '请人工查看页面' });
      return null;
    }
    const clickAt = `(() => {
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
      const r = hit.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`;
    pos = await cdp.eval(clickAt).catch(() => null);
    if (!pos) {
      log('「提交订单」按钮不见了，停止等待人工。', 'warn');
      await report({ outcome: 'WAITING_HUMAN', resultCode: 'SUBMIT_NOT_FOUND', message: '提交阶段按钮消失', humanAction: '请人工查看页面' });
      return null;
    }
    // 坐标稳定判断：连读两次一致才点（滚动/懒渲染会让坐标漂移、点击落空）。
    // 2026-10-08 从固定 300ms 硬睡改为稳定判断（两次一致即点，最长 400ms）。
    for (let i = 0; i < 4; i++) {
      await sleep(100);
      const pos2 = await cdp.eval(clickAt).catch(() => null);
      if (!pos2) break;
      if (pos2.x === pos.x && pos2.y === pos.y) break;
      pos = pos2;
    }
    log(`真实点击「提交订单」(${pos.x},${pos.y})`);
    EV.ev('SUBMIT_VIA', 'click (' + pos.x + ',' + pos.y + ')');
    await trustedClick(cdp, pos.x, pos.y);
    return 'click';
  }

  const maxAttempts = 1 + (config.limits?.submitErrorRetryMax ?? 2); // 首发之外，只在"明确失败信号"时补发
  let clickedVia = null;
  let handoffReported = false; // submitOnce 里已按"转人工"上报过（SUBMIT_NOT_FOUND），外层不再重复报
  let orderNo = null;
  let addressMissing = false;
  let atCashier = false;
  let lastText = '';
  // 明确的失败信号（出现这些字样且没有订单号/收银台 → 判定这一发没成，允许补发）。
  // ★ 2026-10-08 真场实测：服务器拒单话术是「您下单的商品火爆销售中，请稍后再试。」——
  //   必须识别为可补发的失败，而不是当成"缺地址/结果未知"停下。
  const SUBMIT_FAIL = /提交失败|下单失败|订单提交失败|网络异常|系统繁忙|火爆|请稍后再试|活动未开始|尚未开始|开售后再试|稍后重试/;
  for (let attempt = 1; attempt <= maxAttempts && !clickedVia; attempt++) {
    // 首发立即打；补发前歇 400ms（页面提交按钮自带 ~1s 防抖，歇太近等于没点）
    if (attempt > 1) await sleep(400);
    const via = await submitOnce();
    if (!via) { handoffReported = true; break; } // 没发出去（人工接管的报备已发）
    clickedVia = via;
    // 提交后轮询结果：前 3 秒 200ms 一拍（尽早读到订单号），之后 500ms
    for (let i = 0; i < 30; i++) {
      await sleep(i < 15 ? 200 : 500);
      try { stateRef.last = await cdp.eval(stateExpr); } catch { continue; }
      lastText = stateRef.last.text || '';
      orderNo = (lastText.match(/订单号[：:\s]*([A-Za-z0-9]+)/) || [])[1] || null;
      if (orderNo) break;
      if (/微信支付|支付宝|收银台|立即支付/.test(lastText)) { atCashier = true; break; }
      // ★ 失败信号必须先于地址判断：被拒（火爆/网络异常…）说明这一发没成，还有名额就补发。
      //   实测踩坑：确认页上"新增收货地址"是常驻按钮（有地址也在），不能当缺地址的判据。
      if (SUBMIT_FAIL.test(lastText)) {
        log(`提交被拒（${(lastText.match(SUBMIT_FAIL) || [''])[0]}），${attempt < maxAttempts ? '稍等补发' : '补发名额用完，不再补发'}。`, 'warn');
        EV.ev('SUBMIT_REJECTED', (lastText.match(SUBMIT_FAIL) || [''])[0] + ' attempt=' + attempt);
        EV.shot(cdp, 'confirm-rejected-' + attempt);
        EV.text('confirm-text-rejected-' + attempt, lastText);
        clickedVia = null; // 让外层循环再进一次 submitOnce
        break;
      }
      if (i >= 3 && /请(填写|选择)[^。\n]{0,10}收货地址/.test(lastText)) { addressMissing = true; break; }
    }
  }
  if (!clickedVia && !orderNo && !atCashier && !handoffReported) {
    // 一发都没成且没有成果信号：如实上报（不编造）
    await report({
      outcome: 'RESULT_UNKNOWN', resultCode: 'SUBMIT_NO_EFFECT',
      message: '提交动作未能完成或页面未给出明确结果',
      evidence: {
        visibleTextLength: lastText.length,
        visibleTextHead: lastText.slice(0, 6000),
        clickPoint: pos,
      },
    });
    return;
  }
  const outcome = orderNo || atCashier ? 'ORDER_SUBMITTED'
    : addressMissing ? 'WAITING_HUMAN' : 'RESULT_UNKNOWN';
  const resultCode = orderNo ? null
    : addressMissing ? 'ADDRESS_MISSING'
    : atCashier ? 'AT_CASHIER' : 'SUBMIT_OUTCOME_UNCLEAR';
  const message = orderNo
    ? `已提交订单（${clickedVia === 'internal' ? '内部入口' : clickedVia === 'click' ? '真实点击' : '页面反馈'}），订单号 ${orderNo}（提交后 ${((Date.now() - tClick0) / 1000).toFixed(1)}s 读到结果）`
    : addressMissing
      ? '提交被拦：确认页没有收货地址——先在窗口里补地址，补好后可手动提交或重跑'
      : atCashier
        ? '已进入收银台（订单已创建），去专用窗口完成支付或取消'
        : '已点击提交订单但未读到明确订单号';
  EV.ev('SUBMIT_OUTCOME', outcome + ' ' + (orderNo || '') + ' via=' + clickedVia + ' +' + ((Date.now() - tClick0) / 1000).toFixed(1) + 's');
  EV.shot(cdp, 'confirm-after-submit');
  EV.text('confirm-final-text', lastText);
  await report({
    outcome, resultCode, message,
    orderNo: orderNo || undefined,
    humanAction: addressMissing ? '在专用窗口的确认页补上收货地址后手动提交，或补好后重跑' : undefined,
    evidence: {
      visibleTextLength: lastText.length,
      visibleTextHead: lastText.slice(0, 6000),
      clickPoint: pos,
    },
  });
}

async function main() {
  const config = await (await fetch(`${BRIDGE}/api/config/${PLATFORM}`)).json();
  const slotsFile = JSON.parse(readFileSync(new URL('../../data/grab/rush-slots.huawei.json', import.meta.url), 'utf8'));
  const slots = (slotsFile.slots || []).filter((s) => s && s.id && s.prdId && s.sbomCode && s.port);
  if (!slots.length) throw new Error('rush-slots.json 里没有可用槽位');
  const chosen = args.slot ? slots.filter((s) => s.id === String(args.slot)) : slots;
  if (!chosen.length) throw new Error(`找不到槽位 ${args.slot}（现有：${slots.map((s) => s.id).join(', ')}）`);

  // 总开关：配置里 enabled=false 就整个不动（与油猴脚本一致）。
  if (config.enabled === false) throw new Error('配置里 enabled=false，全部槽位不动作（需要跑就在控制台把"启用"打开）');

  // 起飞前先把商品列表对齐情况打出来：哪几个槽位在列表内、哪几个会被闸门拦下。
  // 不在商品列表里的槽位绝不打开窗口。
  const runnable = [];
  const blocked = [];
  for (const s of chosen) {
    const p = (config.products || []).find((x) => extractPrdId(x.url) === String(s.prdId));
    if (!p) { blocked.push(`${s.id}(prdId=${s.prdId} 不在商品列表)`); continue; }
    if (p.enabled === false) { blocked.push(`${s.id}(商品「${p.id || s.prdId}」已停用)`); continue; }
    const want = Array.isArray(p.skuIds) ? p.skuIds.map(String).filter(Boolean) : [];
    if (want.length && !want.includes(String(s.sbomCode))) { blocked.push(`${s.id}(规格 ${s.sbomCode} 未勾选)`); continue; }
    runnable.push({ slot: s, product: p });
  }
  console.log(`商品列表共 ${(config.products || []).length} 项；本次可跑 ${runnable.length}/${chosen.length} 个槽位`);
  if (runnable.length) console.log(`  可跑：${runnable.map((r) => `${r.slot.id}→${r.product.id || r.slot.prdId}`).join('、')}`);
  if (blocked.length) console.log(`  ⛔ 不在商品列表/未勾选，本槽位不做任何操作：${blocked.join('、')}`);
  if (!runnable.length) { console.log('没有可跑槽位，全部被商品列表闸门拦下。'); process.exit(1); }

  const results = await Promise.allSettled(
    runnable.map((r, i) => (async () => {
      await sleep(i * 800); // 错峰启动窗口
      return runSlot(r.slot, config);
    })()),
  );

  // 收尾：关掉跨商品预热留下的确认页草稿（它们只是焐缓存用的，不是成果页）
  for (const { port: p, tabId } of warmupConfirmTabs.values()) {
    await fetch(`http://127.0.0.1:${p}/json/close/${tabId}`).catch(() => {});
  }
  if (warmupConfirmTabs.size) console.log(`已清理 ${warmupConfirmTabs.size} 个预热确认页草稿。`);

  console.log('\n===== 槽位结果汇总 =====');
  let fail = 0;
  results.forEach((r, i) => {
    const id = runnable[i].slot.id;
    if (r.status === 'fulfilled') {
      console.log(`  ${id}: ${r.value.outcome}${r.value.ok ? ' ✅' : ' ⚠️'}`);
      if (!r.value.ok) fail++;
    } else {
      console.log(`  ${id}: 异常 ${r.reason?.message || r.reason} ❌`);
      fail++;
    }
  });
  // 必须显式退出：跑完的槽位上还开着 CDP WebSocket，会吊住进程不退，
  // 桥接就一直显示"运行中"，下次派发会被 409 挡住（2026-10-07 实测踩坑）。
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(`[驱动异常] ${e.message}`);
  process.exitCode = 1;
});
