#!/usr/bin/env node
/**
 * grab-probe —— 监控路线技术探针
 * =====================================================================
 * 要回答的唯一问题：
 *   一个持久化的共享浏览器会话，能否在一轮里顺序检查 N 个商品页，
 *   稳定读出「在售 / 售罄 / 未知」，且不被风控页替换掉？
 *
 * 以及一个派生问题：
 *   哪些平台可以退化为纯 HTTP 探测（Monitor 层不占浏览器资源），
 *   哪些必须依赖浏览器渲染？
 *
 * ---------------------------------------------------------------------
 * 本探针的能力边界（设计约束，写在代码里而不是文档里）
 * ---------------------------------------------------------------------
 * 只用**页面渲染结果**判定状态：读的是 document.body.innerText 与可见
 * 元素的文本，也就是普通用户打开这个页面能看到的同一份内容。
 *
 * 本探针**不做**以下事情，且后续扩展也不应做：
 *   1. 不拦截、不枚举、不解析任何 XHR / fetch 的响应体
 *      （page.on('response') 只用于统计与诊断，绝不读取 body）
 *   2. 不逆向签名参数，不构造或重放平台内部接口请求
 *   3. 不处理、不绕过任何验证码或人机校验 —— 遇到即标记 blocked 并跳过
 *   4. 不做代理轮换、不伪造指纹/UA、不在被封后切换环境重试
 *
 * HTTP 退化探测的实现方式：用 javaScriptEnabled:false 的浏览器上下文加载
 * 同一个 URL，得到的就是「一个不带 JS 的普通 HTTP 客户端能拿到的东西」。
 * 这样无需自行构造任何请求即可回答「纯 HTTP 够不够」。
 * =====================================================================
 */

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ============================ CLI ============================ */

const BOOL_FLAGS = new Set(['headed', 'verbose']);

/**
 * 取值优先级：--name=value > --name value > --name(布尔) > fallback
 * 注意：--name value 形式在 pwsh/cmd 下会被拆成两个 argv 元素，必须支持。
 */
function arg(name, fallback) {
  const withEq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq !== undefined) return withEq.slice(name.length + 3);

  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;

  if (BOOL_FLAGS.has(name)) return true;

  const next = process.argv[idx + 1];
  if (next !== undefined && !next.startsWith('--')) return next;

  return true;
}

const OPT = {
  config: arg('config', path.join(__dirname, 'targets.json')),
  headed: Boolean(arg('headed', false)),
  rounds: Number(arg('rounds', 0)) || 0, // 0 = 用配置文件里的
  intervalSec: Number(arg('interval', 0)) || 0,
  httpProbe: arg('http', null), // null = 用配置文件里的；'false' 强制关闭
  doHttpRounds: Number(arg('http-rounds', 1)) || 1,
  only: arg('only', null), // 逗号分隔的 target id 或 platform，便于快速单点验证
  profile: arg('profile', path.join(__dirname, 'chrome-profile')),
  outDir: arg('out', path.join(__dirname, 'output')),
  evidenceDir: arg('evidence', path.join(__dirname, 'evidence')),
  verbose: Boolean(arg('verbose', false)),
  // 从一个种子页发现真实商品页 URL，避免手写 URL 时猜错格式
  findLinks: arg('find-links', null),
  linkFilter: arg('link-filter', null),
  holdSec: Number(arg('hold', 0)) || 0,
};

/* ==================== 页面状态判定规则表 ==================== */
/* 顺序即优先级：风险信号必须先判，避免风控页里恰好出现"立即购买"被误读 */

const RISK_SIGNALS = [
  { label: 'captcha', re: /(验证码|人机验证|滑动验证|安全验证|拖动滑块|请完成验证|点击验证|行为验证)/ },
  {
    label: 'risk_verify',
    re: /(异常流量|访问受限|访问异常|操作过于频繁|请求过于频繁|请稍后再试|请降低访问频率|访问被拒绝|系统检测到|请完成安全验证)/,
  },
  { label: 'ip_block', re: /(您的网络存在异常|网络环境异常|IP 限制|IP限制|IP 封禁|禁止访问|拒绝访问|Access Denied|403 Forbidden)/i },
];

const GATE_SIGNALS = [
  { label: 'login_wall', re: /(请先登录|请登录后|登录后查看|立即登录|账号登录|扫码登录|密码登录|登录即可|欢迎登录|登录页面)/ },
  { label: 'app_wall', re: /(打开APP|打开客户端|前往APP|APP内打开|下载APP|请使用APP)/i },
];

