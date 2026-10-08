/**
 * CDP 通道核心（零依赖，Node 原生 WebSocket 手写的最小 CDP 客户端）
 * =====================================================================
 * 从 cdp-rush.mjs 抽出共用部分：CDP 类、端口探测、标签管理、可信点击、
 * 槽位窗口拉起。cdp-rush.mjs（抢购驱动）和 checkup-vmall.mjs（体检）
 * 都从这里 import，避免两份实现漂移。
 *
 * 为什么不用 chrome-remote-interface / puppeteer-core：
 *   抢购路径上多一层库就多一层不可控；本文件 46 行的 CDP 客户端只做
 *   「send 配对响应 + 事件分发」两件事，行为完全可预测。
 * =====================================================================
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

/**
 * 跨平台探测 Google Chrome 可执行文件路径 (macOS / Windows / Linux)
 */
export function getChromePath(platform = process.platform) {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${process.env.HOME || ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
    return macPaths[0];
  }
  if (platform === 'win32') {
    const winPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p;
    }
    return winPaths[0];
  }
  return '/usr/bin/google-chrome';
}

export const CHROME = getChromePath();
export const SLOT_DIR = (id) => fileURLToPath(new URL(`../data/grab/chrome-profile-rush/${id}/`, import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 到点等待：最后一程 ≤500ms 忙等，钉死 Windows 定时器 ~15.6ms 聚簇的精度损失
 *  （2026-10-08 从 60ms 加宽到 500ms：出手对齐 T0 的误差直接吃掉这 15.6ms 的抖动，
 *   半秒 CPU 忙等只在开售前一瞬发生，代价可忽略） */
export async function sleepUntil(ts) {
  while (true) {
    const left = ts - Date.now();
    if (left <= 0) return;
    if (left <= 500) { while (Date.now() < ts) { /* busy wait */ } return; }
    await sleep(Math.min(1000, left - 60));
  }
}

/** 日志时间戳到微秒（2026-10-08 用户要求）：毫秒位来自墙钟，微秒位来自高精度计时器。
 *  用途：复盘"开售前后每一毫秒谁先谁后"（注意：控制台日志一律是本机钟，
 *  服务器钟口径看 events.jsonl 里的 tRelT0 字段）。 */
export const logFor = (id) => (msg, tag = '') => {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  const us = Math.floor((process.hrtime()[1] % 1e6) / 1000);
  const t = `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}${p(us, 3)}`;
  console.log(`[${t}] [${id}]${tag ? ' ' + tag : ''} ${msg}`);
};

/** 登录页判定（URL + 标题） */
export const ON_LOGIN_PAGE = /login|passport|华为账号/i;

/* ── 登录态判据：以浏览器凭据为准，不看页面文案 ──────────────────────────
 *
 * 2026-10-07 实测取证（未登录无头浏览器 vs acc1 已登录专用窗口），
 * 结论是页面文案两个方向都会误判，而请求头/接口响应都分不出登录态：
 *   · 页头会先短暂显示"请登录"再水合回登录态 → 早读误判；
 *   · 详情页真未登录时也可能压根不出现"请登录"文案 → 也误判；
 *   · 请求头里没有鉴权令牌（对比 openapi 请求头，只有 UA/trace 不同）；
 *   · queryCart / getShippingTime / querySkuInventory 两边响应完全相同；
 *   · queryRecommendConfig 主动请求时两边都返回 200916（不能靠它正查）；
 *   · 唯一可靠凭据 = 华为账号 SSO 会话 Cookie：
 *       sid / hwid_cas_sid @ .id1.cloud.huawei.com
 *     未登录：完全不存在；已登录：两者都在（len=84）。清空 storage 后依然如此。
 *
 * 这两个 Cookie 由登录响应种下，是"浏览器那一侧"的真实状态；
 * 页面文案只是它的投影，会水合延迟、会被缓存影响。
 */
export const SESSION_COOKIE_NAMES = ['sid', 'hwid_cas_sid'];
export const SESSION_COOKIE_DOMAIN = /(^|\.)id1\.cloud\.huawei\.com$/i;

/** vmall 反爬混淆判读（2026-10-08 实锤）：部分响应会把所有 "s" 挖成空格——
 *  userInfo→"u erInfo"、authCust→"authCu t"、isBindPhone→"i BindPhone"。
 *  拿原文关键词直接匹配会把"已登录"误判成掉线（13:59 保活误报 9401 即此因）。
 *  统一判法：先压平空白，再让"原文 / 去 s"两个变体都过一遍关键词。
 *  返回 'ok'（已登录）| 'out'（服务端明确说未登录）| null（意外内容，不当掉线） */
export function judgeVmallLoginBody(body) {
  const raw = String(body || '');
  const flat = raw.replace(/\s+/g, '');
  const noS = flat.replace(/s/gi, '');
  if (/uerinfo|authcut|nickname/i.test(noS) || /userinfo|authcust|nickname/i.test(flat)) return 'ok';
  if (/200916/.test(flat) || /uernotlogin|usernotlogin/i.test(noS) || /用户未登录/.test(raw)) return 'out';
  return null;
}

/** 登录态判据之二：问页面自己的接口（**最权威**）。
 *
 *  2026-10-07 实测找到的"页面自己用来判断登录态"的接口（在会员页抓到）：
 *    GET https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN
 *    已登录 → {"code":"0","success":true,"userInfo":{"authCust":true,"custGrad":3,
 *              "nickName":"...","uid":"...","userAccount":"..."}}   （custGrad=3 ↔ 页面"V3 等级"）
 *    未登录 → {"data":"user not login.","info":"用户未登录","resultCode":"200916"}
 *
 *  为什么比读 Cookie 强：Cookie 会残留（会话服务端已失效但浏览器还存着），
 *  而这个接口是**真问一次服务端**。只读状态查询，不构造下单动作。
 *  返回 { loggedIn: true|false|null, evidence }；null = 查询失败。
 */
export async function probeLoginApi(cdp) {
  const url = 'https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN';
  try {
    const raw = await cdp.eval(`(async () => {
      try {
        const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        const t = await r.text();
        return JSON.stringify({ status: r.status, body: t.slice(0, 300) });
      } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
    })()`);
    const r = JSON.parse(raw || '{}');
    if (r.error) return { loggedIn: null, evidence: `queryUserInfo 查询失败：${r.error}` };
    const body = r.body || '';
    const verdict = judgeVmallLoginBody(body);
    if (verdict === 'ok') {
      // 昵称/等级只做展示证据；custGrad 兼容被挖 s 的 "cu tGrad"
      const nick = (body.match(/"nickName"\s*:\s*"([^"]*)"/) || [])[1] || '';
      const grad = (body.match(/"(?:custGrad|cu\s*tGrad)"\s*:\s*([0-9]+)/) || [])[1] || '';
      return { loggedIn: true, evidence: `queryUserInfo: ${nick}${grad ? ` V${grad}` : ''}` };
    }
    if (verdict === 'out') {
      return { loggedIn: false, evidence: 'queryUserInfo 返回"用户未登录"' };
    }
    return { loggedIn: null, evidence: `queryUserInfo 返回意外内容（HTTP ${r.status}）：${body.replace(/\s+/g, ' ').slice(0, 100)}` };
  } catch (e) {
    return { loggedIn: null, evidence: `queryUserInfo 调用异常：${e.message}` };
  }
}

/** 读浏览器凭据判断登录态（需 Network 域已启用）。
 *  返回 { loggedIn: true|false|null, evidence }；null = 读不到（CDP 异常），
 *  调用方应退回旧办法并打日志说明。 */
export async function readLoginState(cdp) {
  try {
    const all = await cdp.send('Network.getAllCookies', {});
    const hit = (all.cookies || []).filter(
      (c) => SESSION_COOKIE_NAMES.includes(c.name) && SESSION_COOKIE_DOMAIN.test(c.domain),
    );
    return {
      loggedIn: hit.length > 0,
      evidence: hit.length
        ? hit.map((c) => `${c.name}@${c.domain}(len=${(c.value || '').length})`).join(' ')
        : '未找到 sid/hwid_cas_sid 会话 Cookie',
    };
  } catch (e) {
    return { loggedIn: null, evidence: `Cookie 读取失败：${e.message}` };
  }
}

/**
 * CDP 客户端。
 * - send()：按 id 配对响应（与 Chrome 官方协议一致）；
 * - on()：订阅事件（Fetch.requestPaused / Runtime.consoleAPICalled …）。
 *   事件回调里可以直接调 this.send() 应答（如 Fetch.continueResponse）。
 */
export class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map(); // method -> Set<cb>
  }
  /** 订阅 CDP 事件，返回取消订阅函数 */
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(cb);
    return () => this.listeners.get(method)?.delete(cb);
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        const set = this.listeners.get(msg.method);
        if (set) for (const cb of set) { try { cb(msg.params); } catch { /* 事件回调异常不影响通道 */ } }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面执行出错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result?.value;
  }
}

