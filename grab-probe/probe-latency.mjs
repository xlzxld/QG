/**
 * 点击路径耗时探测（只读，不点击任何东西）
 * =====================================================================
 * 目的：回答一个具体问题 —— 「点击」这条路的响应延迟到底有多少？
 *
 * 为什么测这个：
 *   用户觉得"点击太慢、想改成调接口"。但换路线之前应该先搞清楚
 *   当前的时间到底花在哪 —— 很可能瓶颈根本不在"点击"这个动作上，
 *   而在**轮询间隔**（配置里默认 3000ms）。
 *
 * 如果轮询间隔就吃掉 1.5 秒（平均），那省下点击那几十毫秒毫无意义。
 *
 * 测什么（全部在真实商品页上跑，只读）：
 *   1. DOM 规模（影响遍历成本）
 *   2. visibleText()        —— 全页 innerText，会触发布局计算
 *   3. findBuyButton()      —— 遍历所有 a/button/div/span
 *   4. readStockState()     —— 上面两个的组合
 *   5. 不同轮询间隔下的「平均发现延迟」
 *
 * 用法：node grab-probe/probe-latency.mjs [url]
 * =====================================================================
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const src = readFileSync(join(ROOT, 'grab/huawei.user.js'), 'utf8');

const TARGET =
  process.argv[2] ||
  'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

/** 抽取一个具名定义（支持 function 声明与 const 箭头函数两种形式） */
function grabDef(name) {
  // 形式一：function name(...) { ... }
  let i = src.indexOf(`function ${name}(`);
  if (i >= 0) {
    let depth = 0;
    let started = false;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') { depth++; started = true; }
      else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
    }
    throw new Error(`${name} 括号不配平`);
  }

  // 形式二：const name = ...;   （一行到分号结束）
  i = src.indexOf(`const ${name} =`);
  if (i >= 0) {
    const end = src.indexOf(';', i);
    if (end > 0) return src.slice(i, end + 1);
  }

  throw new Error(`找不到 ${name}`);
}

const FNS = ['clean', 'textOf', 'isActionable', 'findBuyButton', 'visibleText', 'readStockState'];
const bundle = FNS.map(grabDef).join('\n\n');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

console.log('打开', TARGET);
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(4000);

const result = await page.evaluate(`
(() => {
  ${bundle}

  const stat = (arr) => {
    const a = arr.slice().sort((x, y) => x - y);
    const p = (q) => a[Math.min(a.length - 1, Math.floor(a.length * q))];
    return {
      n: a.length,
      最小: +a[0].toFixed(2),
      p50: +p(0.5).toFixed(2),
      p95: +p(0.95).toFixed(2),
      最大: +a[a.length - 1].toFixed(2),
      均值: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2),
    };
  };

  const N = 30;
  const out = {};

  // 1) DOM 规模
  const all = document.querySelectorAll('a,button,div,span');
  out.dom = {
    遍历元素数: all.length,
    全页元素数: document.querySelectorAll('*').length,
    页面文本长度: clean(document.body.innerText).length,
  };

  // 2) 各函数的单次耗时
  const tVisible = [];
  const tFind = [];
  const tStock = [];

  // 预热
  for (let i = 0; i < 3; i++) { visibleText(); findBuyButton(); readStockState(); }

  for (let i = 0; i < N; i++) {
    let t0 = performance.now();
    visibleText();
    let t1 = performance.now();
    tVisible.push(t1 - t0);

    t0 = performance.now();
    findBuyButton();
    t1 = performance.now();
    tFind.push(t1 - t0);

    t0 = performance.now();
    readStockState();
    t1 = performance.now();
    tStock.push(t1 - t0);
  }

  out.单次耗时ms = {
    'visibleText() 全页文本': stat(tVisible),
    'findBuyButton() 找按钮': stat(tFind),
    'readStockState() 判状态': stat(tStock),
  };

  // 3) 一轮检测的总开销
  const tRound = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    detectChallengeStub();
    readStockState();
    tRound.push(performance.now() - t0);
  }
  function detectChallengeStub() {
    const t = document.body ? document.body.innerText : '';
    /安全验证|滑动验证|人机验证/.test(t);
  }
  out.一轮检测总耗时ms = stat(tRound);

  // 4) 当前状态
  const st = readStockState();
  out.当前页面状态 = { state: st.state, evidence: st.evidence };
  out.按钮情况 = (() => {
    const b = findBuyButton();
    return { 命中数: b.all.length, 可点: b.actionable ? textOf(b.actionable) : null };
  })();

  return out;
})()
`);