const SOFT_404_SIGNALS = /(页面不存在|找不到页面|商品不存在|商品已下架|该商品已下架|页面已失效|您查看的商品找不到了)/;

/**
 * 「被重定向到分类/导购页」的信号。
 * 与 blocked 不同：它说明目标 URL 无效（商品已下架或 URL 格式不对），而不是被风控拦截。
 * 二者都是失败，但排障方向完全相反，必须分开。
 */
const CATEGORY_PAGE_SIGNALS = /(全部机型|所有机型|机型比较|选购指南|导购指南|各类?\s*产品|产品目录|商品分类|搜索结果)/;
const CATEGORY_URL_SIGNALS = /\/(buy-iphone|buy-ipad|buy-mac|buy-watch|buy-airpods)\/?$/i;

const STOCK_PATTERNS = [
  { state: 'out_of_stock', weight: 10, re: /(已售罄|售罄|已抢光|已抢完|已售完|无货|缺货|暂时缺货|已约满|已满|补货中|到货通知|暂无库存|已下架|已结束|已停售|商品已售空)/ },
  // 注意：「预约」单独出现歧义极大（Apple 官网的「预约到店」是零售店服务预约），只收明确的开售前置语
  { state: 'preorder', weight: 8, re: /(预售|订金|尾款|即将开售|即将开始|还未开始|未开售|等待开售|开售提醒|待开抢|接受预购|开始预购|预约购买|预约抢购)/ },
  { state: 'in_stock', weight: 6, re: /(加入购物车|加入购物袋|立即购买|立即抢购|去抢购|马上抢|立即预订|立即预约|立即下单|现在购买|放入购物车|添加至购物车|已加入购物车)/ },
  { state: 'limited', weight: 4, re: /(仅剩\s*\d+|剩余\s*\d+|库存紧张|仅余\s*\d+|最后\s*\d+\s*件|限购\s*\d+|每人限购)/ },
];

const PRICE_RE = /(?:¥|￥|\$|US\$)\s?[\d,]+(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s*元/g;

/* ==================== 工具函数 ==================== */

const nowIso = () => new Date().toISOString();

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid)';
  }
}

/** 判断两个 URL 是否同源（用于识别被重定向到登录页/风控页） */
function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.protocol === ub.protocol;
  } catch {
    return false;
  }
}

/* ==================== 页面读取与判定 ==================== */

/**
 * 只读渲染结果。返回可用于判定的全部文本与结构化信号。
 * 注意：不读取任何网络响应体。
 */
async function readRenderedState(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };

    // 正文可见文本 —— 等价于用户 Ctrl+A 能看到的东西
    const bodyText = clean(document.body ? document.body.innerText : '').slice(0, 20000);

    // 交互元素文本：按钮/链接/带 role 的可点元素
    const interactive = [];
    for (const el of document.querySelectorAll(
      'button, a, [role="button"], input[type="button"], input[type="submit"], [class*="btn"], [class*="button"]',
    )) {
      if (!isVisible(el)) continue;
      const t = clean(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '');
      if (t && t.length <= 60) interactive.push(t);
    }

    // 结构化数据：平台主动公开给搜索引擎/比价引擎的字段，属于"公开信息"
    const jsonLd = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(s.textContent || 'null');
        if (parsed) jsonLd.push(parsed);
      } catch {
        /* 忽略解析失败 */
      }
    }

    const title = clean(document.title);
    const h1 = clean((document.querySelector('h1') || {}).innerText || '');

    // meta 里常放的库存/价格语义（公开 meta，不是内部接口）
    const metas = {};
    for (const m of document.querySelectorAll('meta[property], meta[name]')) {
      const k = m.getAttribute('property') || m.getAttribute('name');
      const v = m.getAttribute('content');
      if (k && v && /price|availability|stock|product|og:/i.test(k)) metas[k] = clean(v).slice(0, 200);
    }

    return {
      title,
      h1,
      bodyText,
      interactive: [...new Set(interactive)].slice(0, 60),
      jsonLd,
      metas,
      elementCount: document.querySelectorAll('*').length,
      htmlBytes: (document.documentElement.outerHTML || '').length,
    };
  });
}

/**
 * 基于渲染结果做分类。全部规则都是纯文本匹配，无网络行为。
 * @param snapshot 渲染快照
 * @param ctx { requestedUrl, finalUrl, redirected } 用于识别「被重定向到别处」
 */
