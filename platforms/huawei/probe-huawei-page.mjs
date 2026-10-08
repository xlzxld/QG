/**
 * 华为商品页适配性验证（第二版：直接跑油猴脚本里的真函数）
 *
 * 第一版的教训：探针里自己抄了一份 readPrice，结果油猴脚本改了、探针没改，
 * 「验证通过」验证的其实是旧逻辑。价格逻辑连错三次就是这么漏掉的。
 *
 * 现在改成：从 platforms/huawei/huawei.user.js 里**抽取真实的工具函数与页面识别函数**，
 * 注入到真实页面里执行。验证的就是上线要跑的那份代码。
 *
 * 只读页面、只做判断，不点击、不提交。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT_PATH = path.join(__dirname, 'huawei.user.js');
const CFG_PATH = path.join(ROOT, 'data', 'grab', 'huawei.config.json');

const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const scriptSrc = fs.readFileSync(SCRIPT_PATH, 'utf8');

// 多目标配置：取第一个启用的目标来验证（兼容旧单目标写法）
const _targets = Array.isArray(cfg.targets) ? cfg.targets : [];
const _active =
  _targets.find((t) => t.enabled !== false) || _targets[0] || { url: cfg.target && cfg.target.url };
const URL_ = _active.url;

console.log('='.repeat(74));
console.log('华为商品页适配性验证');
console.log('='.repeat(74));
console.log(`配置里的目标：${_targets.map((t) => `${t.enabled === false ? '[停用]' : '[启用]'}${t.id}`).join('　') || '(无)'}`);
console.log(`本次验证目标：${_active.id || '(未命名)'}`);
console.log(`目标 URL：${URL_}`);
console.log(`标题关键字：${JSON.stringify(_active.titleKeywords || _active.titleKeyword || [])}`);
console.log(`配置规格：${JSON.stringify(_active.specs || cfg.specs || {})}`);
console.log('');

/**
 * 从用户脚本里**按名字抽取**需要验证的纯函数。
 *
 * 为什么不用「按标记切一段」：中间夹着面板、桥接通信等依赖 GM_* 的代码，
 * 整段注入页面会失败。逐个抽取可以精确控制范围。
 */
/** 从 pos 起找到与开括号配对的闭括号，跳过字符串与模板串 */
function matchBracket(src, openPos, open = '{', close = '}') {
  let depth = 0;
  let i = openPos;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error('括号不配平');
}

function extractFunction(src, name) {
  const fnIdx = src.indexOf(`function ${name}(`);
  if (fnIdx !== -1) {
    // function 声明：先配平参数列表，再配平函数体
    const parenOpen = src.indexOf('(', fnIdx);
    const parenClose = matchBracket(src, parenOpen, '(', ')');
    const braceOpen = src.indexOf('{', parenClose);
    const braceClose = matchBracket(src, braceOpen, '{', '}');
    return src.slice(fnIdx, braceClose + 1);
  }

  // const 箭头函数：const name = (...) => { ... }; 或单表达式形式
  const constIdx = src.indexOf(`const ${name} =`);
  if (constIdx === -1) throw new Error(`用户脚本里找不到函数：${name}`);

  const arrowIdx = src.indexOf('=>', constIdx);
  if (arrowIdx === -1) throw new Error(`${name} 不是箭头函数形式`);

  const afterArrow = src.slice(arrowIdx + 2).trimStart();
  if (afterArrow.startsWith('{')) {
    const braceOpen = src.indexOf('{', arrowIdx);
    const braceClose = matchBracket(src, braceOpen, '{', '}');
    let end = braceClose + 1;
    while (end < src.length && src[end] !== ';') end++;
    return src.slice(constIdx, end + 1);
  }

  // 单表达式形式：取到语句结尾分号
  const semi = src.indexOf(';', arrowIdx);
  return src.slice(constIdx, semi + 1);
}

const NEEDED = [
  'clean',
  'visibleText',
  'textOf',
  'isActionable',
  'inRecommend',
  'extractPrdId',
  'normalizeTargets',
  'checkTarget',
  'isLoggedIn',
  'findBuyButton',
  'readStockState',
  'readPrice',
  'readOrderNo',
  'readPayCountdown',
  'detectChallenge',
];

