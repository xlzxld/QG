/**
 * 华为商城 SKU 采集器（只读）
 * =====================================================================
 * 做什么：只采集配置里指定的那些商品 URL，把每个商品的**全部 SKU** 抓全。
 *       一个 URL = 一个商品；该商品下所有规格（颜色 × 版本 × CPU型号…）
 *       逐个列出，含价格、库存、开售时间、限购。
 *
 * 不做什么：
 *   · 不自主发现商品 —— 只去配置里给的 URL，一个都不多跑
 *   · 不做标题关键字匹配 —— 一个 URL 就是一个商品，没有认错的风险
 *   · 不构造请求、不改参数、不重放、不伪造请求头、不逆向签名
 *   · 不下单、不加购、不占库存
 *   · 遇验证码/风控 → 立即停止并如实记录，不做任何绕过
 *
 * 数据从哪来（全部来自页面自己的数据，不额外发请求）：
 *   A. __NEXT_DATA__（页面 SSR 内嵌，1.2MB，主数据源）
 *      · mainData.current.base[sbomCode]      → 规格名 / 价格 / 状态 / 参数
 *      · mainData.current.productOptions
 *          .gbomAttrMappings[维度]            → 颜色/版本/CPU型号 → sbomCode 映射
 *      · extInfo.rushBuySkuCodes              → 参与抢购的 SKU 名单
 *   B. 旁听页面自己发起的接口响应（补 SSR 未填的动态数据）
 *      · querySkuInventoryV2                  → 精确库存数
 *      · buy.vmall.com/queryRushbuyInfo.json  → 开售/结束时间、限购、平台服务器时间
 *
 * 用法：
 *   node platforms/huawei/crawler-huawei.mjs                  # 采集配置里所有启用的商品
 *   node platforms/huawei/crawler-huawei.mjs --headed         # 显示浏览器窗口（调试用）
 *   node platforms/huawei/crawler-huawei.mjs --only=mate90    # 只采 id 匹配的商品（精确优先，子串兜底）
 * =====================================================================
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const GRAB_DIR = path.join(ROOT, 'data', 'grab');
const CONFIG_PATH = path.join(GRAB_DIR, 'huawei.config.json');
const CATALOG_PATH = path.join(GRAB_DIR, 'huawei.catalog.json');

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const getOpt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const HEADLESS = !hasFlag('--headed');
const ONLY = getOpt('only');

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/* =====================================================================
 * 配置：一个 URL = 一个商品
 * =====================================================================
 * products[] 里每一项就是一条待采 URL。不再有 titleKeywords ——
 * 一个 URL 打开就是一个确定的商品，靠关键字匹配反而容易认错。
 *
 * 抢购侧的选择用 skuIds：该商品下要抢的 SKU 编号（华为平台的编号就是 sbomCode）。
 * 留空 = 该商品所有 SKU 都要（爬虫照样全抓，只是给插件的"目标集合"是全集）。
 */
function loadProducts(config) {
  const list = Array.isArray(config?.products) ? config.products : [];
  const out = [];
  for (const [i, p] of list.entries()) {
    if (!p || typeof p !== 'object') continue;
    const url = String(p.url || '').trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      index: i + 1,
      id: String(p.id || p.prdId || extractPrdId(url) || `product_${i + 1}`),
      enabled: p.enabled !== false,
      url,
      // 预填：可指定从哪个 SKU 打开页面（不填就用 URL 自带的）
      openSbomCode: p.openSbomCode ? String(p.openSbomCode) : null,
      // 抢购侧要哪些 SKU（空 = 全部）
      // 字段名用通用的 skuIds；兼容旧配置里华为专用的 sbomCodes
      skuIds: (() => {
        const raw = Array.isArray(p.skuIds) ? p.skuIds : Array.isArray(p.sbomCodes) ? p.sbomCodes : [];
        return raw.map(String).filter(Boolean);
      })(),
      // 下面这些是给插件用的，爬虫原样带到 catalog 里
      maxPrice: p.maxPrice ?? null,
      quantity: p.quantity ?? 1,
      saleAt: p.saleAt ?? null,
      note: p.note || '',
    });
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

/* ── --only 的匹配规则：精确优先，子串兜底 ──
 * 1) 先精确匹配：id 或 URL 里的 prdId 与 only 完全相等 → 只采命中那一个；
 * 2) 精确没命中，再退回子串匹配（保留命令行 `--only=mate90` 的模糊用法）。
 * 为什么要精确优先：商品名互为子串时会误伤 —— 例如 "HUAWEI Mate 90"
 * 是 "HUAWEI Mate 90 Pro" 的子串，纯子串匹配会把两个都采了。
 * 控制台的下拉栏「选谁就采谁」依赖这个语义。
 */