export const cdpUp = async (port) => {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
};

export const listTabs = async (port) =>
  (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page');

/**
 * 专用窗口里挑我们要的标签：优先商品页（按槽位 prdId），
 * 其次任何非确认/非登录页；实在没有就给第一个页面标签。
 * （确认订单页是点击后新弹的，不该被当成工作标签复用）
 */
export const waitTab = async (port, prdId, sbomCode, timeoutMs = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const tabs = await listTabs(port);
      if (tabs.length) {
        return (
          tabs.find((t) => t.url.includes(String(prdId)) && (!sbomCode || t.url.includes(sbomCode)) && /comdetail/.test(t.url)) ||
          tabs.find((t) => prdId && t.url.includes(prdId) && /comdetail/.test(t.url)) ||
          tabs.find((t) => !/orderConfirm/.test(t.url) && !ON_LOGIN_PAGE.test(t.url + t.title)) ||
          tabs[0]
        );
      }
    } catch { /* 端口还没起来 */ }
    await sleep(500);
  }
  throw new Error('等不到专用窗口的页面标签');
};

/**
 * 可信点击：CDP Input 域派发鼠标事件，isTrusted=true，与真人点击无异。
 * vmall 的购买按钮直接无视 isTrusted=false 的合成事件（2026-10-06 演练实测）。
 */