function extractProbeCode(src) {
  const parts = [];
  for (const name of NEEDED) {
    try {
      parts.push(extractFunction(src, name));
    } catch (e) {
      throw new Error(`抽取 ${name} 失败：${e.message}`);
    }
  }
  const code = parts.join('\n\n');

  // 抽出来的代码必须不依赖 GM_* / 运行期状态，否则注入页面会挂
  const forbidden = ['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest', 'state.', 'ensurePanel'];
  for (const f of forbidden) {
    if (code.includes(f)) throw new Error(`抽取到的「${f}」不在纯函数区段内，请把它移出被抽取的函数`);
  }
  return { code, names: NEEDED };
}

const { code: probeCode, names: probedNames } = extractProbeCode(scriptSrc);
console.log(`已从 huawei.user.js 抽取 ${probedNames.length} 个真实函数用于验证：`);
console.log(`  ${probedNames.join(', ')}`);
console.log(`（共 ${probeCode.length} 字符）\n`);

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

let httpStatus = null;
try {
  const resp = await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });
  httpStatus = resp ? resp.status() : null;
} catch (e) {
  console.log(`导航失败: ${e.message.split('\n')[0]}`);
}
await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(1200);

const probe = await page.evaluate(
  ({ code, cfgIn }) => {
    const factory = new Function(
      `${code}
       return {
         clean, visibleText, textOf, isActionable, inRecommend,
         extractPrdId, normalizeTargets, checkTarget, isLoggedIn,
         findBuyButton, readStockState,
         readPrice, readOrderNo, readPayCountdown, detectChallenge
       };`,
    );
    const api = factory();

    const t = api.visibleText();
    const tgt = api.checkTarget(cfgIn);
    const loggedIn = api.isLoggedIn();
    const stock = api.readStockState();

    const BUY = ['立即购买', '立即申购', '加入购物车', '立即预订', '马上抢', '立即抢购'];
    const buyHits = [];
    for (const el of document.querySelectorAll('a,button,div,span')) {
      const tx = api.textOf(el);
      if (!tx || tx.length > 12) continue;
      if (!BUY.some((k) => tx.includes(k))) continue;
      buyHits.push({
        text: tx,
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 60),
        actionable: api.isActionable(el),
      });
    }

    const price = api.readPrice();

    const specResults = [];
    // 规格匹配：用当前验证目标的规格（多目标配置下 specs 在目标里）
    const activeSpecs = cfgIn.__activeSpecs || {};
    for (const [group, value] of Object.entries(activeSpecs)) {
      if (group.startsWith('_') || !value) continue;
      const cands = Array.from(document.querySelectorAll('div,span,a,li,button')).filter((el) => {
        const tx = api.textOf(el);
        return tx === value && tx.length <= 40;
      });
      specResults.push({
        group,
        value,
        found: cands.length,
        actionable: cands.some(api.isActionable),
      });
    }

    return {
      finalUrl: location.href,
      title: api.clean(document.title),
      textLen: t.length,
      tgt,
      loggedIn,
      stock,
      buyHits: buyHits.slice(0, 12),
      actionableBuy: buyHits.find((h) => h.actionable) || null,
      price,
      specResults,
      challenge: api.detectChallenge(),
      orderNo: api.readOrderNo(),
      payMs: api.readPayCountdown(),
    };
  },
  { code: probeCode, cfgIn: { ...cfg, __activeSpecs: _active.specs || cfg.specs || {} } },
);

/* ============================ 输出 ============================ */

const ok = (b) => (b ? '✅' : '❌');
const fmtCands = (list) =>
  (list || [])
    .map((c) => (typeof c === 'object' ? `¥${c.v}(${c.fs}px@y${c.top})` : `¥${c}`))
    .join('  ');

console.log('='.repeat(74));
console.log('华为商品页适配性验证（执行的是 huawei.user.js 内的真实函数）');
console.log('='.repeat(74));
console.log(`HTTP ${httpStatus}`);
console.log(`最终 URL: ${probe.finalUrl}`);
console.log(`页面标题: ${probe.title}`);
console.log(`可见文字: ${probe.textLen} 字`);
console.log('');

console.log('── 目标匹配（多目标）─────────────────────');
console.log(`  配置目标数      : ${probe.tgt.checkedCount}`);
console.log(`  页面 prdId      : ${probe.tgt.pagePrdId || '(未识别)'}`);
if (probe.tgt.ok && probe.tgt.matched) {
  const m = probe.tgt.matched;
  console.log(`  → 匹配到目标    : ${ok(true)} 「${m.id}」`);
  console.log(`    匹配依据      : ${probe.tgt.reason}`);
  console.log(`    该目标规格    : ${JSON.stringify(m.specs)}`);
  console.log(`    该目标价格上限: ${m.maxPrice ?? '不限'}`);
  console.log(`    该目标开售时间: ${m.saleAt || '(未设置)'}`);
  console.log(`    该目标已启用  : ${m.enabled !== false ? '是' : '否（只采集不抢）'}`);
} else {
  console.log(`  → ${ok(false)} 不属于配置里任何目标`);
  console.log(`    原因: ${probe.tgt.reason}`);
  console.log(`    插件行为: 不做任何操作，回报 SKIPPED_NOT_TARGET`);
}
console.log('');

