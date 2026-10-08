/**
 * 响应结构侦察：把商品详情页捕获到的关键响应逐个体检
 * 只读，输出字段树与样本值，用于决定提取哪些字段。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'grab', 'huawei.config.json'), 'utf8'));

const WATCH = [
  'refreshProductRealInfoV2',
  'refreshSbomRealInfoV3',
  'queryRushbuyInfo',
  'querySkuInventoryV2',
  'batchQueryPrdInstallmentInfo',
  'getShippingTime',
];

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

await page.addInitScript(() => {
  window.__cap = [];
  const isData = (ct) => /json|javascript|text\/plain/i.test(ct || '');
  const rec = (via, url, status, ct, text) => {
    if (!text) return;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { return; }
    window.__cap.push({ via, url, status, ct, bytes: text.length, body: parsed });
  };
  const of = window.fetch;
  window.fetch = async function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : a[0]?.url || '';
    const r = await of.apply(this, a);
    try {
      const ct = r.headers.get('content-type') || '';
      if (isData(ct)) r.clone().text().then((t) => rec('fetch', u, r.status, ct, t)).catch(() => {});
    } catch {}
    return r;
  };
  const OO = XMLHttpRequest.prototype.open, OS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) { this.__u = u; return OO.call(this, m, u, ...rest); };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', function () {
      try {
        const ct = this.getResponseHeader && this.getResponseHeader('content-type');
        if (!isData(ct)) return;
        const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
        rec('xhr', this.__u, this.status, ct, t);
      } catch {}
    });
    return OS.apply(this, a);
  };
});

await page.goto(cfg.target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => window.scrollTo(0, 700));
await page.waitForTimeout(1500);

const caps = await page.evaluate(() => window.__cap || []);

// 字段树打印
function tree(node, prefix = '', depth = 0, maxDepth = 5) {
  const lines = [];
  if (depth > maxDepth) return lines;
  if (Array.isArray(node)) {
    lines.push(`${prefix}[数组 × ${node.length}]`);
    if (node.length) lines.push(...tree(node[0], `${prefix}  [0].`, depth + 1, maxDepth));
    return lines;
  }
  if (node === null || typeof node !== 'object') return lines;
  for (const [k, v] of Object.entries(node)) {
    if (v !== null && typeof v === 'object') {
      const tag = Array.isArray(v) ? `[数组 × ${v.length}]` : '{对象}';
      lines.push(`${prefix}${k} ${tag}`);
      lines.push(...tree(v, `${prefix}  `, depth + 1, maxDepth));
    } else {
      const s = String(v);
      lines.push(`${prefix}${k} = ${s.length > 90 ? s.slice(0, 90) + '…' : s}`);
    }
  }
  return lines;
}

for (const name of WATCH) {
  const hits = caps.filter((c) => c.url.includes(name));
  console.log(`\n${'='.repeat(78)}`);
  console.log(`【${name}】命中 ${hits.length} 条`);
  console.log('='.repeat(78));
  if (!hits.length) {
    console.log('  （未捕获）');
    continue;
  }
  const h = hits[0];
  console.log(`  URL: ${h.url.slice(0, 240)}`);
  console.log(`  ${h.via} ${h.status} ${h.bytes}B`);
  console.log('  字段树:');
  for (const l of tree(h.body, '    ', 0, 6)) console.log(l);
}

await ctx.close();
await browser.close();
