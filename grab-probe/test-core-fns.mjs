/**
 * 核心函数抽取测试（只读）
 * =====================================================================
 * 目的：不依赖登录态，直接从 huawei.user.js 里抽出真正的函数执行，
 *       验证「SKU 识别 / 商品匹配 / 价格顺序」三件核心逻辑是对的。
 *
 * 做法：在真实商品页上注入页面数据，手动构造一个最小 DOM，
 *       然后调用脚本里的真实函数（不是抄一份副本）。
 *
 * 用法：node grab-probe/test-core-fns.mjs
 * =====================================================================
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const src = readFileSync(join(ROOT, 'grab/huawei.user.js'), 'utf8')
  .replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');

const TARGET = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

/** 抽出一个具名函数的源码（按大括号配平） */
function grabFn(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`找不到函数 ${name}`);
  let depth = 0;
  let started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`函数 ${name} 括号不配平`);
}

const FNS = ['extractPrdId', 'normalizeTargets', 'checkTarget', 'readSbomInfo', 'curSbomCode', 'switchToSbom'];
const bundle = FNS.map((n) => grabFn(n)).join('\n\n');

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

// 注入真实函数 + 一个读取配置的桥
await page.exposeFunction('__getConfig', async () => {
  const r = await fetch('http://127.0.0.1:3100/api/config/huawei');
  return r.json();
});

const result = await page.evaluate(`
(async () => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visibleText = () => clean(document.body ? document.body.innerText : '');
  const log = () => {};

  ${bundle}

  const CFG = await window.__getConfig();
  const out = { steps: [] };

  // 1) 商品匹配
  const t = checkTarget(CFG);
  out.steps.push({ step: '商品匹配', ok: t.ok, reason: t.reason, matchedId: t.matched && t.matched.id, pagePrdId: t.pagePrdId });

  // 2) 配置解析：不要关键字了，目标是 sbomCodes
  const tg = normalizeTargets(CFG);
  out.steps.push({ step: '配置解析', products: tg.length, hasKeywords: tg.some((x) => 'titleKeywords' in x), sbomCodes: tg[0] && tg[0].sbomCodes });

  // 3) 当前页面 sbomCode
  const onPage = curSbomCode();
  out.steps.push({ step: '当前页 sbomCode', value: onPage });

  // 4) 读目标 SKU 的真实信息
  const want = tg[0] && tg[0].sbomCodes && tg[0].sbomCodes[0];
  if (want) {
    const info = readSbomInfo(want);
    out.steps.push({ step: '读目标 SKU', sbomCode: want, info });
  }

  // 5) 读一个别的 SKU 做对照（验证不会认错）
  const other = readSbomInfo('2601010640929');
  out.steps.push({ step: '对照另一个 SKU', sbomCode: '2601010640929', label: other && other.label, price: other && other.price, buttonMode: other && other.buttonMode });

  // 6) 读不存在的 SKU 应返回 null，不能瞎编
  const bad = readSbomInfo('9999999999999');
  out.steps.push({ step: '不存在的 SKU', result: bad === null ? 'null（正确）' : JSON.stringify(bad) });

  // 7) 验证「页面 SKU 数」与配置一致
  let skuCount = null;
  try {
    const pp = JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps;
    skuCount = Object.keys(pp.mainData.current.base || {}).length;
  } catch (e) {}
  out.steps.push({ step: '页面 SKU 总数', value: skuCount });

  return out;
})()
`);

const f = join(__dirname, 'output/core-fns.json');
mkdirSync(join(__dirname, 'output'), { recursive: true });
writeFileSync(f, JSON.stringify(result, null, 2));

console.log('\n=== 核心函数测试结果 ===');
for (const s of result.steps) {
  console.log('\n[' + s.step + ']');
  for (const [k, v] of Object.entries(s)) {
    if (k === 'step') continue;
    console.log('   ' + k + ' = ' + (typeof v === 'object' ? JSON.stringify(v, null, 2).replace(/\n/g, '\n   ') : v));
  }
}
console.log('\n落盘:', f);
await browser.close();