export async function trustedClick(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
  });
  await sleep(30);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
  });
}

/** 槽位专用窗口：已在跑就复用，没跑就拉起（持久 profile，登录态长期有效） */
export async function ensureSlotWindow(slot, targetUrl, log) {
  const port = slot.port;
  if (!(await cdpUp(port))) {
    spawn(CHROME, [
      `--user-data-dir=${SLOT_DIR(slot.id)}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      // ★ 2026-10-08 根因修复：Chrome 的原生窗口遮挡检测会把"被其它窗口完全盖住"
      //   的窗口标记为 hidden，并对 hidden 页面丢弃全部 CDP 输入事件——真点击
      //   因此"时灵时不灵"（窗口露着就灵，被盖住/在后台就死，10-08 probe 实证）。
      //   禁掉它之后窗口被盖也能正常点击，代价只是遮挡时多耗一点渲染 CPU。
      '--disable-features=CalculateNativeWinOcclusion',
      // 上次没正常退出（崩溃/强杀）也不弹「要恢复页面吗」恢复条（专用窗口不需要它）
      '--hide-crash-restore-bubble',
      targetUrl,
    ], { detached: true, stdio: 'ignore' }).unref();
    log?.(`已启动专用窗口（调试端口 ${port}）`);
  } else {
    log?.(`专用窗口已在运行，复用（端口 ${port}）`);
  }
}

/**
 * 默认拦截的重资源后缀列表（图片、字体、音视频等媒体）
 */
export const DEFAULT_BLOCKED_RESOURCE_PATTERNS = [
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.svg', '*.ico',
  '*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot',
  '*.mp4', '*.mp3', '*.webm', '*.ogg',
];

/**
 * 启用 CDP 原生重资源过滤（图片、字体、音视频等），大幅降低首屏渲染耗时与带宽消耗。
 * 借助 Chrome 原生 Network.setBlockedURLs，在浏览器内核网络层直接拦截丢弃，
 * 零 Node.js 回调与 IPC 开销。通用于华为商城、秀动、大麦等所有 Web 项目。
 *
 * @param {CDP} cdp
 * @param {string[]} extraPatterns 额外的通配符规则
 */
export async function blockHeavyResources(cdp, extraPatterns = []) {
  const urls = [...DEFAULT_BLOCKED_RESOURCE_PATTERNS, ...extraPatterns];
  await cdp.send('Network.enable').catch(() => {});
  return cdp.send('Network.setBlockedURLs', { urls });
}