function pickByOnly(list, only) {
  const key = String(only ?? '').trim();
  if (!key) return list;
  const exact = list.filter((p) => {
    const id = String(p.id || '').trim();
    const pid = extractPrdId(p.url);
    return id === key || (pid != null && pid === key);
  });
  if (exact.length) return exact;
  return list.filter((p) => {
    const pid = extractPrdId(p.url);
    return String(p.id || '').includes(key) || (pid != null && String(pid).includes(key));
  });
}

/* =====================================================================
 * 敏感字段剔除
 * =====================================================================
 * 接口/页面数据里混着用户与会话痕迹（userInfo / token / mobile 等）。
 * 这些既不必要也不该留存，按 key 模式剔除。
 */
const SENSITIVE_KEY_PATTERN =
  /(user|account|member|mobile|phone|token|session|cookie|auth|login|customer|address|receiver|idcard|email|headImage|userName|ipLocation)/i;

function stripSensitive(value, depth = 0) {
  if (depth > 14 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripSensitive(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) continue;
    out[k] = stripSensitive(v, depth + 1);
  }
  return out;
}

/* =====================================================================
 * 响应旁听：只观察页面自己发起的请求，不自己发
 * ===================================================================== */
function installCapture(page) {
  return page.addInitScript(() => {
    window.__qpCapture = [];
    const isDataLike = (ct) => /json|javascript|text\/plain/i.test(ct || '');

    const record = (url, text) => {
      if (!text) return;
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        return;
      }
      window.__qpCapture.push({ url, body, at: Date.now() });
    };

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const res = await origFetch.apply(this, args);
      try {
        const ct = res.headers.get('content-type') || '';
        if (isDataLike(ct) && reqUrl && /vmall\.com/.test(reqUrl)) {
          res
            .clone()
            .text()
            .then((t) => record(reqUrl, t))
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return res;
    };

    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__qpUrl = url;
      return OrigOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          const ct = this.getResponseHeader && this.getResponseHeader('content-type');
          if (!isDataLike(ct)) return;
          if (!/vmall\.com/.test(this.__qpUrl || '')) return;
          const t = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
          record(this.__qpUrl, t);
        } catch {
          /* ignore */
        }
      });
      return OrigSend.apply(this, args);
    };
  });
}

const drainCapture = (page) =>
  page.evaluate(() => {
    const c = window.__qpCapture || [];
    window.__qpCapture = [];
    return c;
  });

/* =====================================================================
 * 字段整理小工具
 * ===================================================================== */

/* =====================================================================
 * 时间处理：平台给的毫秒时间戳一律转成**带 +08:00 的本地字符串**
 * =====================================================================
 * 为什么不用 toISOString()：那会转成 UTC，"10:08 开售"会变成 "02:08"，
 * 面板上看到的开售时间就整整差 8 小时。这里固定按平台所在时区（+08:00）输出，
 * 保留原始毫秒值 startTimeMs 供精确计算用。
 */
const CN_OFFSET_MIN = 8 * 60;

function toIso(v) {
  if (v == null || v === '') return null;
  let ms = null;
  if (typeof v === 'number') ms = v;
  else if (typeof v === 'string' && /^\d{13}$/.test(v.trim())) ms = Number(v.trim());
  else if (typeof v === 'string') {
    // "2026-10-07 10:08:00 +0800" → 补成 Safari 能认的格式
    const s = v.trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}):?(\d{2})$/);
    if (!m) {
      const t = Date.parse(s);
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    const [, y, mo, d, h, mi, se, sign, off] = m;
    ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}${sign}:${off}`);
  }
  if (ms == null || !Number.isFinite(ms) || ms < 1e12 || ms > 4e12) return null;

  const d = new Date(ms + CN_OFFSET_MIN * 60 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`
  );
}

function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 平台库存语义：1000 是封顶哨兵值，不是精确 1000 台 */
function readInventoryQty(v) {
  const n = num(v);
  if (n == null) return { qty: null, capped: false };
  return { qty: n, capped: n >= 1000 };
}

/* =====================================================================
 * ★ 核心：解析 __NEXT_DATA__ → 完整 SKU 表
 * =====================================================================
 * 页面的 Next.js 数据里有三块拼在一起才构成完整 SKU 信息：
 *
 *   1. mainData.current.base[sbomCode]
 *      每个 SKU 一个对象，含：name（完整规格名）、price、status、
 *      majorAttrList（详细参数）、buttonInfo（购买按钮形态）
 *
 *   2. mainData.current.productOptions.gbomAttrMappings
 *      { "颜色": [{attrValue:"曜石黑", sbomCode:"..."}],
 *        "版本": [{attrValue:"16GB+512GB", sbomCode:"..."}] }
 *      给出「规格维度 → 每个值对应哪些 sbomCode」的映射。
 *      这才是「SKU 的人类可读标签」的权威来源。
 *
 *   3. extInfo.rushBuySkuCodes
 *      标出哪些 SKU 参与抢购。
 */