function classify(snapshot, ctx = {}) {
  const haystack = `${snapshot.title} ${snapshot.h1} ${snapshot.bodyText}`;
  const buttonText = snapshot.interactive.join(' | ');

  const risk = RISK_SIGNALS.find((s) => s.re.test(haystack));
  const gate = GATE_SIGNALS.find((s) => s.re.test(haystack));

  // 库存相关信号：标题+正文+按钮文本一起看
  const stockHay = `${haystack} ${buttonText}`;
  const matched = [];
  for (const p of STOCK_PATTERNS) {
    const m = stockHay.match(p.re);
    if (m) matched.push({ state: p.state, weight: p.weight, evidence: m[0] });
  }
  matched.sort((a, b) => b.weight - a.weight);

  const prices = [...new Set((haystack.match(PRICE_RE) || []).map((s) => s.trim()))].slice(0, 8);

  // JSON-LD 里的 availability 是权威结构化字段
  let ldAvailability = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.availability === 'string') ldAvailability = node.availability;
    if (node.offers) walk(node.offers);
  };
  snapshot.jsonLd.forEach(walk);

  const metaAvailability =
    snapshot.metas['product:availability'] ||
    snapshot.metas['og:availability'] ||
    null;

  // 「被重定向到别处」的判定：
  //   请求的商品 URL 路径深度 >= 2，最终落在更浅的路径上（或落在分类页 URL 上），
  //   且页面缺少商品页应有的价格结构 → 目标 URL 无效（商品下架 / URL 格式错误），
  //   而不是被风控拦截。二者都是失败，但排障方向相反，必须分开。
  const requestedPathDepth = (() => {
    try {
      return new URL(ctx.requestedUrl || '').pathname.split('/').filter(Boolean).length;
    } catch {
      return 0;
    }
  })();
  const finalPath = (() => {
    try {
      return new URL(ctx.finalUrl || '').pathname;
    } catch {
      return '';
    }
  })();
  const finalPathDepth = finalPath.split('/').filter(Boolean).length;
  const looksLikeIndexPage =
    ctx.redirected &&
    requestedPathDepth >= 2 &&
    (CATEGORY_URL_SIGNALS.test(finalPath) || (finalPathDepth < requestedPathDepth && !prices.length));

  // 判定优先级：风险 > 登录墙 > 目标失效 > 软 404 > 库存结论
  // 「目标失效」必须在最前几档，否则会把导购页误当商品页，凭空产出假结论
  let pageState;
  if (risk) pageState = 'blocked';
  else if (gate) pageState = 'gated';
  else if (looksLikeIndexPage) pageState = 'redirected_away';
  else if (CATEGORY_PAGE_SIGNALS.test(snapshot.h1) || CATEGORY_PAGE_SIGNALS.test(snapshot.title))
    pageState = 'redirected_away';
  else if (SOFT_404_SIGNALS.test(haystack) && !matched.some((m) => m.state === 'in_stock'))
    pageState = 'redirected_away';
  else pageState = 'product';

  let stockState = 'unknown';
  let stockEvidence = null;
  if (pageState === 'product') {
    if (matched.length) {
      stockState = matched[0].state;
      stockEvidence = matched[0].evidence;
    } else if (ldAvailability) {
      if (/OutOfStock|SoldOut|Discontinued/i.test(ldAvailability)) stockState = 'out_of_stock';
      else if (/InStock|PreOrder|PreSale|LimitedAvailability/i.test(ldAvailability))
        stockState = /PreOrder|PreSale/i.test(ldAvailability) ? 'preorder' : 'in_stock';
      stockEvidence = `json-ld:${ldAvailability}`;
      pageState = 'product';
    } else if (metaAvailability) {
      stockState = /out|sold/i.test(metaAvailability) ? 'out_of_stock' : 'in_stock';
      stockEvidence = `meta:${metaAvailability}`;
    }
  }

  return {
    pageState,
    riskLabel: risk ? risk.label : null,
    gateLabel: gate ? gate.label : null,
    stockState,
    stockEvidence,
    allMatched: matched,
    prices,
    ldAvailability: ldAvailability || metaAvailability || null,
    buttonSample: snapshot.interactive.slice(0, 12).join(' | '),
    title: snapshot.title,
    h1: snapshot.h1,
    elementCount: snapshot.elementCount,
    htmlBytes: snapshot.htmlBytes,
  };
}

/* ==================== 单次导航与采样 ==================== */

