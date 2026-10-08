#!/usr/bin/env node
/**
 * 华为商城 · 改版体检（定期维护工具）
 * =====================================================================
 * 为什么需要：抢购脚本押注在 vmall 的页面结构/接口形状/内部函数上，
 * 华为一改版任何一处，脚本就会静默失效——等到真实场次才发现就晚了。
 * 本脚本把所有"押注"逐项对着真实环境验证一遍，改版当天就能发现，
 * 且每项失败都给出"改哪里"的提示（改配置可修的改配置，必须改代码的指到文件）。
 *
 * 检查项（PASS=健康 / DRIFT=漂移需跟修 / SKIP=条件不具备 / FAIL=环境故障）：
 *   C0 商品列表闸门（槽位的 prdId/sbomCode 必须在 huawei.config.json 的 products[]
 *      里、且规格已勾选。不在列表内 → 本次体检一个窗口都不开，直接停在这一项）
 *   C1 槽位窗口/标签/登录态（窗口能起、商品页能开、是登录态）
 *   C2 购买按钮锚点 #prd-botnav-rightbtn + 文案字典（fastCheckExpr 的两大押注）
 *   C3 queryRushbuyInfo.json 字段形状 + R1 改写规则干跑（对真实响应体）
 *   C4 校时接口 + 本地钟偏差实测（openapi serverTime.json）
 *   C5 __NEXT_DATA__ 数据通道（爬虫与 SKU 核对的押注）
 *   C6 B 规则 URL 匹配器 vs 真实响应 URL（+ 排队页样本状态）
 *   C7 A 方案内部入口（React fiber → onPress 闭包 → Yo/goBuy，2026-10-07 走通版；triggerMode=internal 的前提）
 *   C7a 旧全局路径 window.rush.business.doGoRush（2020 版，已死；保留观察面）
 *   C8 价格读取（maxPrice 上限保护的押注）
 *
 * 用法：
 *   node platforms/huawei/checkup-vmall.mjs              # 全部检查（默认第一个槽位）
 *   node platforms/huawei/checkup-vmall.mjs --slot=acc1  # 指定槽位
 *   node platforms/huawei/checkup-vmall.mjs --json       # stdout 输出 JSON（供桥接）
 *
 * 退出码：0=全部 PASS/SKIP；1=存在 DRIFT/FAIL。
 * 报告：data/grab/checkup-report.json（最新一份）+ checkup-history.jsonl（追加历史）。
 * =====================================================================
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CDP, cdpUp, listTabs, waitTab, ensureSlotWindow, sleep, logFor, readLoginState, probeLoginApi } from '../../core/cdp-core.mjs';
import { calibrateClock, fetchRushbuyInfoRaw } from './vmall-api.mjs';
import { MATCH, dryRunRushInfo } from './intercept/rules.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GRAB_DIR = new URL('../../data/grab/', import.meta.url);
const REPORT_PATH = new URL('../../data/grab/checkup-report.json', import.meta.url);
const HISTORY_PATH = new URL('../../data/grab/checkup-history.jsonl', import.meta.url);
const ON_LOGIN_PAGE = /login|passport|华为账号/i;
const NOT_LOGIN = /请登录|立即登录|账号登录/;
const LEAD_MS = 300;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const log = logFor('checkup');
const ICON = { PASS: '✅', DRIFT: '⚠️ ', SKIP: '○ ', FAIL: '❌' };

/** 检查结果工厂 */
const ok = (id, name, detail, fix) => ({ id, name, status: 'PASS', detail, ...(fix ? { fix } : {}) });
const drift = (id, name, detail, fix) => ({ id, name, status: 'DRIFT', detail, fix });
const skip = (id, name, detail) => ({ id, name, status: 'SKIP', detail });
const fail = (id, name, detail, fix) => ({ id, name, status: 'FAIL', detail, ...(fix ? { fix } : {}) });