function extractFromNextData(pageProps) {
  const cur = pageProps?.mainData?.current;
  if (!cur) return null;

  const base = cur.base && typeof cur.base === 'object' ? cur.base : {};
  const ext = cur.extInfo && typeof cur.extInfo === 'object' ? cur.extInfo : {};
  const gbom = cur.productOptions?.gbomAttrMappings || {};

  // ── 规格维度 → sbomCode 反向索引 ──
  // gbomAttrMappings 形如 { 颜色: [ {attrValue, sbomCode, supportSbomCodes}, ... ] }
  // 注意：同一条记录会在多个维度里重复出现（同一 sbom 的颜色/版本/CPU 各一条），
  // 所以要把所有维度的值合并到同一个 sbomCode 上。
  const dims = Object.keys(gbom);
  const attrsBySbom = new Map(); // sbomCode -> { 颜色:'曜石黑', 版本:'...' }
  const valuesByDim = {}; // 维度 -> [{value, skuIds:[]}]（skuIds = 该维度值对应的 SKU 编号）
  for (const dim of dims) {
    const arr = Array.isArray(gbom[dim]) ? gbom[dim] : [];
    const seen = new Set();
    for (const it of arr) {
      const code = it?.sbomCode != null ? String(it.sbomCode) : null;
      const val = it?.attrValue != null ? String(it.attrValue) : null;
      if (!code || !val) continue;
      if (!attrsBySbom.has(code)) attrsBySbom.set(code, {});
      attrsBySbom.get(code)[dim] = val;

      // 同一维度同一个值可能对应多个 sbomCode（不同颜色各自一个条目）
      if (!valuesByDim[dim]) valuesByDim[dim] = [];
      let bucket = valuesByDim[dim].find((x) => x.value === val);
      if (!bucket) {
        bucket = { value: val, attrValueCode: it.attrValueCode != null ? String(it.attrValueCode) : null, label: it.label ?? null, skuIds: [] };
        valuesByDim[dim].push(bucket);
        seen.add(val);
      }
      if (!bucket.skuIds.includes(code)) bucket.skuIds.push(code);
    }
  }

  const rushSet = new Set((ext.rushBuySkuCodes || []).map(String));
  const allCodes = Array.isArray(cur.sbomsCodeArr) && cur.sbomsCodeArr.length
    ? cur.sbomsCodeArr.map(String)
    : Object.keys(base);

  /**
   * 推导可购状态。
   *
   * 平台的 buttonMode 就是答案，但它没有可读名字，所以这里翻成人话：
   *   1 = 立即购买（现货）
   *   2 = 即将开售（可预约）
   *   9 = 缺货 / 售罄
   *  29 = 抢购未开售（倒计时中）★ 明天要抢的就是这个
   *
   * 数值含义以页面渲染为准，这里只做映射；未识别的值原样透出，
   * 不硬套「可买/不可买」—— 宁可给原始值也不给错判断。
   */
  const BUTTON_MODE_LABEL = {
    1: { text: '现货可买', buyable: true },
    2: { text: '即将开售', buyable: false },
    3: { text: '现货可买', buyable: true },
    9: { text: '缺货', buyable: false },
    10: { text: '缺货', buyable: false },
    29: { text: '抢购未开售', buyable: false },
    31: { text: '预约中', buyable: false },
  };

  // 逐个 SKU 组装
  const skus = [];
  for (const code of allCodes) {
    const b = base[code] || {};
    const attrs = attrsBySbom.get(code) || {};

    // 规格标签：优先用页面给的完整 name，没有就用「维度值」拼
    const label =
      b.name ||
      b.sbomAbbr ||
      Object.values(attrs).join(' ') ||
      code;

    // 详细参数（屏幕/电池/摄像头…）—— 这些是同一个 sbom 内所有 SKU 共享的商品参数
    const params = (Array.isArray(b.majorAttrList) ? b.majorAttrList : []).map((p) => ({
      name: p?.attrName ?? null,
      value: p?.attrValue ?? null,
    }));

    const bm = b.buttonMode != null ? String(b.buttonMode) : null;
    const modeInfo = bm != null ? BUTTON_MODE_LABEL[Number(bm)] : null;

    skus.push({
      sbomCode: code,
      sbomId: b.sbomId != null ? String(b.sbomId) : null,
      gbomCode: b.gbomCode != null ? String(b.gbomCode) : null,
      label,
      briefName: b.sbomAbbr ?? null,
      // 规格维度值（颜色/版本/CPU型号…）
      attrs,
      price: num(b.price),
      status: b.status ?? null,
      buttonMode: bm,
      // 可购状态（人话）
      buyableNow: modeInfo ? modeInfo.buyable : null,
      buyableText: modeInfo ? modeInfo.text : (bm == null ? '未知' : `未识别模式 ${bm}`),
      buttonInfo: b.buttonInfo ? stripSensitive(b.buttonInfo) : null,
      isRushBuySku: rushSet.has(code),
      // 商品级限制（每个 SKU 各自的）
      limitedQuantity: b.limitedQuantity ?? null,
      commingSoonFlag: b.commingSoonFlag ?? null,
      isSaleByWare: b.isSaleByWare ?? null,
      // 时间窗（抢购/预售）
      timerPromStartTime: toIso(b.timerPromStartTime),
      timerPromEndTime: toIso(b.timerPromEndTime),
      timerPromWord: b.timerPromWord ?? null,
      // 下面这些是动态数据，先留空，拿到接口响应后回填
      inventoryQty: null,
      inventoryCapped: false,
      isSaleByWareRaw: null,
      rushBuy: null,
      // 商品参数
      params,
      // 图片
      photoPath: b.photoPath && b.photoName ? `https://res.vmallres.com${b.photoPath}${b.photoName}` : null,
    });
  }

  return {
    prdId: String(pageProps.prdId || cur.disPrdId || ''),
    name: cur.name ?? null,
    briefName: cur.briefName ?? null,
    brandName: cur.brandName ?? null,
    productType: cur.productType ?? null,
    urlSbomCode: pageProps.sbomCode ? String(pageProps.sbomCode) : null,
    currentSbomCode: cur.currentSbomCode != null ? String(cur.currentSbomCode) : null,
    currentSbomId: cur.currentSbomId != null ? String(cur.currentSbomId) : null,
    limitedQuantity: cur.limitedQuantity ?? null,
    isNotAllRush: cur.isNotAllRush ?? null,
    isHasRushAndOther: cur.isHasRushAndOther ?? null,
    allAttrName: cur.attrName ?? null,
    // 规格维度（面板上要做成可勾选的表）
    specDimensions: dims.map((dim) => ({ name: dim, values: valuesByDim[dim] || [] })),
    // SKU 家族关系（哪些 SKU 属于同一组）
    family: {
      skuCodes: (ext.skuCodes || []).map(String),
      sbomInfos: (ext.sbomInfos || []).map(String),
      rushBuySkuCodes: (ext.rushBuySkuCodes || []).map(String),
      storeSkuCodes: (ext.storeSkuCodes || []).map(String),
      spuCode: (ext.spuCode || []).map(String),
      shopCodeMap: stripSensitive(ext.shopCodeMap || {}),
    },
    // 平台参数（保修/礼包）
    parameterData: stripSensitive(pageProps.extData?.parameterData || {}),
    skus,
  };
}