console.log('── 登录态 ────────────────────────────────');
console.log(`  isLoggedIn()   : ${probe.loggedIn ? '已登录' : '未登录'}`);
console.log(`  → 脚本行为      : ${probe.loggedIn ? '继续' : '⚠️ 等待登录（最长 120 秒），超时则回报 WAITING_HUMAN'}`);
console.log('');

console.log('── 库存状态 ──────────────────────────────');
console.log(`  readStockState(): ${probe.stock.state}   证据: ${probe.stock.evidence || '(无)'}`);
console.log('');

console.log('── 购买按钮 ──────────────────────────────');
if (!probe.buyHits.length) {
  console.log('  未找到购买类按钮 —— 与"尚未开售"一致，脚本不会误点');
} else {
  for (const h of probe.buyHits) console.log(`  ${h.actionable ? '🟢可点' : '⚪不可点'}  「${h.text}」  ${h.tag}.${h.cls}`);
  console.log(`  → 脚本会点：${probe.actionableBuy ? `「${probe.actionableBuy.text}」` : '（无可点候选）'}`);
}
console.log('');

console.log('── 价格（真函数 readPrice）───────────────');
if (probe.price.value != null) {
  console.log(`  读到: ¥${probe.price.value}`);
  console.log(`  来源: ${probe.price.source}`);
  if (probe.price.ambiguous && probe.price.sameFontOthers?.length) {
    console.log(`  ⚠️ 同字号另有: ${probe.price.sameFontOthers.map((v) => '¥' + v).join('、')}`);
  }
  const effMax = _active.maxPrice != null ? _active.maxPrice : cfg.maxPrice ?? null;
  if (effMax != null) {
    console.log(`  与上限 ¥${effMax} 比较: ${probe.price.value > effMax ? '❌ 超限，脚本拒绝执行' : '✅ 在限内'}`);
  }
} else {
  console.log(`  ❌ 未读到可信价格：${probe.price.reason || '未知原因'}`);
}
if (probe.price.allCandidates?.length) {
  console.log(`  页面候选: ${fmtCands(probe.price.allCandidates)}`);
}
console.log('');

console.log('── 规格匹配 ──────────────────────────────');
if (!probe.specResults.length) console.log('  （配置未指定规格）');
for (const s of probe.specResults) {
  console.log(`  ${s.found > 0 ? ok(true) : ok(false)} 「${s.group}=${s.value}」 命中 ${s.found} 个  可点=${s.actionable}`);
}
console.log('');

console.log('── 风控 ──────────────────────────────────');
console.log(`  detectChallenge(): ${probe.challenge || '未检出（正常）'}`);
if (probe.challenge === 'NEEDS_LOGIN') {
  console.log('    注：这是"未登录"而非风控。未登录是预期状态（探针没有你的账号），不算问题。');
}
console.log('');

console.log('── 订单号读取（此时应为空）───────────────');
console.log(`  readOrderNo(): ${probe.orderNo || '(空) —— 正确。脚本在读到订单号前绝不回传"成功"'}`);
console.log(`  readPayCountdown(): ${probe.payMs != null ? Math.round(probe.payMs / 1000) + ' 秒' : '(无)'}`);
console.log('');

const problems = [];
if (!probe.tgt.ok) problems.push('页面与配置目标不符');
if (probe.challenge && probe.challenge !== 'NEEDS_LOGIN') problems.push(`检出风控特征：${probe.challenge}`);
if (probe.price.value == null) problems.push(`价格读取失败：${probe.price.reason || '未知'}`);
for (const s of probe.specResults) if (s.found === 0) problems.push(`规格「${s.group}=${s.value}」页面上找不到`);

console.log('='.repeat(74));
if (problems.length) {
  console.log('需要处理：');
  for (const p of problems) console.log(`  · ${p}`);
} else {
  console.log('✅ 页面与脚本预期一致');
}
console.log('');
console.log('说明：未开售时找不到购买按钮是**正常**的，不算问题。');
console.log('      真正需要人工确认的是：登录态 + 开售后按钮能否被识别。');
console.log('='.repeat(74));

await ctx.close();
await browser.close();