async function main() {
  const t0 = Date.now();
  const slotsFile = JSON.parse(readFileSync(new URL('../../data/grab/rush-slots.huawei.json', import.meta.url), 'utf8'));
  const slots = (slotsFile.slots || []).filter((s) => s && s.id && s.prdId && s.sbomCode && s.port);
  if (!slots.length) throw new Error('rush-slots.huawei.json 里没有可用槽位');
  const slot = args.slot ? slots.find((s) => s.id === String(args.slot)) : slots[0];
  if (!slot) throw new Error(`找不到槽位 ${args.slot}`);

  // 配置直接读盘（体检必须独立于桥接服务可跑）
  let config = {};
  try { config = JSON.parse(readFileSync(new URL('../../data/grab/huawei.config.json', import.meta.url), 'utf8')); } catch { /* 全用默认 */ }
  const product = (config.products || []).find((p) => String(p.prdId ?? (p.url || '').match(/prdId=(\d+)/)?.[1]) === String(slot.prdId));
  const targetUrl = `https://item.vmall.com/product/comdetail/index.html?prdId=${slot.prdId}&sbomCode=${slot.sbomCode}`;

  const checks = [];

  // ── C0 商品列表闸门（与抢购驱动同一把锁）──
  // 体检也开着浏览器窗口，逻辑上同样属于"操作商品"。
  // 不在商品列表里的商品，体检直接停在这一项，一个窗口都不开。
  if (!product) {
    checks.push(fail('C0', '商品列表闸门', `槽位 ${slot.id} 的 prdId=${slot.prdId} 不在商品列表里，本次体检不碰它`,
      `要么在控制台「商品与 SKU」页把这个商品加进列表，要么删掉 rush-slots.huawei.json 里的这个槽位`));
    return finish(checks, slot, t0);
  }
  if (product.enabled === false) {
    checks.push(fail('C0', '商品列表闸门', `商品「${product.id || slot.prdId}」已停用（enabled=false），本次体检不碰它`,
      '在控制台把该商品的"启用"打开后再体检'));
    return finish(checks, slot, t0);
  }
  const wantSboms = Array.isArray(product.skuIds) ? product.skuIds.map(String).filter(Boolean) : [];
  if (wantSboms.length && !wantSboms.includes(String(slot.sbomCode))) {
    checks.push(fail('C0', '商品列表闸门', `规格 ${slot.sbomCode} 不在商品「${product.id || slot.prdId}」勾选的规格里（已勾选：${wantSboms.join('、')}）`,
      '在控制台「商品与 SKU」页勾上这个规格，或改槽位绑定的 sbomCode'));
    return finish(checks, slot, t0);
  }
  checks.push(ok('C0', '商品列表闸门', `槽位 ${slot.id} → 商品「${product.id || slot.prdId}」在列表内` + (wantSboms.length ? `（已勾选 ${wantSboms.length} 个规格）` : '（未限规格）')));

  // ── C1 槽位窗口/标签/登录态 ──
  let cdp = null;
  let ua = null;
  let pageState = null;
  try {
    await ensureSlotWindow(slot, targetUrl, log);
    if (!(await cdpUp(slot.port))) throw new Error('窗口拉起后调试端口仍不可达');
    const tab = await waitTab(slot.port, slot.prdId, slot.sbomCode, 30000);
    cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable').catch(() => {}); // 读登录凭据要用
    ua = await cdp.eval('navigator.userAgent');
    // 就位到绑定 SKU 页（与抢购驱动同一 targetUrl）
    await cdp.send('Page.navigate', { url: targetUrl });
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      pageState = await cdp.eval(`(() => ({ url: location.href, title: document.title, ready: document.readyState, text: document.body ? document.body.innerText : '' }))()`).catch(() => null);
      if (pageState && pageState.ready === 'complete' && pageState.text) break;
    }
    await sleep(2500); // 等页头水合（页头会先短暂显示"请登录"，所以不拿文案当判据）
    pageState = await cdp.eval(`(() => ({ url: location.href, title: document.title, text: document.body ? document.body.innerText : '' }))()`);
    const onComdetail = /comdetail/.test(pageState.url) && pageState.url.includes(String(slot.prdId));
    // 登录态：优先问页面自己的 queryUserInfo 接口（能识别"Cookie 残留但会话已死"），
    // 接口问不出来才退回读浏览器凭据。都不看页面文案。
    const api = await probeLoginApi(cdp);
    const lr = api.loggedIn === null ? await readLoginState(cdp) : api;
    const loginNote = lr.loggedIn === true ? `登录正常（${lr.evidence}）`
      : lr.loggedIn === false ? `未登录（${lr.evidence}）`
      : `登录态问不出来（${lr.evidence}）`;
    if (!onComdetail) {
      checks.push(fail('C1', '槽位窗口与登录态', `未能就位商品页（当前 ${pageState.url.slice(0, 80)}）`, '检查槽位 prdId/sbomCode 是否仍有效（商品可能下架）'));
    } else if (lr.loggedIn === false) {
      checks.push(drift('C1', '槽位窗口与登录态', `窗口与页面正常，但没有登录态：${lr.evidence}`, '在专用窗口里登录华为账号（登录一次长期有效）；抢购日掉线会直接废掉首发'));
    } else if (lr.loggedIn === null) {
      checks.push(skip('C1', '槽位窗口与登录态', `页面就位，但${loginNote} —— 无法判断登录态`));
    } else {
      checks.push(ok('C1', '槽位窗口与登录态', `端口 ${slot.port} · 商品页就位 · ${loginNote}`));
    }
  } catch (e) {
    checks.push(fail('C1', '槽位窗口与登录态', `窗口/标签/页面异常：${e.message}`, `试着手动打开 ${targetUrl} 看页面是否正常；或删除 data/grab/chrome-profile-rush/${slot.id} 重开（需重新登录）`));
  }

  // ── C2 按钮锚点 + 文案字典 ──
  if (cdp && pageState && /comdetail/.test(pageState.url)) {
    const r = await cdp.eval(`(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const BUY = ['立即购买', '立即申购', '加入购物车', '立即预订', '马上抢', '立即抢购'];
      const anchor = document.getElementById('prd-botnav-rightbtn');
      const anchorText = anchor ? clean(anchor.innerText) : null;
      const text = document.body ? document.body.innerText : '';
      const buyHit = BUY.find((k) => text.includes(k));
      const presale = ['暂不售卖', '即将开售', '已售罄', '暂时缺货', '补货中', '提醒我'].find((k) => text.includes(k));
      return { anchor: !!anchor, anchorText, buyHit: buyHit || null, presale: presale || null };
    })()`).catch(() => null);
    if (!r) checks.push(fail('C2', '购买按钮锚点', '页面表达式执行失败', '重跑一次；仍失败说明页面 JS 环境有变'));
    else if (r.anchor) checks.push(ok('C2', '购买按钮锚点', `#prd-botnav-rightbtn 存在（当前文案「${r.anchorText || '空'}」${r.presale ? `，页面处于预售/售罄态：${r.presale}` : ''}）`));
    else if (r.buyHit) checks.push(drift('C2', '购买按钮锚点', `锚点 #prd-botnav-rightbtn 不存在，但文案「${r.buyHit}」仍能全页扫到（抢购会慢一拍：只剩全页兜底扫描）`, '侦察新锚点：verify/history 里跑 probe-sku-dom.mjs，把新 id 更新进 cdp-rush.mjs 的 fastCheckExpr/buyExpr'));
    else if (r.presale) checks.push(drift('C2', '购买按钮锚点', `锚点不存在且文案字典无命中（页面显示「${r.presale}」——可能只是预售态，也可能按钮区改版）`, `开抢前 1 天再看一眼：若开抢日仍如此，用 verify/history/probe-sku-dom.mjs 侦察按钮区新结构，更新 cdp-rush.mjs 的锚点/文案字典`));
    else checks.push(drift('C2', '购买按钮锚点', '锚点与全部文案字典都无命中——按钮区大概率改版', '用 verify/history/probe-sku-dom.mjs 侦察按钮区新结构，更新 cdp-rush.mjs 的 fastCheckExpr/buyExpr'));
  } else {
    checks.push(skip('C2', '购买按钮锚点', '商品页未就位，跳过（先解决 C1）'));
  }

  // ── C3 抢购信息接口形状 + R1 干跑 ──
  let rawInfo = null;
  if (slot.sbomCode) {
    rawInfo = await fetchRushbuyInfoRaw(slot.sbomCode, ua);
    if (!rawInfo) {
      checks.push(fail('C3', '抢购信息接口', 'queryRushbuyInfo.json 请求失败（3s 超时）', '检查网络/代理；接口若加鉴权，需更新 vmall-api.mjs（校时兜底、开售时刻、回流监控都依赖它）'));
    } else {
      let j = null;
      try { j = JSON.parse(rawInfo.text); } catch { /* 形状变了 */ }
      const list = j && Array.isArray(j.skuRushBuyInfoList) ? j.skuRushBuyInfoList : null;
      const item = list && (list.find((x) => String(x.sbomCode) === String(slot.sbomCode)) || list[0]);
      if (!j || !list) {
        checks.push(drift('C3', '抢购信息接口', '响应不再含 skuRushBuyInfoList 数组——接口形状已改', `实际顶层字段：${j ? Object.keys(j).join(', ') : '（非 JSON）'}。更新 vmall-api.mjs 与 intercept/rules.mjs 的字段路径`));
      } else if (item && item.startTime == null) {
        checks.push(ok('C3', '抢购信息接口', `形状正常（currentTime=${j.currentTime}；本 SKU 暂无 startTime——可能无场次，非改版）`));
      } else {
        checks.push(ok('C3', '抢购信息接口', `形状正常（currentTime=${j.currentTime}，startTime=${item && item.startTime}）`));
      }
      const dry = rawInfo && dryRunRushInfo(rawInfo.text, LEAD_MS);
      if (dry) checks.push(ok('C3b', 'R1 改写规则干跑', `对真实响应体改写成功：startTime ${dry.sample.before} → ${dry.sample.after}（提前 ${LEAD_MS}ms）`));
      else checks.push(drift('C3b', 'R1 改写规则干跑', '对真实响应体改写失败（形状不匹配/无 startTime）——真抢时 R1 会静默放行不生效', '对照 C3 的实际形状修 platforms/huawei/intercept/rules.mjs 的 rewriteRushInfo'));
    }
  } else {
    checks.push(skip('C3', '抢购信息接口', '槽位无 sbomCode'));
  }

  // ── C4 校时接口 + 时钟偏差 ──
  try {
    const clock = await calibrateClock(ua, null, 5);
    if (clock && Math.abs(clock.offsetMs) < 1500) checks.push(ok('C4', '校时接口与时钟', `偏差 ${clock.offsetMs}ms（${clock.samples} 样本，离散 ${clock.spreadMs}ms）`));
    else if (clock) checks.push(drift('C4', '校时接口与时钟', `本地钟偏差 ${clock.offsetMs}ms 过大（离散 ${clock.spreadMs}ms）——触发时刻会整体偏移`, '同步 Windows 时间（设置→时间→立即同步）；偏差仍大则检查 NTP 服务'));
    else checks.push(fail('C4', '校时接口与时钟', 'serverTime.json 与 queryRushbuyInfo 都拿不到时间', '两个校时接口都失效：确认本机网络可达 openapi.vmall.com；若官方下线接口，在 vmall-api.mjs 的 TIME_APIS 里补新接口'));
  } catch (e) {
    checks.push(fail('C4', '校时接口与时钟', `校时异常：${e.message}`));
  }

  // ── C5 __NEXT_DATA__ 数据通道 ──
  if (cdp && pageState && /comdetail/.test(pageState.url)) {
    const r = await cdp.eval(`(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return { has: false };
      try {
        const txt = el.textContent || '';
        const j = JSON.parse(txt);
        return { has: true, parse: true, bytes: txt.length, hasSbom: txt.includes('${slot.sbomCode}'), topKeys: Object.keys(j || {}).slice(0, 8).join(',') };
      } catch (e) { return { has: true, parse: false, err: e.message }; }
    })()`).catch(() => null);
    if (!r) checks.push(skip('C5', '__NEXT_DATA__ 数据通道', '页面表达式执行失败'));
    else if (!r.has) checks.push(drift('C5', '__NEXT_DATA__ 数据通道', '页面不再内嵌 __NEXT_DATA__——爬虫（crawler-huawei.mjs）与页面数据通道已变', '改用 recon-api.mjs 重新侦察页面数据来源，更新爬虫与 checkup'));
    else if (!r.parse) checks.push(drift('C5', '__NEXT_DATA__ 数据通道', `__NEXT_DATA__ 存在但 JSON 解析失败：${r.err}`));
    else if (!r.hasSbom) checks.push(drift('C5', '__NEXT_DATA__ 数据通道', 'JSON 正常但不含槽位 sbomCode——数据结构或 SKU 标识已变', `顶层键：${r.topKeys}。对照 platforms/huawei/crawler-huawei.mjs 的解析路径排查`));
    else checks.push(ok('C5', '__NEXT_DATA__ 数据通道', `JSON 正常（${Math.round(r.bytes / 1024)}KB，含槽位 SKU）`));
  } else {
    checks.push(skip('C5', '__NEXT_DATA__ 数据通道', '商品页未就位，跳过'));
  }

  // ── C6 B 规则匹配器 + 排队页样本 ──
  if (rawInfo) {
    const hit = MATCH.rushInfo.test(rawInfo.url || '') || MATCH.rushInfo.test('https://buy.vmall.com/queryRushbuyInfo.json?sbomCodes=' + slot.sbomCode);
    if (hit) checks.push(ok('C6', 'R1 URL 匹配器', '真实响应 URL 命中拦截模式（Fetch.enable 的 urlPattern 同源）'));
    else checks.push(drift('C6', 'R1 URL 匹配器', `匹配器没命中真实响应 URL（${rawInfo.url}）——真抢时 R1 不会生效`, '更新 intercept/rules.mjs 的 PATTERNS.rushInfo 与 MATCH.rushInfo'));
  } else {
    checks.push(skip('C6', 'R1 URL 匹配器', '无真实响应可对照（C3 失败）'));
  }
  {
    const sampleDir = new URL('../../data/grab/evidence/queue-samples/', import.meta.url);
    const has = existsSync(sampleDir);
    checks.push(has
      ? ok('C6b', '排队页样本', '已有真实排队页样本留证（data/grab/evidence/queue-samples/）——可着手分析排队接管逻辑')
      : skip('C6b', '排队页样本', '尚未捕获真实排队页（只在真实场次出现）。开抢时 R2 会自动留证，无需操作'));
  }

  // ── C7 A 方案内部入口（2026-10-07 走通版：fiber → onPress 闭包 → Yo/goBuy）──
  // 只读检测"入口链可达 + 业务签名匹配"，不 fire（fire 验证由 probe-rush-entry.mjs 做）。
  // 旧全局路径已死，保留为 C7a 观察面。
  if (cdp && pageState && /comdetail/.test(pageState.url)) {
    const r = await cdp.eval(`(() => {
      const out = {};
      try {
        const root = document.getElementById('prd-botnav-rightbtn');
        out.anchor = !!root;
        if (root) out.buyText = (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20);
        const host = root && (root.querySelector('div[tabindex]') || root.querySelector('[tabindex]'));
        out.pressable = !!host;
        if (host) {
          const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
          out.fiberKey = !!key;
          let cur = key ? host[key] : null, hops = 0;
          while (cur && hops < 25) {
            const p = cur.memoizedProps;
            if (p && typeof p.onPress === 'function') {
              const src = String(p.onPress);
              out.onPress = true; out.hops = hops; out.srcLen = src.length;
              out.sig = /buttonMode/.test(src) && /rushBuyPrd/.test(src);
              break;
            }
            cur = cur.return; hops++;
          }
        }
      } catch (e) { out.err = String(e); }
      return JSON.stringify(out);
    })()`).catch(() => null).then((s) => { try { return JSON.parse(s); } catch { return null; } });
    if (!r) checks.push(skip('C7', 'A 方案内部入口', '页面表达式执行失败'));
    else if (r.onPress && r.sig) checks.push(ok('C7', 'A 方案内部入口', `fiber 入口可达（向上 ${r.hops} 层、源码 ${r.srcLen} 字、业务签名匹配）——triggerMode=internal 可用；按钮文案「${r.buyText || ''}」`));
    else if (r.onPress && !r.sig) checks.push(drift('C7', 'A 方案内部入口', `fiber onPress 可达但业务签名不匹配（源码 ${r.srcLen} 字，缺 buttonMode/rushBuyPrd）——入口逻辑可能已改版`, '用 verify/history/probe-rush-entry.mjs --dump-closure 重读闭包，确认 Yo/goBuy 是否还在；对照 cdp-rush.mjs 的 pickInternalEntry'));
    else if (r.anchor && r.pressable && r.fiberKey) checks.push(drift('C7', 'A 方案内部入口', '按钮/fiber 都在但搜索层数内无 onPress——React 树结构可能已变', '用 verify/history/probe-rush-entry.mjs 重新定位（调大搜索层数/换锚点）；对照 cdp-rush.mjs 的 pickInternalEntry'));
    else if (r.anchor || r.pressable) checks.push(skip('C7', 'A 方案内部入口', `按钮锚点不完整（anchor=${r.anchor} pressable=${r.pressable}）——页面可能未渲染完或非购买态`));
    else checks.push(skip('C7', 'A 方案内部入口', '本页无购买按钮锚点（未开售/未登录/改版），换现货页可复检'));
  } else {
    checks.push(skip('C7', 'A 方案内部入口', '商品页未就位，跳过'));
  }

  // ── C7a 旧全局路径（2020 版；2026-10-07 起已知被移除，保留观察面）──
  if (cdp && pageState && /comdetail/.test(pageState.url)) {
    const r = await cdp.eval(`(() => {
      const biz = (window.rush && window.rush.business) || null;
      const fn = biz ? biz.doGoRush : null;
      return { hasRush: !!window.rush, type: typeof fn };
    })()`).catch(() => null);
    if (!r) checks.push(skip('C7a', '旧全局路径', '页面表达式执行失败'));
    else if (r.type === 'function') checks.push(ok('C7a', '旧全局路径', 'window.rush.business.doGoRush 又出现了（历史路径回归，可作候选 0 用）'));
    else checks.push(skip('C7a', '旧全局路径', 'window.rush.business.doGoRush 不存在（已知：由 C7 的 fiber 入口接棒，无需处理）'));
  } else {
    checks.push(skip('C7a', '旧全局路径', '商品页未就位，跳过'));
  }

  // ── C8 价格读取 ──
  if (cdp && pageState && /comdetail/.test(pageState.url)) {
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
    })()`).catch(() => null);
    if (price != null) checks.push(ok('C8', '价格读取', `读到页面价 ¥${price}（maxPrice 上限保护可用）`));
    else checks.push(drift('C8', '价格读取', '读不到价格（可能预售页无价格，也可能价格区改版）——maxPrice 保护会静默失效', '开抢日复查：仍读不到则更新 cdp-rush.mjs 的价格正则/范围选择器；不设 maxPrice 可忽略此项'));
  } else {
    checks.push(skip('C8', '价格读取', '商品页未就位，跳过'));
  }

  try { cdp && cdp.ws && cdp.ws.close(); } catch { /* 收尾 */ }

  return finish(checks, slot, t0);
}

/** 汇总 + 落盘 + 控制台输出 + 退出码。C0 闸门提前返回时也走这里。 */
function finish(checks, slot, t0) {
  const summary = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    drift: checks.filter((c) => c.status === 'DRIFT').length,
    skip: checks.filter((c) => c.status === 'SKIP').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    platform: 'huawei',
    slot: slot.id,
    prdId: slot.prdId,
    sbomCode: slot.sbomCode,
    durationMs: Date.now() - t0,
    summary,
    checks,
  };
  try {
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
    appendFileSync(HISTORY_PATH, JSON.stringify(report) + '\n', 'utf8');
  } catch { /* 落盘失败不影响退出码判定 */ }

  // ── 控制台输出 ──
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n===== 华为商城改版体检 =====');
    for (const c of checks) {
      console.log(`${ICON[c.status]} ${c.id} ${c.name}：${c.detail}`);
      if (c.fix) console.log(`     ↳ 怎么修：${c.fix}`);
    }
    console.log(`---- PASS ${summary.pass} · DRIFT ${summary.drift} · SKIP ${summary.skip} · FAIL ${summary.fail}（${Math.round((Date.now() - t0) / 1000)}s）----`);
  }
  process.exit(summary.drift + summary.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`[体检异常] ${e.message}`);
  process.exit(1);
});