/* =====================================================================
 * ★ 统一 SKU 字段（跨平台约定）
 * =====================================================================
 * 问题：控制台是一套，平台会有很多个。如果控制台里直接写 `sku.sbomCode`，
 *       那么每加一个平台就要改一次控制台，迟早乱套。
 *
 * 做法：爬虫除了输出平台原始字段，再按下面的约定输出一组**统一字段**。
 *       控制台只认统一字段；加新平台时，新爬虫照着输出这组字段就行，
 *       控制台一行都不用改。
 *
 * 约定（所有平台都要有）：
 *   skuId        该平台用来唯一标识这个可选规格的编号
 *   statusText   状态人话（"现货可买" / "抢购未开售" / "缺货"…）
 *   buyable      现在能不能直接买（布尔）
 *   saleStartAt  开售时间（ISO，没有就 null）
 *   limitPerUser 每人限购数量
 *   stockQty     库存数（null = 该平台不提供 / 未开售查不到）
 *   stockCapped  库存是否是"充足"的封顶值（不是精确数）
 *
 * 平台原始字段一律保留（sbomCode / buttonMode / rushBuy…），
 * 便于排查和将来需要平台特有逻辑时使用。
 */
function addUnifiedSkuFields(skus) {
  for (const s of skus) {
    s.skuId = s.sbomCode ?? null;
    s.statusText = s.buyableText ?? null;
    s.buyable = s.buyableNow ?? null;
    s.saleStartAt = s.rushBuy?.startTime ?? null;
    s.limitPerUser = s.rushBuy?.limitNum ?? s.limitedQuantity ?? null;
    s.stockQty = s.inventoryQty ?? null;
    s.stockCapped = s.inventoryCapped ?? false;
  }
  return skus;
}

/* =====================================================================
 * 接口响应补齐：库存 + 抢购场次
 * ===================================================================== */

/** querySkuInventoryV2 → { sbomCode: {qty, capped, isSaleByWare} } */
function extractInventory(records) {
  const out = new Map();
  for (const rec of records) {
    if (!/querySkuInventoryV2/i.test(rec.url)) continue;
    const list = rec.body?.inventoryReqVOs || rec.body?.inventoryVOs || rec.body?.skuInventoryList;
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const code = it?.skuCode != null ? String(it.skuCode) : null;
      if (!code) continue;
      const { qty, capped } = readInventoryQty(it.inventoryQty);
      out.set(code, {
        inventoryQty: qty,
        inventoryCapped: capped,
        isSaleByWare: it.isSaleByWare ?? null,
      });
    }
  }
  return out;
}

