// ==UserScript==
// @name         华为商城抢购（独立运行 · 可被控制台派发）
// @namespace    qp.grab.huawei
// @version      0.5.0
// @description  华为商城 vmall 抢购脚本。只对「控制台商品列表」里的商品运作（列表外的商品页：不插面板、不发请求、不改缓存）；登录态按浏览器凭据判断（不看页面文案）。按指定 SKU 就位、点击购买，回报页面上真实读到的订单号。不做验证码绕过；遇到验证/登录会停下等人。
// @author       qp
// @match        https://item.vmall.com/product/comdetail/*
// @match        https://www.vmall.com/product/*
// @match        https://m.vmall.com/product/comdetail/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

/* =====================================================================
 * 配置格式（data/grab/huawei.config.json）
 * =====================================================================
 *   products: [
 *     {
 *       url: "商品页地址",              ← 一个 URL 就是一个商品
 *       id: "备注名",                   ← 可选，只用于区分
 *       enabled: true,                 ← false 则跳过这个商品
 *       sbomCodes: ["2601010640923"],  ← 要抢的规格编号；留空 = 全部规格
 *       maxPrice: 12000,               ← 价格上限，null = 不限
 *       quantity: 1,
 *       saleAt: null                   ← 开售时间；留空则取该 SKU 自己的场次时间
 *     }
 *   ]
 *
 * ★ 不再用标题关键字 —— 一个 URL 就是一个确定的商品，靠 prdId 精确匹配。
 *   （以前靠 "Mate 90 Pro Max" 这种关键字，同系列的 Pro / Pro Max 会认错。）
 *
 * ★ 规格用 sbomCode 指定，不用「颜色=翡冷翠」这种文字匹配 ——
 *   同一商品下价格 ¥9499 ~ ¥12999，按文字猜很容易买错规格。
 * ===================================================================== */

/* =====================================================================
 * 设计原则（每条都对应之前踩过的坑）
 * =====================================================================
 * 1. 【绝不编造订单号】
 *    只回报页面上真实读到的订单号。读不到就报 SUBMIT_UNKNOWN。
 *    绝不用「本地时间戳拼一个」之类的兜底 —— 那会把"结果未知"伪装成"有订单"。
 *
 * 2. 【遇到验证/登录就停】
 *    不破解、不自动打码、不做轨迹伪装。停下来等人处理。
 *
 * 3. 【只操作页面上普通用户看得见的东西】
 *    不构造请求、不改参数。提交只通过点击页面上的真实按钮完成。
 *    （读页面内嵌数据只是为了确认"当前是哪个 SKU"，不拿它去发请求。）
 *
 * 4. 【演练模式】
 *    dryRun=true 时只点到"购买"为止，不提交订单。用它先验证选择器认得准，
 *    避免第一次跑就产生真实订单。
 *
 * 5. 【幂等】
 *    用 GM 存储记录本次是否已经点击过购买按钮，防止页面刷新后重复点击
 *    产生第二个订单。
 *
 * 6. 【先定位规格，再读价格】
 *    同一商品不同规格价格不同。不先切到目标规格就读价格，读到的是别的规格的
 *    钱，价格上限会判错 —— 这个顺序不能反。
 * ===================================================================== */