async function probeOnce(context, target, round, opts) {
  const page = await context.newPage();
  const rec = {
    targetId: target.id,
    platform: target.platform,
    kind: target.kind,
    url: target.url,
    host: hostOf(target.url),
    round,
    ts: nowIso(),
    ok: false,
    error: null,
    httpStatus: null,
    finalUrl: null,
    redirected: false,
    crossOriginRedirect: false,
    navMs: null,
    domContentLoadedMs: null,
    loadMs: null,
    subresourceCount: 0,
    requestCount: 0,
    screenshot: null,
  };

  const subresourceHosts = new Set();

  try {
    // 仅用于统计与诊断：绝不读取任何响应体
    page.on('request', () => {
      rec.requestCount += 1;
    });
    page.on('request', (req) => {
      try {
        const h = new URL(req.url()).host;
        if (h !== rec.host) subresourceHosts.add(h);
      } catch {
        /* ignore */
      }
    });

    const t0 = Date.now();
    let response = null;
    try {
      response = await page.goto(target.url, {
        waitUntil: 'domcontentloaded',
        timeout: opts.navTimeoutMs,
      });
    } catch (e) {
      // 超时也可能是页面已渲染，继续尝试读取
      rec.error = `goto: ${e.message.split('\n')[0]}`;
    }
    rec.domContentLoadedMs = Date.now() - t0;
    rec.httpStatus = response ? response.status() : null;

    // 等主文档 load，再给 SPA 一点渲染时间，然后尝试等网络静默
    try {
      await page.waitForLoadState('load', { timeout: 8000 });
    } catch {
      /* ignore */
    }
    rec.loadMs = Date.now() - t0;
    try {
      await page.waitForLoadState('networkidle', { timeout: 6000 });
    } catch {
      /* ignore — 长连接页面本来就不会 idle */
    }
    rec.navMs = Date.now() - t0;
    rec.subresourceCount = subresourceHosts.size;

    rec.finalUrl = page.url();
    rec.redirected = rec.finalUrl.replace(/#.*$/, '') !== target.url.replace(/#.*$/, '');
    rec.crossOriginRedirect = rec.redirected && !sameOrigin(target.url, rec.finalUrl);

    // 滚动一屏，触发懒加载（正常用户行为，不是规避手段）
    await page.evaluate(() => window.scrollTo(0, Math.min(1200, document.body.scrollHeight)));
    await sleep(600 + Math.floor(Math.random() * 400));

    const snapshot = await readRenderedState(page);
    Object.assign(
      rec,
      classify(snapshot, { requestedUrl: target.url, finalUrl: rec.finalUrl, redirected: rec.redirected }),
    );

    if (opts.wantEvidence) {
      const shot = path.join(
        opts.evidenceDir,
        `${target.id}__r${round}__${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      );
      await page.screenshot({ path: shot, fullPage: false });
      rec.screenshot = path.relative(opts.outDir, shot);
      await writeFile(
        path.join(opts.evidenceDir, `${target.id}__r${round}.txt`),
        [
          `URL: ${target.url}`,
          `FINAL: ${rec.finalUrl}`,
          `HTTP: ${rec.httpStatus}`,
          `pageState: ${rec.pageState} / stockState: ${rec.stockState} / evidence: ${rec.stockEvidence}`,
          `risk: ${rec.riskLabel} / gate: ${rec.gateLabel}`,
          `prices: ${JSON.stringify(rec.prices)}`,
          `buttons: ${rec.buttonSample}`,
          '',
          '--- 可见正文前 3000 字 ---',
          snapshot.bodyText.slice(0, 3000),
        ].join('\n'),
        'utf8',
      );
    }

    rec.ok = rec.pageState === 'product' && rec.stockState !== 'unknown';
  } catch (e) {
    rec.error = rec.error || e.message.split('\n')[0];
    if (rec.pageState === undefined) {
      rec.pageState = 'error';
      rec.stockState = 'unknown';
    }
  } finally {
    await page.close().catch(() => {});
  }

  return rec;
}

/* ==================== 纯 HTTP 退化探测 ==================== */

/**
 * 用禁用 JS 的上下文加载同一 URL：得到的就是"纯 HTTP 客户端能拿到的东西"。
 * 不需要自行构造任何请求，因此不触碰任何内部接口。
 */
async function probeHttpOnly(browser, target, opts) {
  const ctx = await browser.newContext({
    javaScriptEnabled: false,
    userAgent: opts.userAgent,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await ctx.newPage();
  const rec = {
    targetId: target.id,
    platform: target.platform,
    url: target.url,
    httpStatus: null,
    finalUrl: null,
    ms: null,
    bytes: 0,
    pageState: 'error',
    stockState: 'unknown',
    stockEvidence: null,
    error: null,
  };
  try {
    const t0 = Date.now();
    let resp = null;
    try {
      resp = await page.goto(target.url, {
        waitUntil: 'domcontentloaded',
        timeout: opts.navTimeoutMs,
      });
    } catch (e) {
      rec.error = e.message.split('\n')[0];
    }
    rec.ms = Date.now() - t0;
    rec.httpStatus = resp ? resp.status() : null;
    rec.finalUrl = page.url();

    const snap = await readRenderedState(page);
    rec.bytes = snap.htmlBytes;
    const cls = classify(snap, {
      requestedUrl: target.url,
      finalUrl: rec.finalUrl,
      redirected: rec.finalUrl !== target.url,
    });
    rec.pageState = cls.pageState;
    rec.stockState = cls.stockState;
    rec.stockEvidence = cls.stockEvidence;
    rec.title = cls.title;
  } catch (e) {
    rec.error = e.message.split('\n')[0];
  } finally {
    await ctx.close().catch(() => {});
  }
  return rec;
}

/* ==================== 链接发现模式 ==================== */

/**
 * 从一个种子页出发，列出页面上真实存在的链接。
 * 用途：手写商品 URL 很容易猜错（商品下架 / 路径格式变化），
 * 从渲染出的链接里取真实 URL 比靠记忆可靠。
 * 只读 <a href>，不构造任何请求。
 */
async function findLinks(context, seedUrl, filter, navTimeoutMs) {
  const page = await context.newPage();
  try {
    await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }).catch(() => {});
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, Math.min(2000, document.body.scrollHeight)));
    await sleep(800);

    const links = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        if (!href || href.startsWith('javascript:')) continue;
        const text = clean(a.innerText || a.getAttribute('aria-label') || '').slice(0, 80);
        out.push({ href, text });
      }
      return out;
    });

    const seen = new Set();
    const filtered = links.filter((l) => {
      if (filter && !new RegExp(filter, 'i').test(l.href)) return false;
      if (seen.has(l.href)) return false;
      seen.add(l.href);
      return true;
    });

    console.log(`种子页: ${seedUrl}`);
    console.log(`页面标题: ${await page.title()}`);
    console.log(`匹配链接: ${filtered.length} / 页面总链接 ${links.length}`);
    console.log('');
    for (const l of filtered.slice(0, 120)) {
      console.log(`  ${l.href}`);
      if (l.text) console.log(`      「${l.text}」`);
    }

    const outFile = path.join(OPT.outDir, 'discovered-links.json');
    await writeFile(
      outFile,
      JSON.stringify({ seedUrl, filter, count: filtered.length, links: filtered }, null, 2),
      'utf8',
    );
    console.log(`\n已写出: ${outFile}`);

    // 保持窗口打开，供人工完成登录；登录态会写入持久 profile
    if (OPT.holdSec > 0) {
      console.log('');
      console.log('='.repeat(60));
      console.log(`请在弹出的浏览器窗口中完成登录（扫码或账号密码）。`);
      console.log(`窗口会保持打开 ${OPT.holdSec} 秒，登录态将保存到: ${OPT.profile}`);
      console.log('='.repeat(60));
      for (let left = OPT.holdSec; left > 0; left -= 20) {
        console.log(`  剩余 ${left}s ...`);
        await sleep(20000);
      }
      console.log('  保持结束，正在保存 profile ...');
    }

    return filtered;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ==================== 主流程 ==================== */

async function main() {
  for (const d of [OPT.outDir, OPT.evidenceDir]) {
    if (!existsSync(d)) await mkdir(d, { recursive: true });
  }

  // 链接发现 / 登录模式：不需要目标清单，也不进入探测循环
  if (OPT.findLinks) {
    const userAgentEarly =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    console.log('='.repeat(72));
    console.log(OPT.holdSec > 0 ? 'grab-probe 登录 / 链接发现模式' : 'grab-probe 链接发现模式');
    console.log('='.repeat(72));
    const ctx = await chromium.launchPersistentContext(OPT.profile, {
      headless: !OPT.headed,
      channel: 'chromium',
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: userAgentEarly,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    try {
      await findLinks(ctx, String(OPT.findLinks), OPT.linkFilter, 30000);
    } finally {
      await ctx.close().catch(() => {});
    }
    return;
  }

  const cfg = JSON.parse(await readFile(OPT.config, 'utf8'));
  const d = cfg.defaults || {};
  const rounds = OPT.rounds || d.rounds || 3;
  const intervalSec = OPT.intervalSec || d.intervalSec || 8;
  const navTimeoutMs = d.navTimeoutMs || 30000;
  const httpProbe =
    OPT.httpProbe === null ? d.httpProbe !== false : OPT.httpProbe !== 'false' && OPT.httpProbe !== false;

  let targets = cfg.targets || [];
  if (OPT.only) {
    const keys = String(OPT.only)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    targets = targets.filter(
      (t) => keys.includes(t.id.toLowerCase()) || keys.includes(String(t.platform).toLowerCase()),
    );
  }
  if (!targets.length) {
    console.error('没有可探测的目标。检查 --only 过滤条件或 targets.json。');
    process.exit(2);
  }

  const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

  console.log('='.repeat(72));
  console.log('grab-probe 监控路线技术探针');
  console.log('='.repeat(72));
  console.log(`目标数        : ${targets.length}`);
  console.log(`渲染轮次      : ${rounds}（间隔 ${intervalSec}s，使用同一个持久会话）`);
  console.log(`HTTP 退化探测 : ${httpProbe ? '开启' : '关闭'}`);
  console.log(`浏览器模式    : ${OPT.headed ? 'headed（可人工登录）' : 'headless'}`);
  console.log(`Profile 目录  : ${OPT.profile}`);
  console.log(`输出目录      : ${OPT.outDir}`);
  console.log('');

  // 关键：单一持久化上下文，全部目标与轮次共用 —— 这正是待验证的假设
  const context = await chromium.launchPersistentContext(OPT.profile, {
    headless: !OPT.headed,
    channel: 'chromium', // 用完整 Chromium 而非 headless shell，与真实浏览器同构
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const rows = [];
  const httpRows = [];

  try {
    // 链接发现模式：从种子页取出真实商品 URL 后即可退出
    if (OPT.findLinks) {
      await findLinks(context, String(OPT.findLinks), OPT.linkFilter, navTimeoutMs);
      return;
    }

    for (let round = 1; round <= rounds; round += 1) {
      console.log(`\n───────── 第 ${round}/${rounds} 轮 ─────────`);
      for (const target of targets) {
        const wantEvidence = round === 1 || round === rounds;
        const rec = await probeOnce(context, target, round, {
          navTimeoutMs,
          evidenceDir: OPT.evidenceDir,
          outDir: OPT.outDir,
          wantEvidence,
          userAgent,
        });
        rows.push(rec);

        const mark =
          rec.pageState === 'product' && rec.stockState !== 'unknown'
            ? 'OK  '
            : rec.pageState === 'blocked'
              ? 'BLK '
              : rec.pageState === 'gated'
                ? 'GATE'
                : rec.pageState === 'redirected_away'
                  ? 'BADU'
                  : 'MISS';
        console.log(
          `  [${mark}] ${rec.targetId.padEnd(20)} ${String(rec.navMs ?? '-').padStart(6)}ms  ` +
            `http=${String(rec.httpStatus ?? '-').padStart(3)}  ` +
            `page=${rec.pageState.padEnd(15)} stock=${(rec.stockState || 'unknown').padEnd(13)}` +
            `${rec.stockEvidence ? ` ← "${String(rec.stockEvidence).slice(0, 28)}"` : ''}` +
            `${rec.riskLabel ? ` RISK=${rec.riskLabel}` : ''}` +
            `${rec.redirected ? ` →${rec.finalUrl.slice(0, 55)}` : ''}` +
            `${rec.error ? ` err=${rec.error.slice(0, 60)}` : ''}`,
        );

        if (OPT.verbose && rec.allMatched?.length) {
          console.log(`         命中: ${rec.allMatched.map((m) => `${m.state}("${m.evidence}")`).join(', ')}`);
          console.log(`         价格: ${rec.prices.join(', ') || '未提取到'}`);
        }

        await sleep(intervalSec * 1000 * (0.7 + Math.random() * 0.6));
      }
    }

    if (httpProbe) {
      console.log('\n───────── 纯 HTTP 退化探测（禁用 JS 的普通客户端视角）─────────');
      for (const target of targets) {
        for (let i = 1; i <= OPT.doHttpRounds; i += 1) {
          const rec = await probeHttpOnly(context.browser(), target, { navTimeoutMs, userAgent });
          rec.round = i;
          httpRows.push(rec);
          console.log(
            `  [${rec.stockState === 'unknown' ? 'MISS' : 'OK  '}] ${rec.targetId.padEnd(20)} ` +
              `${String(rec.ms ?? '-').padStart(6)}ms  http=${String(rec.httpStatus ?? '-').padStart(3)}  ` +
              `page=${rec.pageState.padEnd(9)} stock=${(rec.stockState || 'unknown').padEnd(13)} ` +
              `bytes=${rec.bytes}${rec.error ? ` err=${rec.error.slice(0, 50)}` : ''}`,
          );
          await sleep(1500);
        }
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  /* ---------------- 分析：回答探针的核心问题 ---------------- */

  const byPlatform = new Map();
  for (const r of rows) {
    if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
    byPlatform.get(r.platform).push(r);
  }

  const analysis = [];
  for (const [platform, rs] of byPlatform) {
    const idSet = new Set(rs.map((r) => r.targetId));
    const httpr = httpRows.filter((h) => h.platform === platform);
    const httpByIdMap = new Map(httpr.map((h) => [h.targetId, h]));

    let decidableIds = 0;
    let stableIds = 0;
    let blockedIds = 0;
    let invalidTargetIds = 0;
    let gatedIds = 0;
    const httpDecidableIds = [];
    const perUrl = [];

    for (const id of idSet) {
      const urlRuns = rs.filter((r) => r.targetId === id);
      const decidable = urlRuns.filter((r) => r.pageState === 'product' && r.stockState !== 'unknown');
      const states = new Set(decidable.map((r) => r.stockState));
      const blocked = urlRuns.some((r) => r.pageState === 'blocked');
      const invalid = urlRuns.some((r) => r.pageState === 'redirected_away');
      const gated = urlRuns.some((r) => r.pageState === 'gated');

      if (decidable.length) decidableIds += 1;
      if (blocked) blockedIds += 1;
      if (invalid) invalidTargetIds += 1;
      if (gated) gatedIds += 1;
      if (decidable.length === urlRuns.length && states.size === 1) stableIds += 1;

      const httpRec = httpByIdMap.get(id);
      const httpDecidable = Boolean(httpRec && httpRec.stockState !== 'unknown');
      if (httpDecidable) httpDecidableIds.push(id);

      perUrl.push({
        id,
        requestedUrl: urlRuns[0]?.url,
        finalUrl: urlRuns[0]?.finalUrl,
        renderedStock: [...states].join('/') || 'unknown',
        renderedDecidable: decidable.length > 0,
        renderedStable: decidable.length === urlRuns.length && states.size === 1,
        blocked,
        invalidTarget: invalid,
        gated,
        httpStock: httpRec ? httpRec.stockState : 'n/a',
        httpStatus: httpRec ? httpRec.httpStatus : null,
        httpBytes: httpRec ? httpRec.bytes : null,
        medianMs: median(urlRuns.map((r) => r.navMs).filter(Boolean)),
      });
    }

    const lat = rs.map((r) => r.navMs).filter(Boolean);

    // 判定监控实现路线
    let verdict;
    if (blockedIds) {
      verdict = '需人工介入';
    } else if (gatedIds === idSet.size) {
      verdict = '需登录态';
    } else if (invalidTargetIds === idSet.size) {
      verdict = '目标 URL 无效';
    } else if (decidableIds === 0) {
      verdict = '渲染路线失败';
    } else if (stableIds === idSet.size && httpDecidableIds.length === idSet.size && lat.length && median(lat) < 5000) {
      verdict = '可纯 HTTP';
    } else if (stableIds === idSet.size) {
      verdict = '需共享浏览器会话';
    } else {
      verdict = '需进一步验证';
    }

    analysis.push({
      platform,
      targetCount: idSet.size,
      roundCount: rounds,
      decidableCount: decidableIds,
      stableCount: stableIds,
      blockedCount: blockedIds,
      invalidTargetCount: invalidTargetIds,
      gatedCount: gatedIds,
      medianMs: median(lat),
      p95Ms: percentile(lat, 0.95),
      httpDecidableCount: httpDecidableIds.length,
      verdict,
      perUrl,
    });
  }

  /* ---------------- 落盘 ---------------- */

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const renderHeader = [
    'targetId', 'platform', 'kind', 'round', 'ts', 'ok', 'pageState', 'stockState',
    'stockEvidence', 'riskLabel', 'gateLabel', 'httpStatus', 'navMs', 'domContentLoadedMs',
    'loadMs', 'crossOriginRedirect', 'finalUrl', 'prices', 'buttonSample', 'error',
  ];
  const renderCsv = [
    renderHeader.join(','),
    ...rows.map((r) =>
      [
        r.targetId, r.platform, r.kind, r.round, r.ts, r.ok, r.pageState, r.stockState,
        r.stockEvidence, r.riskLabel, r.gateLabel, r.httpStatus, r.navMs, r.domContentLoadedMs,
        r.loadMs, r.crossOriginRedirect, r.finalUrl, (r.prices || []).join(' '), r.buttonSample, r.error,
      ]
        .map(csvCell)
        .join(','),
    ),
  ].join('\r\n');

  const httpHeader = ['targetId', 'platform', 'round', 'httpStatus', 'ms', 'bytes', 'pageState', 'stockState', 'stockEvidence', 'title', 'error'];
  const httpCsv = [
    httpHeader.join(','),
    ...httpRows.map((r) =>
      [r.targetId, r.platform, r.round, r.httpStatus, r.ms, r.bytes, r.pageState, r.stockState, r.stockEvidence, r.title, r.error]
        .map(csvCell)
        .join(','),
    ),
  ].join('\r\n');

  const jsonOut = {
    generatedAt: nowIso(),
    options: {
      rounds,
      intervalSec,
      navTimeoutMs,
      httpProbe,
      headed: OPT.headed,
      sharedSession: true,
    },
    analysis,
    rendered: rows,
    httpOnly: httpRows,
  };

  await writeFile(path.join(OPT.outDir, `rendered-${stamp}.csv`), '\ufeff' + renderCsv, 'utf8');
  await writeFile(path.join(OPT.outDir, `http-only-${stamp}.csv`), '\ufeff' + httpCsv, 'utf8');
  await writeFile(path.join(OPT.outDir, `probe-${stamp}.json`), JSON.stringify(jsonOut, null, 2), 'utf8');
  await writeFile(path.join(OPT.outDir, 'probe-latest.json'), JSON.stringify(jsonOut, null, 2), 'utf8');

  /* ---------------- 控制台结论 ---------------- */

  console.log(`\n${'='.repeat(72)}`);
  console.log('结论');
  console.log('='.repeat(72));
  console.log(
    'platform'.padEnd(12) +
      'URL'.padStart(5) +
      '可判定'.padStart(8) +
      '稳定'.padStart(6) +
      '拦截'.padStart(6) +
      '需登录'.padStart(8) +
      'URL失效'.padStart(9) +
      'HTTP可判定'.padStart(11) +
      '中位耗时'.padStart(10) +
      '  判定',
  );
  for (const a of analysis) {
    console.log(
      a.platform.padEnd(12) +
        String(a.targetCount).padStart(5) +
        String(a.decidableCount).padStart(8) +
        String(a.stableCount).padStart(6) +
        String(a.blockedCount).padStart(6) +
        String(a.gatedCount).padStart(8) +
        String(a.invalidTargetCount).padStart(9) +
        String(a.httpDecidableCount).padStart(11) +
        `${a.medianMs ?? '-'}ms`.padStart(10) +
        `  ${a.verdict}`,
    );
  }

  const totalMs = (analysis.reduce((s, a) => s + (a.medianMs || 0) * a.targetCount, 0));
  console.log('');
  console.log(`共享会话一轮全量检查估算耗时: ${totalMs}ms（中位数口径）`);
  console.log(`输出: ${OPT.outDir}`);
  console.log(`证据: ${OPT.evidenceDir}`);

  const blockedAny = analysis.filter((a) => a.blockedCount > 0);
  if (blockedAny.length) {
    console.log('');
    console.log('⚠ 以下平台在探测中出现风控/验证迹象，按设计不做任何规避，请人工查看证据截图:');
    for (const a of blockedAny) console.log(`   - ${a.platform} (${a.blockedCount}/${a.targetCount})`);
  }

  const invalidAny = analysis.filter((a) => a.invalidTargetCount > 0);
  if (invalidAny.length) {
    console.log('');
    console.log('⚠ 以下平台存在「目标 URL 无效」——请求的商品页被重定向到分类/导购页:');
    for (const a of invalidAny) {
      const bad = a.perUrl.filter((u) => u.invalidTarget);
      for (const u of bad) console.log(`   - ${u.id}: ${u.requestedUrl}\n     → 实际落在 ${u.finalUrl}`);
      console.log('     这不是风控，是 URL 过期或格式不对。要先修 URL，否则结论无效。');
    }
  }

  const gatedAny = analysis.filter((a) => a.gatedCount > 0);
  if (gatedAny.length) {
    console.log('');
    console.log('⚠ 以下平台需要登录态。用 --headed 手动登录一次，登录态会存入 profile 供后续复用:');
    for (const a of gatedAny) console.log(`   - ${a.platform} (${a.gatedCount}/${a.targetCount})`);
  }
}

main().catch((e) => {
  console.error('\n探针异常终止:', e);
  process.exit(1);
});