/** queryRushbuyInfo.json → { sbomCode: 场次 } + 平台服务器时间 */
function extractRushBuy(records) {
  const map = new Map();
  let serverNow = null;
  for (const rec of records) {
    if (!/queryRushbuyInfo/i.test(rec.url)) continue;
    const body = rec.body || {};
    if (typeof body.currentTime === 'number') serverNow = { ms: body.currentTime, iso: toIso(body.currentTime) };
    const list = body.skuRushBuyInfoList;
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const code = it?.sbomCode != null ? String(it.sbomCode) : null;
      if (!code) continue;
      const startMs = typeof it.startTime === 'number' ? it.startTime : num(it.startTime);
      map.set(code, {
        activityId: it.activityId ?? null,
        activityName: it.activityName ?? null,
        startTimeMs: startMs,
        startTime: toIso(it.startTime),
        endTimeMs: typeof it.endTime === 'number' ? it.endTime : num(it.endTime),
        endTime: toIso(it.endTime),
        startsInMs: startMs != null && serverNow ? startMs - serverNow.ms : null,
        limitNum: it.limitNum ?? null,
        attendQualification: it.attendQualification ?? null,
        skuStatus: it.skuStatus ?? null,
        activityType: it.activityType ?? null,
        isYY: it.isYY ?? null,
        price: num(it.price),
        totalInventory: it.totalInventory ?? null,
        saleInventory: it.saleInventory ?? null,
        placeholder: it.placeholder ?? null,
        placeholderDesc: it.placeholderDesc ?? null,
        raw: stripSensitive(it),
      });
    }
  }
  return { map, serverNow };
}

/* =====================================================================
 * 页面访问 + 采集
 * ===================================================================== */

function detectChallenge(page) {
  return page.evaluate(() => {
    const t = (document.body ? document.body.innerText : '') || '';
    if (/安全验证|滑动验证|人机验证|请完成验证|拖动滑块|请完成安全验证/.test(t)) return 'CAPTCHA';
    if (/访问受限|操作过于频繁|请求过于频繁|异常流量|拒绝访问/.test(t)) return 'RISK_BLOCKED';
    const hasSlider = !!document.querySelector(
      '[class*="slider"],[class*="captcha"],[id*="captcha"],iframe[src*="captcha"],[class*="verify"]',
    );
    if (hasSlider && t.replace(/\s+/g, '').length < 600) return 'CAPTCHA_SUSPECTED';
    return null;
  });
}

/**
 * 采集一个商品页。
 * 只做「打开页面 + 等它自己加载完 + 读它自己的数据」，不点任何东西。
 */
async function collectProduct(page, product) {
  const result = {
    config: product,
    ok: false,
    error: null,
    challenge: null,
    data: null,
    pageInfo: null,
    endpoints: [],
  };

  try {
    const resp = await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    result.httpStatus = resp ? resp.status() : null;
  } catch (e) {
    result.error = `打开失败：${e.message.split('\n')[0]}`;
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3500);

  // 人一样往下滚一遍，触发懒加载区（参数表、附加服务区都在下方）
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 900));
    await page.waitForTimeout(700 + Math.random() * 500);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);

  result.challenge = await detectChallenge(page);
  if (result.challenge) {
    result.ok = false;
    result.error = `检测到风控：${result.challenge}`;
    result.records = await drainCapture(page);
    return result;
  }

  // 页面可见信息（作为「URL 有效性」的判据，不参与 SKU 抽取）
  result.pageInfo = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const t = clean(document.body?.innerText);
    return {
      finalUrl: location.href,
      title: clean(document.title),
      textLength: t.length,
    };
  });

  const records = await drainCapture(page);
  result.records = records;
  result.endpoints = [...new Set(records.map((r) => r.url.split('?')[0].replace('https://', '')))];

  // ★ 主数据源：__NEXT_DATA__
  const pageProps = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent)?.props?.pageProps ?? null;
    } catch {
      return null;
    }
  });

  if (!pageProps) {
    result.error = '页面里没有 __NEXT_DATA__（结构可能改版了）';
    return result;
  }

  const next = extractFromNextData(pageProps);
  if (!next) {
    result.error = '__NEXT_DATA__ 里没有 mainData.current（结构可能改版了）';
    return result;
  }

  // ★ 用接口响应回填库存与抢购场次
  const inv = extractInventory(records);
  const rush = extractRushBuy(records);
  for (const sku of next.skus) {
    if (inv.has(sku.sbomCode)) Object.assign(sku, inv.get(sku.sbomCode));
    if (rush.map.has(sku.sbomCode)) sku.rushBuy = rush.map.get(sku.sbomCode);
  }
  if (rush.serverNow) next.serverNow = rush.serverNow;

  // ★ 补统一字段（回填完才算得出，所以放这里）
  addUnifiedSkuFields(next.skus);

  // URL 有效性：页面被重定向走了 / 文本异常短 / 与配置的商品编号不符
  const expectedPrdId = extractPrdId(product.url);
  next.urlValid =
    !/error|404/i.test(result.pageInfo.finalUrl) &&
    (result.pageInfo.textLength ?? 0) > 200 &&
    (!expectedPrdId || !next.prdId || expectedPrdId === next.prdId);

  result.data = next;
  result.ok = true;
  return result;
}