/* ── 算「平均发现延迟」 ── */
const roundMs = result['一轮检测总耗时ms'].均值;
const roundMax = result['一轮检测总耗时ms'].最大;

/**
 * 开售瞬间按钮变为可点。
 * 脚本每 pollMs 毫秒检查一次，所以在 [0, pollMs] 之间均匀分布地发现它。
 * 平均等待 = pollMs / 2，最坏 = pollMs。
 * 实际还要加上这一轮检测本身的开销。
 */
const scenarios = [
  { 间隔: 3000, 说明: '当前配置（pollIntervalMs=3000）' },
  { 间隔: 1000, 说明: '保守提速' },
  { 间隔: 300, 说明: '开售窗口激进值' },
  { 间隔: 150, 说明: '极限值（DOM 检测开销占比开始明显）' },
  { 间隔: 50, 说明: '不建议（检测开销本身成为瓶颈）' },
];

const latency = scenarios.map((s) => ({
  '轮询间隔ms': s.间隔,
  说明: s.说明,
  '平均发现延迟ms': Math.round(s.间隔 / 2 + roundMs),
  '最坏延迟ms': Math.round(s.间隔 + roundMax),
}));

const out = {
  probedAt: new Date().toISOString(),
  target: TARGET,
  ...result,
  '不同轮询间隔的发现延迟': latency,
  '结论提示':
    `一轮检测本身只花 ${roundMs}ms。所以延迟几乎完全由轮询间隔决定：` +
    `把间隔从 3000ms 降到 150ms，平均发现延迟从 ${Math.round(3000 / 2 + roundMs)}ms 降到 ${Math.round(150 / 2 + roundMs)}ms —— ` +
    `省下约 ${Math.round((3000 - 150) / 2)}ms，比"点击 vs 接口"的差异大一个数量级。`,
};

mkdirSync(join(__dirname, 'output'), { recursive: true });
const f = join(__dirname, 'output/latency.json');
writeFileSync(f, JSON.stringify(out, null, 2));

console.log('\n=== DOM 规模 ===');
for (const [k, v] of Object.entries(result.dom)) console.log('  ', k, '=', v);
console.log('\n=== 单次耗时（ms）===');
for (const [k, v] of Object.entries(result['单次耗时ms'])) {
  console.log('  ', k.padEnd(24), 'p50=' + String(v.p50).padStart(6), 'p95=' + String(v.p95).padStart(6), 'max=' + String(v.最大).padStart(6));
}
console.log('\n一轮检测总耗时:', JSON.stringify(result['一轮检测总耗时ms']));
console.log('\n=== 当前页面状态 ===', JSON.stringify(result.当前页面状态), '| 按钮:', JSON.stringify(result.按钮情况));
console.log('\n=== 不同轮询间隔下的发现延迟 ===');
for (const l of latency) {
  console.log(`   间隔 ${String(l['轮询间隔ms']).padStart(5)}ms → 平均发现 ${String(l['平均发现延迟ms']).padStart(5)}ms  最坏 ${String(l['最坏延迟ms']).padStart(5)}ms   ${l.说明}`);
}
console.log('\n' + out['结论提示']);
console.log('\n落盘:', f);

await browser.close();
