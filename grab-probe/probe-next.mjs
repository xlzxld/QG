/**
 * __NEXT_DATA__ 深挖探针（只读）
 * =====================================================================
 * 目的：定位 SKU 规格表（sbomCode ↔ 颜色/版本 ↔ 价格 ↔ 库存）
 *      与「延长宝 / 保障服务」附加项的确切 JSON 路径。
 *
 * 用法：node grab-probe/probe-next.mjs [url]
 * =====================================================================
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET =
  process.argv[2] ||
  'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(4500);

const r = await page.evaluate(() => {
  const el = document.getElementById('__NEXT_DATA__');
  if (!el) return { error: 'no __NEXT_DATA__' };
  const data = JSON.parse(el.textContent);

  // 1. 打印顶层骨架（各层数组长度）
  const skeleton = {};
  const brief = (n, d = 0) => {
    if (d > 3) return typeof n;
    if (Array.isArray(n)) return `Array(${n.length})` + (n.length && d < 3 ? ' → ' + brief(n[0], d + 1) : '');
    if (n && typeof n === 'object') {
      const ks = Object.keys(n);
      return `{${ks.slice(0, 14).join(',')}}` + (ks.length && d < 3 ? ' | first: ' + brief(n[ks[0]], d + 1) : '');
    }
    return typeof n;
  };
  const walk = (n, p = '', d = 0, out = []) => {
    if (d > 4 || n === null || typeof n !== 'object') return out;
    if (Array.isArray(n)) {
      out.push({ path: p, shape: `Array(${n.length})`, sample: n.length ? brief(n[0], 0) : null });
      if (n.length) walk(n[0], p + '[0]', d + 1, out);
      return out;
    }
    out.push({ path: p || '$', shape: `Object(${Object.keys(n).length})`, keys: Object.keys(n) });
    for (const k of Object.keys(n)) walk(n[k], (p ? p + '.' : '') + k, d + 1, out);
    return out;
  };
  skeleton.tree = walk(data).slice(0, 200);

  // 2. 全树搜索：找含 sbomCode 的对象
  const skuObjects = [];
  const seenPath = new Set();
  const scan = (n, p = '', d = 0) => {
    if (d > 20 || n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((v, i) => scan(v, `${p}[${i}]`, d + 1));
    const ks = Object.keys(n);
    const hasSbom = ks.some((k) => /sbomCode|skuCode/i.test(k));
    if (hasSbom) {
      const key = ks.filter((k) => /sbomCode|skuCode/i.test(k)).join(',');
      if (!seenPath.has(key)) {
        seenPath.add(key);
        // 只留一层浅拷贝
        const shallow = {};
        for (const k of ks) {
          const v = n[k];
          shallow[k] = v && typeof v === 'object' ? (Array.isArray(v) ? `Array(${v.length})` : `{${Object.keys(v).slice(0, 8).join(',')}}`) : String(v).slice(0, 120);
        }
        skuObjects.push({ path: p, keys: ks, shallow });
      }
    }
    for (const k of ks) scan(n[k], p ? p + '.' + k : k, d + 1);
  };
  scan(data);

  // 3. 搜延长宝 / 保障服务 / Care+
  const addonHits = [];
  const scanAddon = (n, p = '', d = 0) => {
    if (d > 20 || n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((v, i) => scanAddon(v, `${p}[${i}]`, d + 1));
    for (const [k, v] of Object.entries(n)) {
      if (typeof v === 'string' && /延长宝|保障服务|Care\+|碎屏|意外无忧/.test(v)) {
        addonHits.push({ path: p ? p + '.' + k : k, value: v.slice(0, 160) });
      } else if (v && typeof v === 'object') scanAddon(v, p ? p + '.' + k : k, d + 1);
    }
  };
  scanAddon(data);

  // 4. 搜含 skuId / attrValueList / valueList / skuAttr 的路径
  const attrHits = [];
  const scanAttr = (n, p = '', d = 0) => {
    if (d > 20 || n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((v, i) => scanAttr(v, `${p}[${i}]`, d + 1));
    for (const [k, v] of Object.entries(n)) {
      if (/attrValue|valueList|skuAttr|attrList|specList|attrName|attrCode|skuName|specName|valueName|attrValueName/i.test(k)) {
        attrHits.push({
          path: p ? p + '.' + k : k,
          value: v && typeof v === 'object' ? (Array.isArray(v) ? `Array(${v.length})` : `{${Object.keys(v).slice(0, 10).join(',')}}`) : String(v).slice(0, 100),
        });
      }
      if (v && typeof v === 'object') scanAttr(v, p ? p + '.' + k : k, d + 1);
    }
  };
  scanAttr(data);

  return { skeleton, skuObjects: skuObjects.slice(0, 30), addonHits: addonHits.slice(0, 40), attrHits: attrHits.slice(0, 60) };
});

mkdirSync(join(__dirname, 'output'), { recursive: true });
const f = join(__dirname, `output/next-${Date.now()}.json`);
writeFileSync(f, JSON.stringify(r, null, 2));

if (r.error) {
  console.log('ERR', r.error);
} else {
  console.log('=== __NEXT_DATA__ 骨架 ===');
  for (const n of r.skeleton.tree) console.log('  ', n.path, n.shape, n.keys ? '[' + n.keys.slice(0, 12).join(',') + ']' : (n.sample || ''));
  console.log('\n=== 含 sbomCode/skuCode 的对象', r.skuObjects.length, '类 ===');
  for (const o of r.skuObjects) console.log('  ', o.path, '\n      keys:', o.keys.join(','), '\n      ', JSON.stringify(o.shallow).slice(0, 400));
  console.log('\n=== 延长宝/保障服务命中', r.addonHits.length, '===');
  for (const a of r.addonHits) console.log('  ', a.path, '=', a.value);
  console.log('\n=== 规格属性字段命中', r.attrHits.length, '===');
  for (const a of r.attrHits) console.log('  ', a.path, '=', a.value);
}
console.log('\n落盘:', f);
await browser.close();