/* =====================================================================
 * 与上次结果比对：回流信号 + 价格变化
 * ===================================================================== */

function diffWithPrevious(prev, current) {
  const out = { restock: [], priceChanges: [], soldOutSkus: [] };
  const prevSkus = prev?.products?.flatMap((p) => p.skus || []) || [];
  const prevByCode = new Map();
  for (const s of prevSkus) if (s?.sbomCode) prevByCode.set(s.sbomCode, s);

  for (const p of current.products || []) {
    for (const s of p.skus || []) {
      const before = prevByCode.get(s.sbomCode);
      if (!before) continue;
      if (before.inventoryQty === 0 && (s.inventoryQty ?? 0) > 0) {
        out.restock.push({ prdId: p.prdId, sbomCode: s.sbomCode, label: s.label, from: 0, to: s.inventoryQty });
      }
      if (before.inventoryQty === 0 && s.inventoryQty === 0) {
        out.soldOutSkus.push({ prdId: p.prdId, sbomCode: s.sbomCode, label: s.label });
      }
      if (before.price != null && s.price != null && before.price !== s.price) {
        out.priceChanges.push({ prdId: p.prdId, sbomCode: s.sbomCode, label: s.label, from: before.price, to: s.price });
      }
    }
  }
  return out;
}

/* =====================================================================
 * 主流程
 * ===================================================================== */