(function () {
  'use strict';

  const PLATFORM = 'huawei';
  const DEFAULT_BRIDGE = 'http://127.0.0.1:3100';
  const LOG_PREFIX = '[华为抢购]';

  /* ============================================================
   * 作用域工具（放在最前面，便于被外部校验脚本单独抽取执行）
   * ============================================================ */

  /** 折叠空白 */
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /** 页面可见文本总量 */
  const visibleText = () => clean(document.body ? document.body.innerText : '');

  /** 元素可见文字 */
  const textOf = (el) => clean(el && (el.innerText || el.textContent || ''));

  /** 元素是否可见且可点 */
  function isActionable(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    if (el.hasAttribute('disabled')) return false;
    if (typeof el.className === 'string' && /disabled|is-disabled|btn-disabled/.test(el.className)) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  /** 元素是否位于推荐位内（推荐位价格是主要干扰源） */
  function inRecommend(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const id = cur.id || '';
      const cls = typeof cur.className === 'string' ? cur.className : '';
      if (/recommend/i.test(id) || /recommend/i.test(cls)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /** 运行期状态 */
  const state = {
    config: null,
    bridgeUrl: DEFAULT_BRIDGE,
    profileId: 'default',
    startedAt: Date.now(),
    phase: 'init',
    submittedOnce: false,
    orderSubmittedAt: null,
    capturedOrderNo: null,
    capturedAmount: null,
    capturedPayDeadlineMs: null,
    giveUpTimer: null,
    stopped: false,
    // 静默模式：不在商品列表时置true。之后 ensurePanel() 一律返回 null，
    // log() 只写console 不碰页面 DOM —— "不运作"就得是页面完全无痕迹。
    silent: false,
    // 启动时匹配到的商品编号。SPA 站内跳转不重载文档，靠它每轮核对页面身份。
    targetPrdId: null,
    // 登录态（以浏览器凭据/接口响应为准，不看页面文案）
    //   state: 'unknown' | 'out'（观察到未登录信号）| 'in'
    login: { state: 'unknown', method: null, evidence: null, at: null },
    loginWatchersOn: false,
    // 凭据探测的原始结论（GM_cookie 能看到几条、是否跨站受限），用于日志/排查
    loginProbe: null,
  };

  /* ============================ 工具 ============================ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (base, ratio = 0.3) => Math.round(base * (1 + (Math.random() * 2 - 1) * ratio));

  /* ============================ 面板 ============================ */

  let panelEl = null;
  const logLines = [];

  /**
   * 拿到一个可挂载的根节点。
   *
   * ⚠ 这里必须兜底，不能直接用 document.body。
   * 实测踩坑（2026-10-06）：油猴 5.5.1 是 MV3 架构，在商品页这类
   * 快速导航的场景下，@run-at document-idle 触发时 document.body
   * 偶尔还是 null，于是 ensurePanel() 里 appendChild 直接抛
   * "Cannot read properties of null (reading 'appendChild')"，
   * 异常一路冒到 IIFE 外，导致整个脚本静默死掉 —— 表现为
   * 「面板完全不出现 + 油猴图标显示红叉」，且没有任何日志提示。
   *
   * 兜底顺序：body → documentElement → 延迟重试。
   * documentElement 从文档创建起就存在，挂上去的元素同样会显示。
   */
  function mountRoot() {
    return document.body || document.documentElement || null;
  }

  /** 等 body 出现（最多数秒），避免过早挂载失败 */
  function waitForBody(timeoutMs = 5000) {
    if (document.body) return Promise.resolve(document.body);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (document.body) return resolve(document.body);
        if (Date.now() - t0 > timeoutMs) return resolve(mountRoot());
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function ensurePanel() {
    if (state.silent) return null; // 静默模式：不碰页面 DOM
    if (panelEl && document.body && document.body.contains(panelEl)) return panelEl;
    const root = mountRoot();
    if (!root) return null; // 文档还没建好，调用方需先 await waitForBody()
    panelEl = document.createElement('div');
    panelEl.id = 'qp-huawei-grab-panel';
    panelEl.style.cssText = `
      position:fixed; right:14px; bottom:14px; z-index:2147483647;
      width:340px; max-height:46vh; overflow:auto;
      background:rgba(13,17,23,.94); color:#e6edf3; border:1px solid #30363d;
      border-radius:8px; padding:10px 12px; font:12px/1.55 ui-monospace,Consolas,monospace;
      box-shadow:0 8px 28px rgba(0,0,0,.45);`;
    panelEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <b style="color:#58a6ff;">华为抢购</b>
        <span id="qp-phase" style="color:#8b949e;">初始化…</span>
      </div>
      <div id="qp-log" style="white-space:pre-wrap;"></div>`;
    root.appendChild(panelEl);
    return panelEl;
  }

  function log(msg, level) {
    const line = `${new Date().toLocaleTimeString()} ${msg}`;
    logLines.push(line);
    if (logLines.length > 60) logLines.shift();
    console.log(LOG_PREFIX, msg);
    const p = ensurePanel();
    if (!p) return; // 文档尚未就绪；main() 会先 await waitForBody() 再补画一次
    const logBox = p.querySelector('#qp-log');
    const phaseBox = p.querySelector('#qp-phase');
    if (phaseBox) phaseBox.textContent = state.phase;
    if (logBox) {
      const color = level === 'err' ? '#f85149' : level === 'warn' ? '#d29922' : level === 'ok' ? '#3fb950' : '#8b949e';
      logBox.innerHTML = logLines
        .slice(-18)
        .map((l, i, a) => `<div style="color:${i === a.length - 1 ? color : '#8b949e'};">${escapeHtml(l)}</div>`)
        .join('');
    }
  }

  /** 静默模式：撤掉已插入的面板并禁止再次插入。
   *  用于「页面在启动时还在列表内、但配置刷新后变成列表外」等中途场景。
   *  之后 log() 只进 console，页面 DOM 上不留任何痕迹。 */
  function teardownPanel() {
    state.silent = true;
    try { if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl); } catch { /* 已脱离 */ }
    panelEl = null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function setPhase(p) {
    state.phase = p;
    const p2 = panelEl && panelEl.querySelector('#qp-phase');
    if (p2) p2.textContent = p;
  }

  /* ============================ 桥接通信 ============================ */

  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method,
          url,
          headers: { 'Content-Type': 'application/json' },
          data: body ? JSON.stringify(body) : undefined,
          timeout: 8000,
          onload: (res) => {
            try {
              resolve({ status: res.status, json: res.responseText ? JSON.parse(res.responseText) : null });
            } catch {
              resolve({ status: res.status, json: null, raw: res.responseText });
            }
          },
          onerror: () => reject(new Error('桥接服务不可达')),
          ontimeout: () => reject(new Error('桥接服务超时')),
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 只读「控制台的商品列表」——用户 2026-10-07 明确要求：
   * 脚本应该直接读控制台那份清单，按清单里的 URL 决定做不做。
   *
   * 「控制台的商品列表」= 桥接服务上的 config.json 的 products[]，
   * 也就是控制台「商品与 SKU」页显示的那份清单。
   *
   * 顺序：控制台（最新，权威）→ 本地缓存（桥接没开时兜底）。
   * 本函数**只读**：不发写请求、不落缓存（缓存只在确认"本页在列表内"之后才由
   * main() 写入，免得在列表外页面留下任何痕迹）。
   *
   * 返回 { config, source }；config=null 表示两个来源都拿不到。
   */
  async function readProductList() {
    try {
      const res = await request('GET', `${DEFAULT_BRIDGE}/api/config/${PLATFORM}`);
      if (res.status === 200 && res.json && Array.isArray(res.json.products)) {
        return { config: res.json, source: '控制台' };
      }
    } catch { /* 桥接没开 → 落到缓存 */ }
    const cached = GM_getValue('config', null);
    if (cached && Array.isArray(cached.products)) return { config: cached, source: '本地缓存' };
    return { config: null, source: null };
  }

  /** 结果回传。失败则落到本地待发队列，下次启动补发。 */
  async function report(payload) {
    const record = {
      at: new Date().toISOString(),
      profileId: state.profileId,
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      ...payload,
    };
    const pendingKey = 'pendingReports';
    try {
      const res = await request('POST', `${state.bridgeUrl}/api/results/${PLATFORM}`, record);
      if (res.status === 200) {
        log(`结果已回传：${record.outcome}`, 'ok');
        await flushPending();
        return true;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      const q = GM_getValue(pendingKey, []);
      q.push(record);
      GM_setValue(pendingKey, q.slice(-50));
      log(`结果回传失败（${e.message}），已存入本地待发队列`, 'warn');
      return false;
    }
  }

  async function flushPending() {
    const key = 'pendingReports';
    const q = GM_getValue(key, []);
    if (!q.length) return;
    const remain = [];
    for (const rec of q) {
      try {
        const res = await request('POST', `${state.bridgeUrl}/api/results/${PLATFORM}`, rec);
        if (res.status !== 200) remain.push(rec);
      } catch {
        remain.push(rec);
      }
    }
    GM_setValue(key, remain);
    if (q.length !== remain.length) log(`补发历史结果 ${q.length - remain.length} 条`, 'ok');
  }

  /* ============================ 页面识别 ============================ */

  /* ── 登录态：以浏览器凭据 / 接口响应为准，不看页面文案 ──────────────────
   *
   * 用户 2026-10-07 明确要求：登录态应该用浏览器的响应判断，而不是页面。
   *
   * 为什么页面文案不能用（2026-10-07 实测取证）：
   *   · 页头会先短暂显示"请登录"再水合回登录态 —— 早读一次就误判；
   *   · 详情页在真未登录时也可能压根不出现"请登录"文案 —— 晚读一次也误判；
   *   · 两个方向都会错，所以不能作为判据（驱动侧同一处也有这个注释）。
   *
   * 实测对比（未登录无头浏览器 vs 已登录专用窗口）确认的事实：
   *   · 请求头里没有鉴权令牌（对比 openapi 请求头，只有 UA/trace 不同）；
   *   · queryCart / getShippingTime / querySkuInventory 两边响应完全相同；
   *   · queryRecommendConfig 主动请求时两边都返回 200916 → 不能靠它正查；
   *   · 唯一可靠凭据 = 华为账号 SSO 会话 Cookie：
   *       sid / hwid_cas_sid @ .id1.cloud.huawei.com
   *     未登录：完全不存在；已登录：两者都在（len=84）。清空 storage 后依然如此。
   *
   * 判定优先级：
   *   ① 响应硬信号：任何接口响应里出现"登录已过期/请重新登录"这类明确措辞
   *      → 60 秒内压过凭据判断，直接算掉线（会话刚死时它最及时）
   *      刻意不收 200916/"用户未登录"——匿名小请求在已登录页面上也会返回它，会误伤
   *   ② 会话 Cookie：能读到 → 已登录 / 没有 → 未登录（主判据）
   *   ③ 都拿不到 → 'unknown'（不拿页面文案凑数，交给后续点击流程兜底）
   */
  const SESSION_COOKIE_NAMES = ['sid', 'hwid_cas_sid'];
  // 只认"明确过期/被要求重新登录"这类硬信号。
  // 刻意**不收** `200916` 和 `用户未登录`——实测发现匿名上下文的小请求
  // （queryRecommendConfig 等）在已登录页面上也可能返回这两个值，
  // 收进来会把健康会话误判成掉线（S2 场景实测暴露）。
  const NOT_LOGIN_RESPONSE = /登录已过期|登录过期|登录已失效|登录失效|请重新登录|请先登录/;
  const NOT_LOGIN_SIGNAL_TTL_MS = 60 * 1000; // 过期信号的保鲜期：超过就交回凭据判断

  /** 装响应观察器：只看页面自己发的请求，不构造、不改写、不重放。 */
  function installLoginWatchers() {
    if (state.loginWatchersOn) return;
    state.loginWatchersOn = true;

    const note = (url, text) => {
      if (!text || !NOT_LOGIN_RESPONSE.test(text)) return;
      // 记录但不重复刷屏
      if (state.login.state !== 'out') {
        state.login = {
          state: 'out',
          method: '响应',
          evidence: `${String(url).split('?')[0].slice(-60)} → ${text.replace(/\s+/g, ' ').slice(0, 80)}`,
          at: Date.now(),
        };
        console.warn(`${LOG_PREFIX} 登录态：接口响应显示未登录（${state.login.evidence}）`);
      }
    };
    const watch = (url) => /openapi\.vmall\.com|buy\.vmall\.com|\/mcp\//.test(String(url));

    // fetch
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function patchedFetch(...a) {
        const p = origFetch.apply(this, a);
        try {
          const u = a[0] && a[0].url ? a[0].url : a[0];
          if (watch(u)) p.then((r) => { try { r.clone().text().then((t) => note(u, t)).catch(() => {}); } catch { /* 非文本 */ } }).catch(() => {});
        } catch { /* 忽略 */ }
        return p;
      };
    }
    // XHR
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
        if (watch(url)) {
          this.addEventListener('load', () => {
            try { note(url, this.responseText); } catch { /* 非文本 */ }
          });
        }
        return origOpen.call(this, method, url, ...rest);
      };
    } catch { /* 环境不支持则跳过 */ }
  }

  /* ── 响应判据（首选）：queryUserInfo ─────────────────────────────────
   * 2026-10-07 实测找到的"页面自己用来判断登录态"的接口（在会员页抓到）：
   *   GET https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN
   *   已登录 → {"code":"0","success":true,"userInfo":{"authCust":true,"custGrad":3,
   *             "nickName":"Always","uid":"...","userAccount":"..."}}
   *   未登录 → {"data":"user not login.","info":"用户未登录","resultCode":"200916"}
   * custGrad=3 正好对应页面上的"V3 等级"—— 确认这就是页面判断登录态的依据。
   *
   * 为什么它比读 Cookie 强：会话 Cookie 在 id1.cloud.huawei.com 域下，
   * 脚本在 item.vmall.com 上**看不到**（跨站读取受限，GM_cookie 返回空）；
   * 但浏览器发请求时**照样会带上**这些 Cookie，所以这个接口在商品页直接调
   * 就能拿到真实结果 —— 既不依赖跨站可见性，也不看页面文案。
   *
   * 这是只读的状态查询（和驱动侧的校时接口同一类），不构造下单动作。
   */
  const LOGIN_API_URL = 'https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN';

  /** 用页面自己的 fetch 查登录态（浏览器自动带 Cookie）。
   *  返回 'in' | 'out' | null（网络失败/超时 → null，交给下一层判据）。
   *  带 5 秒缓存：登录等待循环每 2 秒问一次，没必要每次真打接口。 */
  let _loginProbeCache = { at: 0, v: null };
  async function probeLoginByResponse(timeoutMs = 6000) {
    if (Date.now() - _loginProbeCache.at < 5000 && _loginProbeCache.v) return _loginProbeCache.v;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(LOGIN_API_URL, { credentials: 'include', signal: ctl.signal });
      clearTimeout(timer);
      const text = await res.text();
      if (/"userInfo"|authCust|nickName/.test(text)) { _loginProbeCache = { at: Date.now(), v: 'in' }; return 'in'; }
      if (/200916|user not login|用户未登录/.test(text)) { _loginProbeCache = { at: Date.now(), v: 'out' }; return 'out'; }
      state.loginProbe = `queryUserInfo 返回了意料之外的内容（HTTP ${res.status}）：${text.replace(/\s+/g, ' ').slice(0, 120)}`;
      return null;
    } catch (e) {
      state.loginProbe = `queryUserInfo 查询失败：${e.message || e}`;
      return null;
    }
  }

  /** 读华为账号会话 Cookie。返回 true（**确实看到**凭据）或 null（看不到/不可判定）。
   *
   *  ⚠ 关键教训（2026-10-07 用户实测踩到）：
   *    会话 Cookie（sid/hwid_cas_sid）在 `.id1.cloud.huawei.com` 域下，
   *    而脚本跑在 `item.vmall.com` 上。**跨站读 Cookie 会被浏览器/油猴限制，
   *    返回的是空数组** —— 而"空"不等于"没有凭据"，只等于"我看不到"。
   *    第一版把空当成了"未登录"，结果用户明明登录着却被判未登录。
   *    → 所以：只有**确实看到**会话 Cookie 才返回 true；
   *      看不到一律返回 null（未知），交给页面标记兜底，绝不冒充"未登录"。
   *    ※ 注意：**空 ≠ 未登录**。真正判"未登录"要靠上面的 queryUserInfo 响应。
   */
  function readSessionCookies() {
    return new Promise((resolve) => {
      if (typeof GM_cookie === 'undefined' || !GM_cookie || typeof GM_cookie.list !== 'function') {
        state.loginProbe = 'GM_cookie 不可用（油猴未授权或不支持）';
        return resolve(null);
      }
      const wants = [
        { url: 'https://id1.cloud.huawei.com/' },
        { domain: 'id1.cloud.huawei.com' },
        { domain: '.id1.cloud.huawei.com' },
      ];
      let answered = 0;     // 有应答的次数
      let wrong = 0;        // 报错次数
      let seen = 0;         // 三个查询一共返回了多少条 Cookie（判断"能不能看到跨站 Cookie"）
      let found = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        if (found) { settled = true; return resolve(true); }
        if (answered + wrong < wants.length) return;   // 还没问完
        settled = true;
        state.loginProbe = seen > 0
          ? `GM_cookie 返回 ${seen} 条（域不匹配，没有 id1 会话 Cookie）`
          : 'GM_cookie 在 id1 域下看到 0 条 Cookie（跨站读取受限）';
        resolve(null);      // ★ 看不到 = 未知，不是"未登录"
      };
      for (const details of wants) {
        try {
          GM_cookie.list(details, (cookies, err) => {
            if (err) wrong++;
            else {
              answered++;
              const list = Array.isArray(cookies) ? cookies : [];
              seen += list.length;
              if (list.some(
                (c) => SESSION_COOKIE_NAMES.includes(c.name)
                  && /(^|\.)id1\.cloud\.huawei\.com$/i.test(String(c.domain || '')),
              )) found = true;
            }
            finish();
          });
        } catch { wrong++; finish(); }
      }
      setTimeout(finish, 1500);
    });
  }

  /* ── 页面标记（兜底判据）──────────────────────────────────────────────
   * 为什么还需要它：跨站 Cookie 读不到时，"未知"既不能当"未登录"
   * （会误伤已登录用户 —— 用户实测踩到的就是这个），也不能永远不判
   * （真没登录时脚本会瞎点）。所以读页面上的登录痕迹，且：
   *   · 先等水合（页头会先短暂显示"请登录"再变回登录态）；
   *   · 多拍确认，不靠单次采样；
   *   · "已登录标记"优先于"未登录标记"（前者更具体，不会误报）。
   */
  const LOGGED_IN_MARKS = /退出登录|我的订单|我的商城|个人中心|待收货|我的帐号|我的账号/;
  const LOGGED_OUT_MARKS = /请登录|立即登录|账号登录|登录后查看/;

  async function detectLoginByPage(settleMs = 2000) {
    const deadline = Date.now() + settleMs;
    let inHits = 0;
    let outHits = 0;
    do {
      const t = visibleText();
      const hasIn = LOGGED_IN_MARKS.test(t);
      const hasOut = LOGGED_OUT_MARKS.test(t);
      if (hasIn) {
        inHits++;
        if (!hasOut) return 'in';        // 明确已登录标记且无反向标记 → 立刻定案
      }
      if (hasOut) outHits++;
      await sleep(500);
    } while (Date.now() < deadline);
    if (inHits > 0) return 'in';
    if (outHits >= 2) return 'out';      // 多拍都只有"请登录" → 判未登录
    return 'unknown';
  }

  /** 登录态判定。返回 'in' | 'out' | 'unknown'。
   *
   *  优先级（2026-10-07 实测定稿，三层）：
   *    ① 页面自己流量里的"登录已过期"硬信号（60 秒内）→ 'out'
   *       会话刚死时它最及时，且是页面自己发的请求，最可信
   *    ② queryUserInfo 响应（**主判据**）→ 'in' / 'out'
   *       页面自己的 fetch 带上浏览器 Cookie 去问，不受跨站读取限制
   *    ③ 本地可见的会话 Cookie → 'in'（很少能用上，跨站通常看不到）
   *    ④ 页面标记（最后兜底：① ② ③ 都问不出来时）→ 'in' / 'out'
   *    ⑤ 都不行 → 'unknown'（不猜，继续跑，真未登录会在点击时被拦下）
   */
  async function detectLogin() {
    const sigAge = state.login.state === 'out' && state.login.at ? Date.now() - state.login.at : Infinity;
    // ① 刚出现"登录已过期"这类明确响应 → 压过一切
    if (state.login.method === '响应' && sigAge < NOT_LOGIN_SIGNAL_TTL_MS) return 'out';

    // ② 响应判据（首选）
    const byApi = await probeLoginByResponse();
    if (byApi === 'in') {
      state.login = { state: 'in', method: '响应', evidence: 'queryUserInfo 返回了 userInfo', at: Date.now() };
      return 'in';
    }
    if (byApi === 'out') {
      state.login = { state: 'out', method: '响应', evidence: 'queryUserInfo 返回"用户未登录"', at: Date.now() };
      return 'out';
    }

    // ③ 本地能看到的会话凭据（跨站通常看不到，看到就是硬证据）
    if (await readSessionCookies() === true) {
      state.login = { state: 'in', method: '会话凭据', evidence: 'sid/hwid_cas_sid 存在', at: Date.now() };
      return 'in';
    }

    // ④ 页面标记兜底
    const byPage = await detectLoginByPage();
    if (byPage === 'in') {
      state.login = { state: 'in', method: '页面标记', evidence: '页面上有"退出登录/我的订单"等登录后标记', at: Date.now() };
      return 'in';
    }
    if (byPage === 'out') {
      state.login = { state: 'out', method: '页面标记', evidence: '多拍都显示"请登录"且无登录后标记', at: Date.now() };
      return 'out';
    }

    // ⑤ 真的判不出来 → 不猜
    state.login = { state: 'unknown', method: '凭据+页面', evidence: `${state.loginProbe || '三层判据都没结果'}；页面也没有明确登录标记`, at: Date.now() };
    return 'unknown';
  }

  /** 登录态的可读描述（用于日志）。 */
  function loginReason(lg) {
    const method = state.login.method || '凭据';
    const ev = state.login.evidence || '';
    if (lg === 'unknown') return `${state.login.evidence || '读不到会话凭据，页面上也没有明确的登录标记'}`;
    return `${method}：${ev}`;
  }

  /**
   * 把配置里的商品统一成数组。
   *
   * 配置格式：products[] 里每一项 = 一个商品页 URL。
   * 一个 URL 就是一个确定的商品 —— 所以**不需要标题关键字去认**，
   * 靠 prdId 或 URL 精确匹配就够了，反而不会认错。
   *
   * 抢购目标是 SKU（sbomCodes），不是关键字：
   *   留空 = 该商品所有规格都算目标
   *   有值 = 只抢列出的那些 SKU 编号
   */
  function normalizeTargets(config) {
    const out = [];
    const src = Array.isArray(config?.products) ? config.products : [];

    for (const t of src) {
      if (!t || typeof t !== 'object') continue;
      const url = t.url || null;
      if (!url) continue;
      out.push({
        id: t.id || String(t.prdId || '') || extractPrdId(url) || `product_${out.length + 1}`,
        enabled: t.enabled !== false,
        url,
        prdId: t.prdId ? String(t.prdId) : extractPrdId(url),
        // 要抢的 SKU 编号（空 = 全部）
        // 字段名用通用的 skuIds；兼容旧配置里华为专用的 sbomCodes
        skuIds: (() => {
          const raw = Array.isArray(t.skuIds) ? t.skuIds : Array.isArray(t.sbomCodes) ? t.sbomCodes : [];
          return raw.map(String).filter(Boolean);
        })(),
        // 打开页面时定位到哪个规格
        openSbomCode: t.openSbomCode ? String(t.openSbomCode) : null,
        maxPrice: t.maxPrice ?? null,
        quantity: t.quantity ?? null,
        saleAt: t.saleAt ?? null,
        note: t.note || '',
      });
    }

    // 兼容旧配置（单目标 targets/或 target/ 写法），读得到就用，不主动写回
    if (!out.length) {
      const legacy = Array.isArray(config?.targets) ? config.targets : config?.target ? [config.target] : [];
      for (const t of legacy) {
        if (!t || typeof t !== 'object' || !t.url) continue;
        out.push({
          id: t.id || String(t.prdId || '') || `legacy_${out.length + 1}`,
          enabled: t.enabled !== false,
          url: t.url,
          prdId: t.prdId ? String(t.prdId) : extractPrdId(t.url),
          skuIds: Array.isArray(t.skuIds) ? t.skuIds.map(String).filter(Boolean) : Array.isArray(t.sbomCodes) ? t.sbomCodes.map(String).filter(Boolean) : [],
          openSbomCode: t.sbomCode ? String(t.sbomCode) : null,
          maxPrice: t.maxPrice ?? config.maxPrice ?? null,
          quantity: t.quantity ?? null,
          saleAt: t.saleAt ?? config.saleAt ?? null,
          note: '',
        });
      }
    }
    return out;
  }

  function extractPrdId(url) {
    if (!url || typeof url !== 'string') return null;
    const m =
      url.match(/prdId=(\d{6,})/) ||
      url.match(/\/product\/(\d{6,})\.html/) ||
      url.match(/\/product\/(\d{6,})/);
    return m ? m[1] : null;
  }

  /**
   * 读页面内嵌数据（__NEXT_DATA__）里某个 SKU 的信息。
   *
   * 华为详情页是 Next.js 做的，全部数据都在 <script id="__NEXT_DATA__"> 里：
   *   mainData.current.base[sbomCode]        → 规格名 / 价格 / buttonMode
   *   extData.skuRushbuyInfo                 → 每个 sbomCode 的开售时间
   *
   * 这是脚本唯一可靠的"当前选中了哪个 SKU"判据 ——
   * 不用去猜按钮高亮，也不用标题关键字。
   *
   * @param {string} sbomCode SKU 编号
   * @returns {object|null} { sbomCode, label, price, buyableText, rushStartTime, limitNum, attrs }
   */
  function readSbomInfo(sbomCode) {
    if (!sbomCode) return null;
    let pp = null;
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      pp = JSON.parse(el.textContent)?.props?.pageProps;
    } catch {
      return null;
    }
    const cur = pp?.mainData?.current;
    if (!cur) return null;

    const base = cur.base?.[String(sbomCode)];
    if (!base) return null;

    // 规格维度取值（颜色/版本/…）
    const attrs = {};
    const gbom = cur.productOptions?.gbomAttrMappings || {};
    for (const [dim, arr] of Object.entries(gbom)) {
      if (!Array.isArray(arr)) continue;
      const hit = arr.find((x) => String(x?.sbomCode) === String(sbomCode));
      if (hit && hit.attrValue != null) attrs[dim] = String(hit.attrValue);
    }

    // 该 SKU 的抢购场次
    let rushStartTime = null;
    let limitNum = null;
    const rushList = pp?.extData?.skuRushbuyInfo?.skuRushBuyInfoList;
    if (Array.isArray(rushList)) {
      const r = rushList.find((x) => String(x?.sbomCode) === String(sbomCode));
      if (r) {
        limitNum = r.limitNum ?? null;
        if (r.startTime != null) {
          const ms = typeof r.startTime === 'number' ? r.startTime : parseInt(r.startTime, 10);
          if (Number.isFinite(ms) && ms > 1e12) {
            const d = new Date(ms);
            const p = (x) => String(x).padStart(2, '0');
            rushStartTime =
              `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
              `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
          }
        }
      }
    }

    const bm = base.buttonMode != null ? String(base.buttonMode) : null;
    const buyableText = { 1: '现货可买', 2: '即将开售', 3: '现货可买', 9: '缺货', 10: '缺货', 29: '抢购未开售', 31: '预约中' }[Number(bm)] || (bm == null ? '未知' : `未识别模式 ${bm}`);

    return {
      sbomCode: String(sbomCode),
      label: base.name || base.sbomAbbr || '',
      price: typeof base.price === 'number' ? base.price : null,
      buyableText,
      buttonMode: bm,
      rushStartTime,
      limitNum: limitNum ?? base.limitedQuantity ?? null,
      attrs,
    };
  }

  /**
   * 把页面切到指定 SKU。
   *
   * 方式：直接改地址栏的 sbomCode 参数并等页面自己重新渲染。
   * 这是最稳的一条路 —— 走页面自己的逻辑，不会点错按钮，
   * 也不会出现"按钮高亮了但实际 SKU 不是它"的情况。
   *
   * @returns {boolean} 是否成功停在目标 SKU
   */
  async function switchToSbom(sbomCode) {
    const cur = readSbomInfo(curSbomCode());
    if (cur && String(cur.sbomCode) === String(sbomCode)) return true;

    const url = new URL(location.href);
    const before = url.searchParams.get('sbomCode');
    url.searchParams.set('sbomCode', String(sbomCode));
    log(`切换规格到 sbomCode=${sbomCode}（原 ${before || '无'}）`);
    location.href = url.toString();
    return false; // 页面会跳走，调用方不需要等
  }

  /** 当前页面正在展示的 sbomCode */
  function curSbomCode() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('sbomCode') || '';
    } catch {
      return '';
    }
  }

  /**
   * 找出当前页面匹配哪个配置商品。
   *
   * 只用两种判据，都不会认错：
   *   1. prdId 完全一致（商品编号是平台自己的主键）
   *   2. URL 完全一致
   *
   * 刻意**不做**标题关键字匹配 —— 一个 URL 就是一个商品，
   * 用关键字去猜反而会在同系列机型之间认错（比如 Mate 90 和 Mate 90 Pro Max）。
   *
   * 返回 { matched, reason, checkedCount, pagePrdId, title }
   */
  function checkTarget(config) {
    const targets = normalizeTargets(config);
    const url = location.href;
    const pagePrdId = extractPrdId(url);
    const title = clean(document.title);

    if (!targets.length) {
      return { matched: null, ok: false, reason: '配置里没有任何商品（products 是空的）', checkedCount: 0, pagePrdId, title };
    }

    // 1) prdId 匹配
    if (pagePrdId) {
      const hit = targets.find((t) => t.prdId && String(t.prdId) === String(pagePrdId));
      if (hit) {
        return { matched: hit, ok: true, reason: '商品编号匹配', checkedCount: targets.length, pagePrdId, title };
      }
    }

    // 2) URL 匹配
    const byUrl = targets.find((t) => t.url && t.url === url);
    if (byUrl) {
      return { matched: byUrl, ok: true, reason: 'URL 完全匹配', checkedCount: targets.length, pagePrdId, title };
    }

    return {
      matched: null,
      ok: false,
      reason: `当前页面不在配置里（页面商品编号 ${pagePrdId || '未识别'}，标题「${title}」）`,
      checkedCount: targets.length,
      pagePrdId,
      title,
    };
  }

  /** SPA 切页哨兵。
   *
   * 为什么单独装：主循环每轮会调stillOnTarget()，但轮询间隔最长 3s
   * （配置 pollIntervalMs）—— 页面身份变了到被发现之间有最长 3 秒空窗。
   * 那3 秒里脚本还绑着**上一个商品**的规格和价格上限在跑，必须堵上。
   *
   * Next.js 的路由跳转走 history.pushState/replaceState，不触发 popstate，
   * 所以三种都要监听；再加一层轮询兜底，防止 history 被框架代理后钩不到。
   */
  function watchTargetLeaving(config) {
    let done = false;
    let hadPanel = false;// 本页是否真的插过面板（=脚本是否接管过）
    const onLeave = (why) => {
      if (done || state.stopped) return;
      if (panelEl) hadPanel = true;
      // 每轮重读一次缓存：商品列表可能刚被控制台改过，
      // 拿旧列表判定会把刚被移出列表的商品当成还在列表内。
      const cfg = state.config || GM_getValue('config', null) || config;
      if (stillOnTarget(cfg)) return; // 还在列表内那个商品，不算离开
      done = true;
      state.stopped = true;
      try { if (state.giveUpTimer) clearTimeout(state.giveUpTimer); } catch { /* 无定时器 */ }
      teardownPanel();
      // 没接管过本页（面板从没插过）说明脚本本就不该在这里，
      // 只在 console 留一句最简说明即可，别去回传结果——那也是副作用。
      // （首次 goto 导航本身也会触发一次 popstate，属正常，直接静默。）
      if (!hadPanel) {
        if (why !== '首次进入') {
          console.info(`[抢购脚本] 页面已切到商品列表之外的商品，脚本已停止。`);
        }
        clearInterval(timer); clearInterval(stopWatch);
        return;
      }
      console.warn(`[抢购脚本] 页面已切到商品列表之外的商品（${why}），脚本已停止一切动作。`);
      report({
        outcome: 'SKIPPED_NOT_TARGET',
        resultCode: 'PAGE_LEFT_TARGET',
        message: `页面已切到商品列表之外的商品（${why}），脚本已停止`,
        pageUrl: location.href,
      }).catch(() => {});
    };

    const fire = (why) => { try { onLeave(why); } catch (e) { console.error(LOG_PREFIX, '切页哨兵异常:', e); } };
    // pushState / replaceState 派发的是自定义事件，popstate 走原生事件。
    // 装好监听后立刻核对一次：此时还没有任何"跳转"，若本页已在列表外
    // 就此安静收摊——顺带把首次 goto 触发的 popstate 也归到"首次进入"。
    queueMicrotask(() => fire('首次进入'));
    window.addEventListener('qp:locationchange', () => fire('路由跳转'));
    window.addEventListener('popstate', () => fire('浏览器前进/后退'));
    for (const fn of ['pushState', 'replaceState']) {
      const orig = history[fn];
      if (typeof orig !== 'function') continue;
      history[fn] = function patched(...a) {
        const r = orig.apply(this, a);
        try { window.dispatchEvent(new Event('qp:locationchange')); } catch { /* 忽略 */ }
        return r;
      };
    }
    // 兜底：即使 history 钩子被框架代理掉了，每500ms 也核对一次。
    const timer = setInterval(() => { try { onLeave('轮询核对'); } catch { /* 忽略 */ } }, 500);
    // 一旦停手就撤掉哨兵，避免永久定时器挂在页面上。
    const stopWatch = setInterval(() => {
      if (state.stopped) { clearInterval(timer); clearInterval(stopWatch); }
    }, 1000);
  }

  /** 当前页面是否仍是「启动时匹配到的那个列表内商品」。
   *
   * 为什么需要：vmall 是 Next.js 单页应用，站内跳转（点推荐位、点推荐商品）
   * 只换 URL 和 DOM，**不重新加载文档** → 油猴脚本不重启 → 启动时的判定
   * 结果会一直沿用。用户 2026-10-07 明确要求不在列表里的商品不运作，
   * 所以每次动手前都要重新核对页面身份。
   *
   * 比对基准是「启动时匹配到的那个 prdId」，不是「当前列表里的任意商品」——
   * 否则在 A 商品页启动、切到另一个也在列表里的 B 商品，判定会通过，
   * 而脚本绑定的仍然是 A 的规格与价格上限，等于拿错刀。
   */
  function stillOnTarget(config) {
    // 基准是「启动时匹配到的那个 prdId」，不是「列表里的任意商品」——
    // 否则在 A 商品页启动、切到另一个也在列表里的 B 商品，判定会通过，
    // 而脚本绑定的仍然是 A 的规格与价格上限，等于拿错刀。
    if (state.targetPrdId) {
      const now = extractPrdId(location.href);
      if (!now || String(now) !== String(state.targetPrdId)) return false;
      return true;
    }
    // 还没匹配到目标（脚本刚启动）：只要本页不在列表里就算越界。
    if (!config || !Array.isArray(config.products)) return true; // 无从判定，先不误杀
    const t = checkTarget(config);
    return !!(t.ok && t.matched);
  }

  /**
   * 读页面价格。
   *
   * ⚠ 这条路踩过三次坑，记录在此避免重犯：
   *   1. 最初：「找『价格』再取其后数字」→ 命中服务承诺文案「价格保护 7天」，读成 ¥7
   *   2. 然后：「扫全页取合理量级的最小值」→ 命中推荐位里的其它机型 ¥6499
   *   3. 最终：**用容器定位，不靠全页量级猜**
   *
   * 实测华为商品页的稳定特征（2026-10 侦察）：
   *   · 主商品详情容器为  div#prd-detail
   *   · 主价格在该容器内，字号 30px（页面最大），且是页面顶部第一个大数字
   *   · 推荐位价格都在 #recommendItem 内，字号仅 20px —— 共 29 个干扰项
   *   · 页尾另有以旧换新抵扣额（如 ¥950805），量级明显异常，需排除
   */
  function readPrice() {
    const collect = (root) =>
      Array.from(root.querySelectorAll('*'))
        .filter((el) => {
          const t = clean(el.innerText || el.textContent);
          if (!t || t.length > 24) return false;
          if (el.children.length > 2) return false;
          if (!/^[¥￥]?\s*[\d,]{4,}(?:\.\d{1,2})?$/.test(t)) return false;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          return true;
        })
        .map((el) => ({
          el,
          text: clean(el.innerText || el.textContent),
          value: parseFloat(clean(el.innerText || el.textContent).replace(/[¥￥,\s]/g, '')),
          fontSize: parseFloat(getComputedStyle(el).fontSize) || 0,
          top: el.getBoundingClientRect().top + window.scrollY,
        }))
        .filter((x) => Number.isFinite(x.value) && x.value >= 50);

    // 优先在商品详情容器内找
    let scope = document.querySelector('#prd-detail');
    let fromDetailContainer = Boolean(scope);
    if (!scope) scope = document.body;

    let cands = collect(scope).filter((c) => !inRecommend(c.el));

    // 兜底：容器没找到时，退化为「排除推荐位后按字号最大、位置最前」选取
    if (!cands.length && fromDetailContainer) {
      fromDetailContainer = false;
      cands = collect(document.body).filter((c) => !inRecommend(c.el));
    }

    if (!cands.length) {
      return { value: null, source: null, unreliable: true, reason: '页面上找不到任何金额元素' };
    }

    // 主价格特征：字号最大者中最靠上的那个
    const maxFont = Math.max(...cands.map((c) => c.fontSize));
    const bigFont = cands
      .filter((c) => c.fontSize === maxFont)
      .sort((a, b) => a.top - b.top);

    const chosen = bigFont[0];

    // 数量级校验：主价格不应超过 7 位数（以旧换新抵扣额等异常值会被这里挡掉）
    if (chosen.value > 9999999) {
      return {
        value: null,
        source: chosen.text,
        unreliable: true,
        reason: `选中的金额 ${chosen.value} 量级异常，疑似抵扣额而非商品价`,
        allCandidates: cands.slice(0, 8).map((c) => ({ v: c.value, fs: c.fontSize, top: Math.round(c.top) })),
      };
    }

    // 歧义提示：同字号还有别的金额（例如主商品 + 更高配机型），一并上报供人工核对
    const sameFontOthers = bigFont.slice(1).map((c) => c.value);

    return {
      value: chosen.value,
      source: `${chosen.text}（字号${maxFont}px，${fromDetailContainer ? '#prd-detail 容器内' : '全页兜底'}，页面位置 y=${Math.round(chosen.top)}）`,
      ambiguous: sameFontOthers.length > 0,
      allCandidates: cands.slice(0, 8).map((c) => ({ v: c.value, fs: c.fontSize, top: Math.round(c.top) })),
      sameFontOthers,
    };
  }

  /** 找"购买/加购"按钮。只用文本判定，且要求按钮可见可点。 */
  function findBuyButton() {
    const BUY = ['立即购买', '立即申购', '加入购物车', '立即预订', '马上抢', '立即抢购'];
    const nodes = document.querySelectorAll('a,button,div,span');
    const hits = [];
    for (const el of nodes) {
      // 只看叶子级（自身文本短），避免把整块容器算进来
      const t = textOf(el);
      if (!t || t.length > 12) continue;
      if (!BUY.some((k) => t.includes(k))) continue;
      // 排除含子链接的导航块
      if (el.tagName === 'A' && el.querySelector('a')) continue;
      hits.push(el);
    }
    // 挑选优先级（2026-10-06 演练实测踩坑：文档序第一个可点命中可能是
    // 「1 加入购物车 立即购买」这种恰好 12 字内的容器，容器上 .click()
    // 落不到真按钮，页面毫无反应，DRY_RUN_OK 是假阳性）：
    //   1) 文本恰好等于按钮文案的是真按钮
    //   2) 同为精确文案时按 BUY 列表顺序（立即购买 优先于 加入购物车）
    //   3) button/a 标签优先于 div/span 容器
    //   4) 文本更短的更接近按钮本体
    //   5) DOM 层级更深的更像叶子
    const kwOrder = (t) => BUY.findIndex((k) => t.includes(k));
    const depth = (el) => { let d = 0; for (let n = el; n && n !== document.body; n = n.parentElement) d++; return d; };
    const cands = hits.filter(isActionable).sort((a, b) => {
      const ta = textOf(a), tb = textOf(b);
      const ea = BUY.some((k) => ta === k) ? 0 : 1, eb = BUY.some((k) => tb === k) ? 0 : 1;
      if (ea !== eb) return ea - eb;
      if (ea === 0 && kwOrder(ta) !== kwOrder(tb)) return kwOrder(ta) - kwOrder(tb);
      const ga = a.tagName === 'BUTTON' || a.tagName === 'A' ? 0 : 1;
      const gb = b.tagName === 'BUTTON' || b.tagName === 'A' ? 0 : 1;
      if (ga !== gb) return ga - gb;
      if (ta.length !== tb.length) return ta.length - tb.length;
      return depth(b) - depth(a);
    });
    const actionable = cands[0] || null;
    return { all: hits, actionable };
  }

  /** 判断是否缺货 / 未开售 */
  function readStockState() {
    const t = visibleText();
    const buy = findBuyButton();
    if (buy.actionable) return { state: 'IN_STOCK', evidence: textOf(buy.actionable) };
    if (/已售罄|售罄|暂时缺货|无货|到货通知|补货中/.test(t)) {
      return { state: 'OUT_OF_STOCK', evidence: (t.match(/已售罄|售罄|暂时缺货|无货|到货通知|补货中/) || [])[0] };
    }
    if (/即将开始|即将开售|未开售|倒计时|敬请期待/.test(t)) {
      return { state: 'PREORDER', evidence: (t.match(/即将开始|即将开售|未开售|倒计时|敬请期待/) || [])[0] };
    }
    return { state: 'UNKNOWN', evidence: null };
  }

  /** 读取页面上的真实支付倒计时 */
  function readPayCountdown() {
    const t = visibleText();
    const mmss = t.match(/(?:剩余|倒计时|请在)\s*(\d{1,3}):(\d{2})/);
    if (mmss) return (parseInt(mmss[1], 10) * 60 + parseInt(mmss[2], 10)) * 1000;
    const mins = t.match(/(\d{1,3})\s*分钟内(?:完成)?支付/);
    if (mins) return parseInt(mins[1], 10) * 60 * 1000;
    return null;
  }

  /** 从页面上读真实订单号。读不到返回 null —— 绝不编造。 */
  function readOrderNo() {
    const t = visibleText();
    const m =
      t.match(/订单(?:号|编号)[：:\s]*([A-Za-z0-9_-]{8,40})/) ||
      t.match(/(?:order\s*(?:no|number|id))[：:\s]*([A-Za-z0-9_-]{8,40})/i);
    return m ? m[1] : null;
  }

  /** 验证码 / 风控特征检测 */
  function detectChallenge() {
    const t = visibleText();
    const hasSlider = !!document.querySelector(
      '[class*="slider"],[class*="captcha"],[id*="captcha"],iframe[src*="captcha"],[class*="verify"]',
    );
    if (/安全验证|滑动验证|人机验证|请完成验证|拖动滑块|验证码/.test(t)) return 'CAPTCHA';
    if (hasSlider && t.length < 600) return 'CAPTCHA';
    if (/访问受限|操作过于频繁|请求过于频繁|异常流量|拒绝访问/.test(t)) return 'RISK_BLOCKED';
    // 登录：不再单凭页面文案（页头水合期会短暂显示"请登录"，实测会误判）。
    // 只有①接口响应明确报未登录，或②会话凭据确实不存在时，才算真的掉线。
    if (/请登录|立即登录|账号登录/.test(t)) {
      if (state.login.state === 'out') return 'NEEDS_LOGIN';   // ① 响应负信号
      if (state.login.state === 'in') return null;             // ② 凭据在 → 文案抖动，忽略
      return 'NEEDS_LOGIN';                                    // ③ 还没查过 → 保守起见仍转人工
    }
    return null;
  }

  /* ============================ 操作 ============================ */

  /** 选择规格（按按钮文字精确匹配）。入参直接是规格对象：{ "颜色": "翡冷翠", ... } */
  async function selectSpecs(specsIn) {
    const specs = specsIn || {};
    const wanted = Object.entries(specs).filter(([k, v]) => !k.startsWith('_') && v);
    if (!wanted.length) {
      log('配置未指定规格，使用页面默认');
      return { ok: true, selected: [] };
    }

    const selected = [];
    for (const [group, value] of wanted) {
      const candidates = Array.from(document.querySelectorAll('div,span,a,li,button')).filter((el) => {
        const t = textOf(el);
        return t === value && t.length <= 40;
      });
      const clickable = candidates.find(isActionable) || candidates[0];
      if (!clickable) {
        log(`规格「${group}=${value}」在页面上找不到，跳过`, 'warn');
        continue;
      }
      clickable.click();
      selected.push(`${group}=${value}`);
      log(`已选规格 ${group}=${value}`, 'ok');
      await sleep(jitter(400, 0.4));
    }
    return { ok: selected.length > 0, selected };
  }

  /** 点击购买按钮 */
  async function clickBuy() {
    const buy = findBuyButton();
    if (!buy.actionable) return { ok: false, reason: '按钮不存在或不可点' };
    const label = textOf(buy.actionable);
    log(`点击「${label}」`, 'ok');
    buy.actionable.click();
    return { ok: true, label };
  }

  /** 在确认/结算页点击"提交订单" */
  async function clickSubmitOrder() {
    const SUBMIT = ['提交订单', '确认下单', '立即支付', '去支付', '确认支付'];
    const nodes = document.querySelectorAll('a,button,div,span');
    for (const el of nodes) {
      const t = textOf(el);
      if (!t || t.length > 12) continue;
      if (!SUBMIT.some((k) => t.includes(k))) continue;
      if (!isActionable(el)) continue;
      log(`点击「${t}」`, 'ok');
      el.click();
      return { ok: true, label: t };
    }
    return { ok: false };
  }

  /* ============================ 主流程 ============================ */

  async function main() {
    // ══════════════════════════════════════════════════════════════
    // 第0 道闸：商品列表白名单 —— 必须放在**一切副作用之前**
    // ══════════════════════════════════════════════════════════════
    // 用户手动打开任何商品页时脚本都会注入（@match 覆盖全站商品页）。
    // 用户 2026-10-07 明确要求：**不在商品列表里的商品，脚本不运作**。
    // 所以这里连面板都不插、不向桥接发任何请求、不动 GM 缓存 ——
    // 判定不通过就直接安静退出，页面保持原样。
    //
    // 为什么必须放最前面：原实现是「插面板 → 拉配置（GET 桥接 + 覆写
    // GM 缓存）→ 补发历史结果 → 才 checkTarget」。也就是在你不认识的
    // 商品页上，脚本照样插面板、照样发请求、照样覆写全局配置缓存。
    // 真正点击购买虽然被守着，但"运作"本身就已经越界了。

    // ── 商品列表：直接读控制台那份清单（用户要求）──
    // 不用"手动维护的本地缓存"当权威来源 —— 缓存会过期、会跟控制台脱节。
    // 读控制台（本地桥接，只读）→ 拿到的就是控制台「商品与 SKU」页显示的那份。
    const listed = await readProductList();
    const cachedCfg = listed.config;

    // ★ 切页哨兵必须在**任何判定之前**就装上。
    // 原先它装在「匹配到目标」之后，实测发现脚本会卡在"等配置"那一步
    // （当时是 loadConfig 等桥接响应）而永远走不到装哨兵的位置 —— 哨兵形同虚设，
    // 结果就是 SPA 跳到列表外商品后脚本仍在页面上运作（2026-10-07 实测失败）。
    // 哨兵自带独立的 500ms 轮询兜底，不依赖主流程是否走完。
    watchTargetLeaving(cachedCfg);

    if (!cachedCfg) {
      // 控制台读不到（桥接没开）且本地无缓存 → 无从确认本页是否在列表内。
      // 按"不在列表就不动"的原则安静退出，宁可不跑也不越界。
      console.info(
        `[抢购脚本] 本页未做任何操作：读不到商品列表。\n` +
        `  · 请确认控制台（桥接服务 ${DEFAULT_BRIDGE}）在运行：node core/grab-bridge.mjs；\n` +
        `  · 或先打开一次商品列表里的商品页，让脚本留一份本地缓存兜底。`,
      );
      return;
    }

    // 按控制台那份清单判定本页（按商品编号 prdId 认，不猜标题）。
    const preCheck = checkTarget(cachedCfg);
    if (!preCheck.ok) {
      // 不在列表里 → 安静退出。面板不插、请求不发、缓存不写。
      // 用 console.info 而不是插页面元素：任何 DOM 操作都算"动了你的页面"。
      console.info(
        `[抢购脚本] 本页未做任何操作：${preCheck.reason}\n` +
        `  商品列表（来源：${listed.source}）共 ${preCheck.checkedCount} 项，均不匹配本页` +
        `（商品编号 ${preCheck.pagePrdId || '未识别'}，标题「${preCheck.title}」）。`,
      );
      return;
    }

    // ── 以下才会开始有副作用 ──
    // 关键：先确保 document.body 存在再建面板。
    // 之前直接 ensurePanel()，body 为 null 时 appendChild 抛错，
    // 异常冒到 IIFE 外 → 脚本静默死掉 → 面板不出现 + 油猴红叉。
    await waitForBody();
    ensurePanel();
    log(`商品列表已读取（来源：${listed.source}，共 ${preCheck.checkedCount} 项）`, 'ok');
    log('脚本已注入，正在载入配置…');

    // 配置就是刚读到的这份（控制台权威）。不再二次请求，免得读到两份不一致的列表。
    const config = cachedCfg;
    if (listed.source === '控制台') {
      // 只在"本页确认在列表内"之后才落缓存 —— 列表外页面零痕迹。
      try { GM_setValue('config', config); GM_setValue('configFetchedAt', Date.now()); } catch { /* 存储不可用 */ }
    }
    state.config = config;
    state.profileId = config.profileId || 'default';
    state.bridgeUrl = config.bridge?.url || DEFAULT_BRIDGE;

    // 装登录态观察器（以接口响应/浏览器凭据为准，不看页面文案）
    installLoginWatchers();

    // 配置可能刚从桥接刷新过，这里**再判一次**（配置变了，商品列表可能变了）。
    const postCheck = checkTarget(config);
    if (!postCheck.ok || !postCheck.matched) {
      log(`本页已从列表内变成列表外（${postCheck.reason}），脚本停止一切动作。`, 'warn');
      teardownPanel();
      await report({
        outcome: 'SKIPPED_NOT_TARGET',
        resultCode: 'TARGET_INVALID',
        message: postCheck.reason,
        pagePrdId: postCheck.pagePrdId,
        pageTitle: postCheck.title,
      }).catch(() => {});
      return;
    }

    // 补发上次没发出去的结果
    flushPending().catch(() => {});

    if (config.enabled === false) {
      setPhase('未启用');
      log('配置里 enabled=false，脚本不动作。需要跑就在控制台把"启用"打开。', 'warn');
      return;
    }

    // ── 目标识别（支持配置里配多个目标）──
    const tgt = checkTarget(config);
    if (!tgt.ok || !tgt.matched) {
      setPhase('非目标页面');
      log(`${tgt.reason}`, 'warn');
      log(`配置里有 ${tgt.checkedCount} 个目标，本页都不匹配，插件不做任何操作。`);
      await report({
        outcome: 'SKIPPED_NOT_TARGET',
        resultCode: 'TARGET_INVALID',
        message: tgt.reason,
        pagePrdId: tgt.pagePrdId,
        pageTitle: tgt.title,
      });
      return;
    }

    const activeTarget = tgt.matched;
    // 记下启动时的商品编号：SPA 站内跳转不重载文档，主循环每轮拿它核对页面身份，
    // 一旦跳到别的商品就立刻停手（用户要求：不在列表里的商品不运作）。
    state.targetPrdId = activeTarget.prdId || tgt.pagePrdId || extractPrdId(location.href);
    log(`✓ 匹配到目标「${activeTarget.id}」（${tgt.reason}）`, 'ok');

    if (activeTarget.enabled === false) {
      setPhase('目标已停用');
      log(`该目标在配置里 enabled=false，只采集不抢购。`, 'warn');
      await report({
        outcome: 'SKIPPED_DISABLED',
        resultCode: null,
        targetId: activeTarget.id,
        message: `目标「${activeTarget.id}」在配置里已停用`,
      });
      return;
    }

    // 抢购目标：这个商品下要抢的 SKU 编号（留空 = 全部规格）
    const wantSboms = Array.isArray(activeTarget.skuIds) ? activeTarget.skuIds : [];
    const effMaxPrice = activeTarget.maxPrice != null ? activeTarget.maxPrice : config.maxPrice ?? null;
    const effQuantity = activeTarget.quantity ?? config.quantity ?? 1;
    const effSaleAt = activeTarget.saleAt || config.saleAt || null;
    log(
      `目标规格：${wantSboms.length ? wantSboms.join(', ') : '该商品全部规格'}` +
        `　价格上限：${effMaxPrice ?? '不限'}　数量：${effQuantity}`,
    );

    // 开售时间：配置里填的优先；没填就试着用该 SKU 自己的场次时间。
    //
    // ⚠ 实测坑：__NEXT_DATA__ 里的 extData.skuRushbuyInfo 在首屏是**空的**
    //   （SSR 不填抢购数据），所以 readSbomInfo().rushStartTime 通常读不到。
    //   真正有场次数据的是页面自己发起的 buy.vmall.com/queryRushbuyInfo.json，
    //   那是异步响应，脚本读不到（也不该读 —— 只读页面自身数据，不碰接口）。
    //   所以：读不到就明确告诉人「要在配置里填 saleAt」，而不是静默按"不定时"抢。
    let saleAtIso = effSaleAt;
    if (!saleAtIso && wantSboms.length === 1) {
      const sbomInfo = readSbomInfo(wantSboms[0]);
      if (sbomInfo && sbomInfo.rushStartTime) {
        saleAtIso = sbomInfo.rushStartTime;
        log(`开售时间取自该 SKU 的抢购场次：${saleAtIso}`, 'ok');
      } else {
        log(
          `该规格的开售时间读不到（页面首屏不带抢购场次数据）。` +
            `若这是定时抢购，请在配置里给「${activeTarget.id}」填上开售时间，否则脚本会按「看到可买就买」处理。`,
          'warn',
        );
      }
    } else if (!saleAtIso) {
      log('配置里没填开售时间，按「看到可买就买」处理。', 'dim');
    }

    // ── 登录态 ──
    // 判据顺序：接口明确"登录已过期"响应 → 华为账号会话凭据 → 页面登录标记（兜底）。
    // 注意：会话凭据在 id1.cloud.huawei.com 域下，脚本在 item.vmall.com 上**跨站看不到**
    // 是常态，那属"未知"而不是"未登录"（2026-10-07 用户实测踩过这个坑）。
    const lg = await detectLogin();
    if (state.loginProbe) log(`凭据探测：${state.loginProbe}`, 'dim');
    if (lg === 'out') {
      setPhase('等待登录');
      log(`未登录（${loginReason(lg)}）。请先登录华为账号，登录后脚本自动继续。`, 'warn');
      const waited = await waitForAsync(async () => (await detectLogin()) !== 'out', 120000, 2000);
      if (!waited) {
        await report({
          outcome: 'WAITING_HUMAN',
          resultCode: 'NEEDS_LOGIN',
          message: '等待登录超时（120 秒），脚本停止',
          humanAction: '请在页面上完成登录后刷新',
        });
        return;
      }
      log('检测到登录态，继续', 'ok');
    } else if (lg === 'unknown') {
      // 判不出来就不猜：继续跑，让后续点击流程兜底
      // （真没登录时点击会跳登录页，detectChallenge 会兜住并转人工）
      log(`登录态无法确认（${loginReason(lg)}），继续执行；若未登录会在点击时被拦下转人工。`, 'warn');
    } else {
      log(`登录态：已登录（${loginReason(lg)}）`, 'ok');
    }

    // 验证/风控
    const challenge = detectChallenge();
    if (challenge) {
      setPhase('需要人工');
      log(`检测到 ${challenge}，按设计停下等人处理，不做任何绕过尝试`, 'err');
      await report({
        outcome: 'WAITING_HUMAN',
        resultCode: challenge,
        message: `页面出现 ${challenge}，脚本已停止等待人工处理`,
        humanAction: '请在页面上手动完成验证，然后刷新页面重启脚本',
        evidence: evidencePayload(),
      });
      return;
    }

    // 价格上限
    // ── 先切到目标规格，再读价格 ──
    //
    // 顺序很重要：同一个商品下不同规格价格不同（实测 ¥9499 ~ ¥12999），
    // 不先定位规格就读价格，读到的是另一个规格的钱，价格上限会判错。
    setPhase('定位规格');

    // 页面当前展示的 sbomCode：优先取地址栏里的，没有就退回页面数据里的
    const onPage = curSbomCode() || '';
    if (wantSboms.length) {
      if (!wantSboms.includes(String(onPage))) {
        // 配了多个 SKU 但页面停在其中一个 —— 无法在一次会话里同时盯多个，
        // 明确告诉人，而不是悄悄抢错规格。
        const info = readSbomInfo(wantSboms[0]);
        log(
          `页面当前在 sbomCode=${onPage || '(未识别)'}，目标第一个是 ${wantSboms[0]}` +
            `${info ? `（${info.label}）` : ''}`,
          'warn',
        );
        await switchToSbom(wantSboms[0]);
        // 页面即将跳转，这里主动结束本轮，等新页面重新加载后脚本会自动继续
        await report({
          outcome: 'SKIPPED_NAVIGATE',
          resultCode: 'SWITCHING_SKILL',
          targetId: activeTarget.id,
          message: `已切换到目标规格 sbomCode=${wantSboms[0]}，等待页面重新加载后继续`,
        });
        return;
      }
      const info = readSbomInfo(wantSboms[0]);
      if (info) {
        log(
          `已在目标规格上：${info.label}` +
            `　价格 ¥${info.price ?? '未读到'}　${info.buyableText}` +
            (Object.values(info.attrs || {}).length ? `　${Object.values(info.attrs).join(' / ')}` : ''),
          'ok',
        );
      }
    } else {
      const info = onPage ? readSbomInfo(onPage) : null;
      log(info ? `未指定具体规格，保持页面当前规格：${info.label}（¥${info.price ?? '?'}）` : '未指定具体规格，保持页面当前规格', 'dim');
    }

    // ── 价格上限校验（必须在切到目标规格之后）──
    const priceInfo = readPrice();
    const price = priceInfo ? priceInfo.value : null;
    const fmtCands = (list) =>
      (list || []).map((c) => (typeof c === 'object' ? `¥${c.v}(${c.fs}px)` : `¥${c}`)).join('、');

    if (price == null) {
      const why = priceInfo && priceInfo.unreliable ? `（${priceInfo.reason}）` : '';
      log(`⚠️ 未能读到可信价格${why}，价格上限校验本次跳过，请人工确认商品价格。`, 'warn');
      if (priceInfo && priceInfo.allCandidates) log(`   页面金额候选：${fmtCands(priceInfo.allCandidates)}`);
    } else if (effMaxPrice != null && price > effMaxPrice) {
      setPhase('价格超限');
      log(`页面价格 ¥${price} 高于上限 ¥${effMaxPrice}，不执行`, 'err');
      await report({
        outcome: 'FAILED',
        resultCode: 'PRICE_EXCEEDED',
        message: `价格 ¥${price} 超过目标「${activeTarget.id}」的上限 ¥${effMaxPrice}`,
        amount: price,
        priceSource: priceInfo.source,
        priceCandidates: priceInfo.allCandidates,
      });
      return;
    } else {
      log(`页面价格 ¥${price}（来源：${priceInfo.source}）${effMaxPrice != null ? `，上限 ¥${effMaxPrice}` : ''}`, 'ok');
      if (priceInfo.ambiguous && priceInfo.sameFontOthers.length) {
        log(`   同字号另有金额：${priceInfo.sameFontOthers.map((v) => '¥' + v).join('、')}，请确认取的是目标规格`, 'warn');
      }
    }

    // 定时抢购 / 直接抢购
    const saleAt = saleAtIso ? new Date(saleAtIso).getTime() : null;
    const earlySec = config.earlyEnterSec ?? 90;

    if (saleAt && Date.now() < saleAt - earlySec * 1000) {
      const waitSec = Math.round((saleAt - earlySec * 1000 - Date.now()) / 1000);
      setPhase(`等待开售（${waitSec}s）`);
      log(`距离开售还早，先停止操作。将在开售前 ${earlySec} 秒自动就位。`);
      await waitUntil(saleAt - earlySec * 1000);
    }

    if (saleAt && Date.now() < saleAt) {
      const left = Math.round((saleAt - Date.now()) / 1000);
      setPhase(`就位（${left}s）`);
      log(`已就位，等待开售信号（剩余 ${left} 秒）`);
    }

    // 设置放弃时限
    const giveUpMs = config.limits?.giveUpAfterMs ?? 1800000;
    state.giveUpTimer = setTimeout(() => {
      state.stopped = true;
    }, giveUpMs);

    // ── 主循环：等按钮可点 → 点击 ──
    //
    // ★ 轮询间隔是这条链路上唯一的真瓶颈（实测）
    //
    // 实测数据（真实商品页，2192 个可遍历元素）：
    //   一轮检测（读页面状态 + 找按钮）  仅 6ms
    //   但默认轮询间隔                  3000ms
    //   → 平均要等 1506ms 才发现按钮变了
    //
    // 也就是说，**99.6% 的等待时间花在"等下一次轮询"上**，
    // 跟"点击 vs 调接口"毫无关系 —— 点击本身是同步的，几毫秒。
    //
    // 所以这里做自适应：离目标时刻远时慢查（省资源），
    // 临近/到达目标时刻时快速查（抢时间）。
    //
    // 这样做不增加任何平台侧可见的流量 —— readStockState() 只读本地 DOM，
    // 一个网络请求都不发。纯粹是本机 CPU 开销（6ms/轮，150ms 间隔约占 4%）。
    setPhase('监听购买按钮');
    const pollMs = config.limits?.pollIntervalMs ?? 3000; // 平时
    const pollHotMs = config.limits?.pollIntervalHotMs ?? 150; // 临售/开售后
    const hotWindowMs = config.limits?.hotWindowMs ?? 10000; // 提前多久进入快查
    const jitterRatio = config.limits?.pollJitterRatio ?? 0.3;
    const maxRetry = config.limits?.maxRetryPerPage ?? 1;

    /** 当前该用哪个间隔 */
    const pickInterval = () => {
      // 没有目标时刻 → 不知道什么时候开售，直接一直快查
      if (!saleAt) return pollHotMs;
      // 已过开售时刻，或已进入临售窗口 → 快查
      if (Date.now() >= saleAt - hotWindowMs) return pollHotMs;
      return pollMs;
    };

    let hotAnnounced = false;

    let attempts = 0;
    const clickedKey = `clicked:${location.pathname}${location.search}`;

    while (!state.stopped) {
      // ★ 每一轮都先确认「当前页面还是列表内那个商品吗」。
      // vmall 是 Next.js 单页应用，站内点推荐位跳转不会重新加载文档，
      // 脚本不重启、checkTarget 也不会自动再跑 —— 原实现会出现
      //「你在列表内商品页点进别的商品，脚本继续盯着新商品抢」。
      // 这是用户 2026-10-07 明确禁止的行为：不在列表里的商品，脚本不运作。
      if (!stillOnTarget(config)) {
        setPhase('已离开目标商品');
        log('页面已切换到商品列表之外的商品，脚本停止一切动作并撤下面板。', 'warn');
        teardownPanel();
        state.stopped = true;
        break;
      }

      // 每次都重新检查风控，一旦出现立即停
      const ch = detectChallenge();
      if (ch) {
        setPhase('需要人工');
        log(`运行中出现 ${ch}，停止并转人工`, 'err');
        await report({
          outcome: 'WAITING_HUMAN',
          resultCode: ch,
          message: `运行中检测到 ${ch}`,
          humanAction: '请手动处理验证后重试',
          evidence: evidencePayload(),
        });
        return;
      }

      const stock = readStockState();
      if (stock.state === 'OUT_OF_STOCK') {
        if ((config.mode || 'rush') === 'monitor') {
          setPhase('缺货，轮询中');
          log(`缺货（${stock.evidence}），${pollMs}ms 后重试`);
        } else {
          setPhase('缺货');
          log(`缺货（${stock.evidence}）。rush 模式不轮询，结束。`, 'warn');
          await report({
            outcome: 'FAILED',
            resultCode: 'OUT_OF_STOCK',
            message: `商品缺货：${stock.evidence}`,
          });
          return;
        }
      } else if (stock.state === 'IN_STOCK') {
        // 幂等：本次页面已经点过就不再点
        if (GM_getValue(clickedKey, false)) {
          setPhase('已点击，等结果');
        } else if (attempts >= maxRetry) {
          setPhase('重试超限');
          log(`本页已尝试 ${attempts} 次，达到上限 ${maxRetry}，停止`, 'warn');
          break;
        } else {
          attempts++;
          setPhase('点击购买');
          const r = await clickBuy();
          if (r.ok) {
            GM_setValue(clickedKey, true);
            state.submittedOnce = true;
            log('已点击购买，等待进入结算页…', 'ok');
            await sleep(2500);
            await handleAfterBuy(config);
            return;
          }
          log(`点击失败：${r.reason}`, 'warn');
        }
      }

      // 自适应间隔：临近/到达目标时刻用快查，平时慢查
      const useHot = pickInterval() === pollHotMs;
      if (useHot && !hotAnnounced) {
        hotAnnounced = true;
        log(`进入高频监听（每 ${pollHotMs}ms 查一次）—— 只读本地页面，不发请求`, 'ok');
      }
      // 快查时不要抖动：抖动是为了避免固定节奏被看出规律，
      // 但那种顾虑针对的是网络请求；这里纯粹读本地 DOM，抖一下只是白白丢掉精度。
      await sleep(useHot ? pollHotMs : jitter(pollMs, jitterRatio));
    }

    if (state.stopped && !state.submittedOnce) {
      setPhase('已放弃');
      log('超过放弃时限，脚本结束', 'warn');
      await report({
        outcome: 'FAILED',
        resultCode: 'NO_SIGNAL',
        message: '在放弃时限内未出现可购买状态',
      });
    }
  }

  /** 点击购买之后：走结算流程并回报真实结果 */
  async function handleAfterBuy(config) {
    const dryRun = config.dryRun !== false;

    if (dryRun) {
      setPhase('演练完成');
      log('【演练模式】已点到"购买"为止，不提交订单。确认页面表现正常后再关闭演练。', 'warn');
      await report({
        outcome: 'DRY_RUN_OK',
        resultCode: null,
        message: '演练模式：已成功定位并点击购买按钮，未提交订单',
        evidence: evidencePayload(),
      });
      return;
    }

    // 结算页：填数量（如需要）→ 提交订单
    setPhase('提交订单');
    const submitted = await clickSubmitOrder();
    if (!submitted.ok) {
      setPhase('未找到提交按钮');
      log('未找到"提交订单"按钮。可能已进入收银台，或页面结构与预期不同。', 'warn');
    }

    await sleep(3000);

    // 读真实订单号。读不到就是"结果未知"，绝不编造。
    const orderNo = readOrderNo();
    const priceInfo2 = readPrice();
    const amount = priceInfo2 ? priceInfo2.value : null;
    const payMs = readPayCountdown();
    const ch = detectChallenge();

    if (ch) {
      setPhase('需要人工');
      await report({
        outcome: 'WAITING_HUMAN',
        resultCode: ch,
        message: `提交阶段出现 ${ch}`,
        humanAction: '请手动完成验证并确认订单是否已生成',
        evidence: evidencePayload(),
      });
      return;
    }

    if (!orderNo) {
      setPhase('结果未知');
      log('已尝试提交，但页面上读不到订单号 → 判为"提交结果未知"，不生成任何订单记录。', 'err');
      await report({
        outcome: 'SUBMIT_UNKNOWN',
        resultCode: 'STOCK_UNKNOWN',
        message:
          '已执行提交动作，但页面上未读到平台订单号。请在"我的订单"中核对是否已生成订单，避免重复提交。',
        humanAction: '去华为商城"我的订单"核对；确认无单后再考虑重试',
        amount,
        evidence: evidencePayload(),
      });
      return;
    }

    state.capturedOrderNo = orderNo;
    state.capturedAmount = amount;
    state.capturedPayDeadlineMs = payMs;
    state.orderSubmittedAt = Date.now();

    setPhase('已锁单');
    log(`已取得平台订单号：${orderNo}`, 'ok');
    await report({
      outcome: 'ORDER_PENDING',
      resultCode: 'PAYMENT_NEEDS_USER',
      platformOrderNo: orderNo, // ← 页面上真实读到的，非本地生成
      amount,
      payDeadlineSeconds: payMs != null ? Math.round(payMs / 1000) : null,
      payDeadlineFromPlatform: payMs != null,
      message: payMs
        ? `订单已生成，页面倒计时约 ${Math.round(payMs / 1000)} 秒`
        : '订单已生成，但页面未给出支付倒计时，请人工核对支付时限',
      humanAction: '请前往华为商城完成支付',
      evidence: evidencePayload(),
    });
  }

  /* ============================ 证据 ============================ */

  function evidencePayload() {
    const cfg = state.config || {};
    const ev = { visibleTextLength: visibleText().length };
    if (cfg.evidence?.domText !== false) {
      ev.visibleTextHead = visibleText().slice(0, cfg.evidence?.maxTextChars ?? 6000);
    }
    return ev;
  }

  /* ============================ 等待助手 ============================ */

  function waitFor(pred, timeoutMs, intervalMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (pred()) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, intervalMs);
    });
  }

  /** 异步版 waitFor：判定条件本身是异步的（比如要读会话凭据）。 */
  async function waitForAsync(pred, timeoutMs, intervalMs) {
    const t0 = Date.now();
    while (Date.now() - t0 <= timeoutMs) {
      try { if (await pred()) return true; } catch { /* 判定异常当作未满足 */ }
      await sleep(intervalMs);
    }
    return false;
  }

  function waitUntil(ts) {
    return new Promise((resolve) => {
      const tick = () => {
        if (Date.now() >= ts) return resolve();
        setTimeout(tick, Math.min(5000, Math.max(200, ts - Date.now())));
      };
      tick();
    });
  }

  /* ============================ 菜单 ============================ */

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('重新载入配置并重启', () => location.reload());
    GM_registerMenuCommand('查看本地待发结果', () => {
      const q = GM_getValue('pendingReports', []);
      alert(`待发结果 ${q.length} 条\n\n` + JSON.stringify(q, null, 2).slice(0, 2000));
    });
    GM_registerMenuCommand('清除"本页已点击"标记（谨慎）', () => {
      const key = `clicked:${location.pathname}${location.search}`;
      GM_setValue(key, false);
      alert('已清除。注意：若平台上已有订单，再次点击可能造成重复下单。');
    });
  }

  main().catch(async (e) => {
    // 这里必须再包一层 try：异常处理本身若再抛（比如面板挂载失败），
    // 就会变成"未捕获的 Promise 拒绝"，用户在页面上看不到任何提示，
    // 只看到油猴图标变红叉而无从查起。
    try {
      await waitForBody(3000);
      setPhase('异常');
      log(`脚本异常：${e.message}`, 'err');
      await report({
        outcome: 'FAILED',
        resultCode: 'NETWORK',
        message: `脚本异常：${e.message}`,
      }).catch(() => {});
    } catch (inner) {
      console.error(LOG_PREFIX, '异常处理再次失败:', inner);
      // 最后手段：直接在 documentElement 上留一条肉眼可见的文字
      try {
        const d = document.createElement('div');
        d.style.cssText =
          'position:fixed;left:8px;top:8px;z-index:2147483647;background:#c00;color:#fff;' +
          'font:13px/1.6 monospace;padding:6px 10px;max-width:80vw;';
        d.textContent = `${LOG_PREFIX} 启动失败：${e.message}`;
        (document.body || document.documentElement).appendChild(d);
      } catch (_) {
        /* 连 documentElement 都不可用，只能放弃 */
      }
    }
  });
})();
