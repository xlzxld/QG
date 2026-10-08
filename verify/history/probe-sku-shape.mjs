/**
 * SKU 结构确认探针（只读）
 * =====================================================================
 * 目的：把 __NEXT_DATA__ 里 SKU 相关的关键节点原样打印出来，
 *      逐字段确认后再写爬虫 —— 不猜字段。
 *
 * 用法：node grab-probe/probe-sku-shape.mjs [url]
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
  const pp = JSON.parse(el.textContent).props.pageProps;
  const cur = pp.mainData.current;
  const ext = pp.extData;
  const out = {};

  out.prdId = pp.prdId;
  out.urlSbomCode = pp.sbomCode;
  out.currentSbomCode = cur.currentSbomCode;
  out.currentSbomId = cur.currentSbomId;
  out.briefName = cur.briefName;
  out.name = cur.name;
  out.limitedQuantity = cur.limitedQuantity;
  out.isNotAllRush = cur.isNotAllRush;
  out.sbomsCodeArr = cur.sbomsCodeArr;
  out.baseKeys = Object.keys(cur.base || {});
  out.baseSample = (() => {
    const k = cur.currentSbomCode;
    const b = cur.base[k];
    if (!b) return null;
    const o = {};
    for (const [kk, vv] of Object.entries(b)) {
      o[kk] = vv && typeof vv === 'object' ? (Array.isArray(vv) ? `Array(${vv.length})` : `{${Object.keys(vv).slice(0, 10).join(',')}}`) : String(vv).slice(0, 90);
    }
    return o;
  })();

  // ★ 核心1：SKU 规格表 —— 每个 sbom 的属性组合
  out.baseEntryFull = (() => {
    const b = cur.base[cur.currentSbomCode];
    return b ? JSON.parse(JSON.stringify(b)) : null;
  })();

  // ★ 核心2：attrName / productOptions.gbomAttrMappings
  out.attrName = cur.attrName;
  out.productOptionsKeys = Object.keys(cur.productOptions || {});
  out.gbomAttrMappings = cur.productOptions?.gbomAttrMappings
    ? JSON.parse(JSON.stringify(cur.productOptions.gbomAttrMappings))
    : null;

  // ★ 核心3：extInfo 里的 SKU 家族关系
  out.extInfo = (() => {
    const e = cur.extInfo || {};
    const o = {};
    for (const [k, v] of Object.entries(e)) {
      o[k] = Array.isArray(v) ? `Array(${v.length}) = ${JSON.stringify(v).slice(0, 300)}` : v && typeof v === 'object' ? `{${Object.keys(v).slice(0, 8).join(',')}}` : v;
    }
    return o;
  })();
  out.sbomInfosFull = cur.extInfo?.sbomInfos ? JSON.parse(JSON.stringify(cur.extInfo.sbomInfos)) : null;
  out.skuCodesGroups = cur.extInfo?.skuCodesGroups ? JSON.parse(JSON.stringify(cur.extInfo.skuCodesGroups)) : null;

  // ★ 核心4：库存
  out.skuInventory = JSON.parse(JSON.stringify(ext.skuInventory));
  out.initSkuInventory = JSON.parse(JSON.stringify(ext.initSkuInventory));
  out.saleByWareskuInventory = JSON.parse(JSON.stringify(ext.saleByWareskuInventory));

  // ★ 核心5：抢购场次
  out.skuRushbuyInfo = JSON.parse(JSON.stringify(ext.skuRushbuyInfo));

  // ★ 核心6：延长宝 / 保障服务 —— serviceDesList / parameterData.warranty / packageList
  out.serviceDesList = JSON.parse(JSON.stringify(cur.serviceDesList || []));
  out.serviceRightsList = JSON.parse(JSON.stringify(cur.serviceRightsList || []));
  out.parameterData = JSON.parse(JSON.stringify(ext.parameterData || {}));

  // ★ 核心7：价格
  out.priceNodes = (() => {
    const found = {};
    const scan = (n, p = '', d = 0) => {
      if (d > 8 || n === null || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach((v, i) => scan(v, `${p}[${i}]`, d + 1));
      for (const [k, v] of Object.entries(n)) {
        if (/price|Price/.test(k) && (typeof v === 'number' || typeof v === 'string')) found[p ? p + '.' + k : k] = v;
        if (v && typeof v === 'object') scan(v, p ? p + '.' + k : k, d + 1);
      }
    };
    scan(cur.base, 'base');
    return found;
  })();

  // ★ 核心8：全量 SKU 汇总（每个 sbom 的规格组合 + 库存 + 场次 + 延长宝）
  out.skuMatrix = (() => {
    const base = cur.base || {};
    const inv = ext.initSkuInventory?.skuInventory || ext.skuInventory?.skuInventory || {};
    const rushList = ext.skuRushbuyInfo?.skuRushBuyInfoList || [];
    const rushByCode = {};
    for (const x of rushList) rushByCode[x.sbomCode] = x;
    const rows = [];
    for (const [code, b] of Object.entries(base)) {
      rows.push({
        sbomCode: code,
        sbomId: b.sbomId,
        sbomName: b.sbomName,
        attrPaths: b.attrPath,
        attrs: b.attrs || b.attrList,
        price: b.price ?? b.salePrice ?? b.promotionPrice,
        inventory: inv[code],
        rush: rushByCode[code]
          ? {
              startTime: rushByCode[code].startTime,
              endTime: rushByCode[code].endTime,
              limitNum: rushByCode[code].limitNum,
              skuStatus: rushByCode[code].skuStatus,
            }
          : null,
        extendList: (b.extendList || []).map((e) => ({ sbomName: e.sbomName, sbomCode: e.sbomCode, price: e.price, type: e.type })),
        rawKeys: Object.keys(b),
      });
    }
    return rows;
  })();

  return out;
});

mkdirSync(join(__dirname, 'output'), { recursive: true });
const f = join(__dirname, `output/sku-shape-${Date.now()}.json`);
writeFileSync(f, JSON.stringify(r, null, 2));

console.log('prdId', r.prdId, '| url sbomCode', r.urlSbomCode, '| current', r.currentSbomCode);
console.log('商品:', r.name, '/', r.briefName, '| 限购', r.limitedQuantity);
console.log('sbomsCodeArr(' + r.sbomsCodeArr.length + '):', r.sbomsCodeArr.join(','));
console.log('\nextInfo:'); for (const [k, v] of Object.entries(r.extInfo)) console.log('  ', k, '=', String(v).slice(0, 150));
console.log('\nbase 当前项字段:'); for (const [k, v] of Object.entries(r.baseSample || {})) console.log('  ', k, '=', String(v).slice(0, 130));
console.log('\nattrName:', JSON.stringify(r.attrName));
console.log('\nproductOptions keys:', r.productOptionsKeys);
console.log('\ngbomAttrMappings:', JSON.stringify(r.gbomAttrMappings, null, 1).slice(0, 2000));
console.log('\nprice 节点:', JSON.stringify(r.priceNodes, null, 1).slice(0, 1200));
console.log('\nskuInventory:', JSON.stringify(r.skuInventory, null, 1).slice(0, 900));
console.log('\nparameterData:', JSON.stringify(r.parameterData, null, 1).slice(0, 1500));
console.log('\nserviceDesList:', JSON.stringify(r.serviceDesList, null, 1).slice(0, 600));
console.log('\n=== SKU 矩阵', r.skuMatrix.length, '行 ===');
for (const row of r.skuMatrix) {
  console.log(' ', row.sbomCode, '|', String(row.sbomName).slice(0, 40), '| attrPath', JSON.stringify(row.attrPaths || row.attrs), '| ¥', row.price, '| inv', JSON.stringify(row.inventory), '| rush', row.rush ? new Date(row.rush.startTime).toISOString().slice(0, 16) + ' 限' + row.rush.limitNum : '无', '| extend', (row.extendList || []).map((e) => e.sbomName).join('/') || '无');
}
console.log('\n落盘:', f);
await browser.close();