async function main() {
  const startedAt = new Date().toISOString();
  log('='.repeat(64));
  log('华为商城 SKU 采集器（只读 · 只采指定 URL）');
  log('='.repeat(64));

  const config = loadJson(CONFIG_PATH, {});
  const prevCatalog = loadJson(CATALOG_PATH, null);

  const all = loadProducts(config);
  const todo = pickByOnly(all.filter((p) => p.enabled), ONLY);

  // --only 子串兜底必须留痕（2026-10-07）：兜底是"猜意图"，猜错非常静——
  // 实测 "HUAWEI Mate 90"（已删）会子串撞上 "HUAWEI Mate 90 Pro"。
  // 控制台路径已在桥接入口做过精确硬闸门（走不到这里的兜底）；这里管命令行直跑，
  // 命中兜底就打一条显眼日志，保证可追溯。
  if (ONLY && todo.length) {
    const k = String(ONLY).trim();
    const exactAll = all.find((p) => String(p.id || '').trim() === k || extractPrdId(p.url) === k);
    if (exactAll && exactAll.enabled === false) {
      log(`⚠ --only=${k} 命中的商品已停用（enabled=false），本次不采它；子串兜底采到的是：${todo.map((p) => p.id).join('、')}`);
    } else if (!(exactAll && exactAll.enabled !== false)) {
      log(`⚠ --only=${k} 未精确命中（可能已删除/改名），按子串兜底匹配到：${todo.map((p) => p.id).join('、')} —— 请确认是不是你要的商品`);
    }
  }

  if (!all.length) {
    log('配置里没有 products —— 没有可采的 URL');
    log('请在 data/grab/huawei.config.json 的 products[] 里填上商品页地址');
    return { generatedAt: new Date().toISOString(), products: [], counts: { products: 0 }, blocked: [], restock: [] };
  }
  if (!todo.length) {
    log(`配置里有 ${all.length} 个商品，但没有一个启用${ONLY ? `（--only=${ONLY} 没匹配上）` : ''}`);
    return { generatedAt: new Date().toISOString(), products: [], counts: { products: 0 }, blocked: [], restock: [] };
  }

  log(`待采商品 ${todo.length} 个：`);
  for (const p of todo) log(`  · ${p.id}  ${p.url.slice(0, 96)}`);

  const browser = await chromium.launch({ channel: 'chromium', headless: HEADLESS });
  const ctx = await browser.newContext({
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  await installCapture(page);

  const products = [];
  const blocked = [];
  let stoppedEarly = null;

  for (const [i, p] of todo.entries()) {
    const n = i + 1;
    log(`\n[${n}/${todo.length}] ${p.id}`);
    const r = await collectProduct(page, p);

    if (r.challenge) {
      // 按行为约束：遇风控立即停，不绕过
      log(`  ⛔ 检测到 ${r.challenge} —— 立即停止，不做任何绕过`);
      blocked.push({ id: p.id, url: p.url, challenge: r.challenge, at: new Date().toISOString() });
      stoppedEarly = r.challenge;
      break;
    }

    if (!r.ok || !r.data) {
      log(`  ✗ ${r.error || '采集失败'}`);
      products.push({
        config: p,
        ok: false,
        error: r.error,
        url: p.url,
        prdId: extractPrdId(p.url),
        skus: [],
      });
      await page.waitForTimeout(1200 + Math.random() * 1200);
      continue;
    }

    const d = r.data;
    // 把配置里"要抢哪些 SKU"标出来，方便插件和面板直接用
    const want = new Set(p.skuIds);
    const skus = d.skus.map((s) => ({
      ...s,
      selected: p.skuIds.length ? want.has(s.skuId ?? s.sbomCode) : false,
    }));

    products.push({
      ok: true,
      // 配置信息
      configId: p.id,
      configEnabled: p.enabled,
      configuredSkuIds: p.skuIds,
      configuredMaxPrice: p.maxPrice,
      configuredQuantity: p.quantity,
      configuredSaleAt: p.saleAt,
      configNote: p.note,
      // 商品信息
      prdId: d.prdId,
      url: p.url,
      finalUrl: r.pageInfo.finalUrl,
      pageTitle: r.pageInfo.title,
      urlValid: d.urlValid,
      httpStatus: r.httpStatus ?? null,
      name: d.name,
      briefName: d.briefName,
      brandName: d.brandName,
      productType: d.productType,
      limitedQuantity: d.limitedQuantity,
      isNotAllRush: d.isNotAllRush,
      urlSbomCode: d.urlSbomCode,
      currentSbomCode: d.currentSbomCode,
      currentSbomId: d.currentSbomId,
      serverNow: d.serverNow || null,
      // ★ 规格维度（面板上渲染成可勾选的表）
      specDimensions: d.specDimensions,
      // ★ 全部 SKU
      skus,
      // 家族关系
      family: d.family,
      parameterData: d.parameterData,
      endpoints: r.endpoints,
    });

    const inStock = skus.filter((s) => (s.inventoryQty ?? 0) > 0).length;
    const withRush = skus.filter((s) => s.rushBuy).length;
    const buyable = skus.filter((s) => s.buyableNow).length;
    log(
      `  ✓ ${d.name || '(无标题)'}` +
        `\n     SKU ${skus.length} 个　现售可买 ${buyable}　现货有货 ${inStock}　待抢购 ${withRush}` +
        `\n     规格维度：${d.specDimensions.map((x) => `${x.name}(${x.values.length})`).join('  ') || '无'}`,
    );
    for (const s of skus) {
      const inv =
        s.inventoryQty == null
          ? '库存未读到'
          : s.inventoryQty === 0
            ? '缺货'
            : s.inventoryCapped
              ? '库存充足'
              : `库存${s.inventoryQty}`;
      const rush = s.rushBuy
        ? `${String(s.rushBuy.startTime || '').slice(5, 16).replace('T', ' ')} 限购${s.rushBuy.limitNum}`
        : '无场次';
      const attrs = Object.values(s.attrs || {}).join('/');
      log(
        `       ${s.sbomCode}  ¥${String(s.price ?? '?').padStart(6)}  ${s.buyableText.padEnd(6)}  ${inv.padEnd(8)} ${rush.padEnd(22)} ${attrs || s.label.slice(0, 30)}`,
      );
    }

    await page.waitForTimeout(1200 + Math.random() * 1500);
  }

  // ── 汇总落盘 ──
  //
  // ★ 局部采集（--only）时，把上次目录里"本次没采"的商品原样保留。
  //   不然会出现这种坑：4 个商品，只采其中 1 个，写盘是整份重写，
  //   另外 3 个的数据就没了 —— 面板上全变成"未采集"，看着像坏了。
  const collectedUrls = new Set(todo.map((x) => x.url));
  const keptProducts = (prevCatalog?.products || []).filter(
    (p) => p && p.url && !collectedUrls.has(p.url) && p.ok,
  );
  const finalProducts = [...products, ...keptProducts];
  if (keptProducts.length) {
    log(`\n本次只采了 ${todo.length} 个商品，保留上次目录里另外 ${keptProducts.length} 个的数据：`);
    for (const k of keptProducts) log(`  · ${k.configId || k.prdId || '(未命名)'}（${(k.skus || []).length} 个 SKU）`);
  }

  const okProducts = finalProducts.filter((p) => p.ok);
  const allSkus = okProducts.flatMap((p) => p.skus || []);
  const current = { products: finalProducts, skus: allSkus };

  const { restock, priceChanges, soldOutSkus } = diffWithPrevious(prevCatalog, current);

  const catalog = {
    _说明: [
      '华为商城 SKU 采集结果（只读，自动生成）。',
      '每个 products[] 对应配置里的一条 URL —— 一个 URL 就是页面上的那一个商品，没有别的商品。',
      'skus[] 是该商品的**全部** SKU，含每个规格的价格 / 库存 / 开售时间 / 限购。',
      '字段来源：__NEXT_DATA__ 的 mainData.current（规格名、价格、状态、参数）',
      '＋ 页面自身请求 querySkuInventoryV2（精确库存）与 queryRushbuyInfo（开售时间/限购/服务器时间）。',
      'selected=true 表示配置里把它列为抢购目标（skuIds）。',
      '局部采集（--only）时，未参与本次采集的商品会原样保留上次结果。',
    ].join(''),
    platform: 'huawei',
    // 平台元信息：控制台照这个显示文案，不写死"华为"。
    // 加新平台时，新爬虫提供自己的一份，控制台不用改。
    platformMeta: {
      key: 'huawei',
      label: '华为商城',
      skuIdLabel: 'SKU 编号',
      specLabel: '规格',
      addUrlPlaceholder: 'https://item.vmall.com/product/comdetail/index.html?prdId=...',
      orderLookupHint: '在华为商城「我的订单」里核对',
    },
    generatedAt: new Date().toISOString(),
    startedAt,
    mode: { headless: HEADLESS, only: ONLY, stoppedEarly },
    counts: {
      // 本次采集的（不含保留的）
      products: products.length,
      ok: products.filter((p) => p.ok).length,
      failed: products.length - products.filter((p) => p.ok).length,
      // 从上次目录保留的
      kept: keptProducts.length,
      // 目录里总共有多少（= 本次 + 保留）
      totalProducts: finalProducts.length,
      skus: allSkus.length,
      buyableNow: allSkus.filter((s) => s.buyableNow).length,
      inStock: allSkus.filter((s) => (s.inventoryQty ?? 0) > 0).length,
      outOfStock: allSkus.filter((s) => s.inventoryQty === 0).length,
      inventoryUnknown: allSkus.filter((s) => s.inventoryQty == null).length,
      withRushBuy: allSkus.filter((s) => s.rushBuy).length,
      selected: allSkus.filter((s) => s.selected).length,
      restock: restock.length,
      blocked: blocked.length,
    },
    serverNow: okProducts.map((p) => p.serverNow).find(Boolean) || null,
    restock,
    priceChanges,
    soldOutSkus,
    blocked,
    inventoryNote:
      'inventoryQty=0 表示缺货。**1000 是平台封顶哨兵值**，语义为「≥1000 或充足」，不是精确 1000 台；' +
      'inventoryCapped=true 即表示被截断。库存接口在 SSR 首屏不填，必须靠旁听 querySkuInventoryV2 拿到。' +
      '未开售的抢购 SKU 平台不查库存，inventoryQty 会是 null（inventoryUnknown 计数）—— ' +
      '这类 SKU 的可购状态看 buyableText / buttonMode。',
    buyableNote:
      'buyableText 由 base[sbomCode].buttonMode 映射而来：1=现货可买，29=抢购未开售，9=缺货，2=即将开售。' +
      '未识别的 buttonMode 会原样显示为「未识别模式 X」，不硬套结论。',
    rushBuyNote:
      'startsInMs 以平台服务器时间 currentTime 为基准，不受本机时钟偏差影响 —— 倒计时必须用它。',
    specNote:
      'specDimensions 来自 productOptions.gbomAttrMappings，每个维度列出全部可选值以及每个值对应的 sbomCode；' +
      'skus[].attrs 给出该 SKU 在各维度上的取值。',
    products: finalProducts,
  };

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), 'utf8');

  log('\n' + '='.repeat(64));
  log(`已写入 ${path.relative(ROOT, CATALOG_PATH)}`);
  log(
    `  本次采集 商品 ${catalog.counts.ok}/${catalog.counts.products} 个` +
      (catalog.counts.kept ? `（另保留上次的 ${catalog.counts.kept} 个）` : '') +
      `\n  目录总计 商品 ${catalog.counts.totalProducts} 个　SKU ${catalog.counts.skus} 个` +
      `（有货 ${catalog.counts.inStock}　缺货 ${catalog.counts.outOfStock}）`,
  );
  log(`  参与抢购 ${catalog.counts.withRushBuy}　回流 ${restock.length}`);
  if (priceChanges.length) {
    log(`  价格变化 ${priceChanges.length} 处：`);
    for (const c of priceChanges.slice(0, 8)) log(`    ${c.sbomCode} ¥${c.from} → ¥${c.to}  ${c.label.slice(0, 30)}`);
  }
  if (blocked.length) log(`  ⛔ 因风控提前停止：${blocked[0].challenge}`);
  log('='.repeat(64));

  await ctx.close();
  await browser.close();
  return catalog;
}

main()
  .then((c) => {
    console.log('QP_CRAWL_RESULT ' + JSON.stringify({ ok: !c.blocked?.length, generatedAt: c.generatedAt, counts: c.counts, restock: c.counts.restock, blocked: c.counts.blocked }));
    process.exit(0);
  })
  .catch((e) => {
    console.error('采集异常：', e);
    console.log('QP_CRAWL_RESULT ' + JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
