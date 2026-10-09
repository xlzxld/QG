/**
 * probe-damai.mjs - 大麦演出项目探针 v2（真实采集版）
 * =====================================================================
 * v1 的问题：
 *   1. 直连 HTTP 会被大麦反爬拦截（滑块/空页），旧实现退化为"硬编码假数据"；
 *   2. 只按"一个 ID = 一个站"记录，遗漏了巡演项目的多城市站
 *      （薛之谦巡演的贵阳站/厦门站/成都站各自是独立 itemId）。
 *
 * v2 采集原理：
 *   用无头浏览器打开大麦 H5 详情页，拦截页面自身发出的
 *   `mtop.damai.item.detail.getdetail` 响应 —— 请求签名由页面 JS 自动
 *   生成，无需逆向，也不触发滑块验证。
 *
 * 采集内容（每个响应一次拿全）：
 *   1. 当前站完整数据：名称/城市/场馆/日期/日期场次/价格范围/限购
 *      - 日期场次来自 serviceTips 退票规则中的 performDate 列表
 *   2. 同巡演全部城市站：data.guide.tour.projectList
 *      - 每站含 cityName / itemId / saleStatus(预约|缺货|在售) / showTime / tourId
 *
 * 产出：合并写入 data/grab/damai.catalog.json，供控制台分组下拉选择。
 *   - 当前站：完整数据（fullData=true）
 *   - 其它站：概要数据（fullData=false），控制台可"补采"拉全量
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CATALOG_FILE = path.join(ROOT, 'data', 'grab', 'damai.catalog.json');

const DETAIL_API_KEY = 'mtop.damai.item.detail.getdetail';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

/* ==================== catalog 读写 ==================== */

function loadCatalog() {
  if (fs.existsSync(CATALOG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    } catch (e) {}
  }
  return { updatedAt: new Date().toISOString(), items: [] };
}

function saveCatalog(cat) {
  cat.updatedAt = new Date().toISOString();
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(cat, null, 2), 'utf8');
  console.log(`[探针完成] 已将最新演出商品库保存至: ${CATALOG_FILE}`);
}

/* ==================== 真实采集（无头浏览器拦截接口） ==================== */

async function fetchDetailPayload(itemId, { timeoutMs = 45000, headful = false } = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: !headful,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const ctx = await browser.newContext({
      userAgent: MOBILE_UA,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
    });
    const page = await ctx.newPage();

    let settled = false;
    let resolvePayload;
    const payloadPromise = new Promise((res) => { resolvePayload = res; });

    page.on('response', async (resp) => {
      if (settled) return;
      if (!resp.url().includes(DETAIL_API_KEY)) return;
      try {
        const j = await resp.json();
        if (j && j.data && j.data.item && j.data.item.itemId) {
          settled = true;
          resolvePayload(j);
        }
      } catch (e) { /* 非 JSON / 空响应忽略 */ }
    });

    await page
      .goto(`https://m.damai.cn/shows/item.html?itemId=${itemId}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      .catch(() => {});

    const timeout = new Promise((res) => setTimeout(() => { if (!settled) { settled = true; res(null); } }, timeoutMs));
    return await Promise.race([payloadPromise, timeout]);
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ==================== 响应解析（纯函数，可单测） ==================== */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从展示名派生站名，如 "贵阳·薛之谦…巡回演唱会- 贵阳站" → "贵阳站" */
function deriveStationName(displayName, cityName) {
  const m = String(displayName || '').match(/[-—]\s*([^-—]+?站)\s*$/);
  if (m) return m[1].trim();
  return cityName ? String(cityName).replace(/市$/, '') + '站' : '';
}

/** 从展示名派生巡演名，如 "贵阳·薛之谦“万兽之王”巡回演唱会- 贵阳站" → "薛之谦“万兽之王”巡回演唱会" */
function deriveTourName(displayName, stationName) {
  let t = String(displayName || '');
  t = t.replace(/^【[^】]*】\s*/, '');                    // 去 "【贵阳】" 前缀
  if (stationName) {
    t = t.replace(new RegExp(`[-—\\s]*${escapeRegExp(stationName)}\\s*$`), ''); // 去 "- 贵阳站" 后缀
  }
  t = t.replace(/[-—]\s*[^-—]*站\s*$/, '');               // 兜底去任意 "- XX站" 后缀
  t = t.replace(/^[^·]{2,6}·\s*/, '');                    // 去 "贵阳·" 前缀
  return t.trim();
}

/** 从详情接口响应解析出统一结构（不依赖网络，可单测） */
function parseDetailPayload(payload) {
  const d = payload.data || {};
  const item = d.item || {};
  const venue = d.venue || {};
  const tour = (d.guide && d.guide.tour) || {};
  const projectList = Array.isArray(tour.projectList) ? tour.projectList : [];
  const itemId = String(item.itemId || '');

  // —— 日期场次：从退票规则里提取 performDate 列表（实测与 App 显示的场次一致）——
  const sessions = [];
  const terms = (d.serviceTips && d.serviceTips.serviceTerm) || [];
  for (const t of terms) {
    if (!t || !t.tagDescJson) continue;
    try {
      const parsed = JSON.parse(t.tagDescJson);
      for (const r of parsed.performRules || []) {
        const name = r && r.performDate ? String(r.performDate) : '';
        if (name && !sessions.find((s) => s.name === name)) {
          sessions.push({ id: 'p' + (sessions.length + 1), name, inStock: true });
        }
      }
    } catch (e) { /* 该 term 无场次数据 */ }
  }

  // —— 开售时间提示（从演出介绍文本提取，仅供参考）——
  // 文案样例: "10月17日-18日场次第二次销售时间：10月7日17:17"
  const saleTimeHints = [];
  try {
    const intro = (d.desc && d.desc.introduce) || '';
    const text = String(intro).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const re = /(\d{1,2}月\d{1,2}日)(\s*-\s*\d{1,2}日)?[^。；;\n]{0,16}?(?:销售|开售|售票|预售)时间[：:]?\s*(\d{1,2}月\d{1,2}日)?\s*(\d{1,2}:\d{2})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const hint = `${m[1]}${m[2] || ''} → ${m[3] ? m[3] + ' ' : ''}${m[4]}`;
      if (!saleTimeHints.includes(hint)) saleTimeHints.push(hint);
    }
  } catch (e) {}

  // —— 当前站在巡演列表里的条目 ——
  const me = projectList.find((s) => String(s.itemId || '') === itemId) || null;

  const displayName = item.itemNameDisplay || item.itemName || '';
  const stationName = (me && me.cityName) || deriveStationName(displayName, venue.venueCityName || item.cityName);
  const tourName = deriveTourName(displayName, stationName);

  const stations = projectList.map((s) => ({
    stationName: s.cityName || '',
    itemId: String(s.itemId || ''),
    saleStatus: s.saleStatus || '',
    showTime: s.showTime || '',
    tourId: s.tourId ? String(s.tourId) : '',
    current: String(s.itemId || '') === itemId,
  }));

  return {
    id: `st-${itemId}`,
    itemId,
    projectId: item.projectId ? String(item.projectId) : '',
    tourId: me && me.tourId ? String(me.tourId) : (stations[0] && stations[0].tourId) || '',
    tourName,
    stationName,
    name: String(displayName).replace(/^【[^】]*】\s*/, '').trim() || displayName,
    city: venue.venueCityName || item.cityName || '',
    venue: venue.venueName || '',
    venueAddr: venue.venueAddr || '',
    showTime: item.showTime || '',
    stationShowTime: (me && me.showTime) || '',
    saleStatus: (me && me.saleStatus) || '',
    status: (me && me.saleStatus) || '在售',
    priceRange: (d.price && d.price.range) || '',
    purchaseLimit: item.purchaseLimitation ? String(item.purchaseLimitation) : '',
    duration: item.showDuration || '',
    saleTimeHints,
    fullData: true,
    source: 'damai-h5-live',
    updatedAt: new Date().toISOString(),
    sessions,
    priceTiers: [],
    stations,
  };
}

/* ==================== 合并进 catalog（纯函数，可单测） ==================== */

/**
 * 把一次探针结果合并进 catalog：
 *   1. 当前站：完整覆盖写入（fullData=true）
 *   2. 巡演其它站：概要 upsert（不覆盖已有完整数据，只刷新状态字段）
 *   3. 所有同巡演项的 stations 清单同步为最新
 * @returns 受影响条目清单 [{ itemId, full, created|updated }]
 */
function mergeIntoCatalog(cat, item) {
  if (!cat || typeof cat !== 'object') cat = { items: [] };
  if (!Array.isArray(cat.items)) cat.items = [];
  const now = new Date().toISOString();
  const touched = [];

  // 1) 当前站完整写入
  const curId = String(item.itemId || '');
  const curIdx = cat.items.findIndex((x) => String(x.itemId || '') === curId);
  const curRecord = {
    ...(curIdx >= 0 ? cat.items[curIdx] : {}),
    ...item,
    id: `st-${curId}`,
    updatedAt: now,
  };
  if (curIdx >= 0) cat.items[curIdx] = curRecord; else cat.items.push(curRecord);
  touched.push({ itemId: curId, full: true, created: curIdx < 0 });

  // 2) 其它站概要 upsert
  for (const st of item.stations || []) {
    const sid = String(st.itemId || '');
    if (!sid || sid === curId) continue;
    const idx = cat.items.findIndex((x) => String(x.itemId || '') === sid);
    if (idx >= 0) {
      const rec = cat.items[idx];
      rec.tourId = item.tourId || rec.tourId || '';
      rec.tourName = item.tourName || rec.tourName || '';
      rec.saleStatus = st.saleStatus || rec.saleStatus || '';
      rec.status = st.saleStatus || rec.status || '';
      rec.stationShowTime = st.showTime || rec.stationShowTime || '';
      rec.stationName = st.stationName || rec.stationName || '';
      if (!rec.fullData) {
        rec.id = rec.id || `st-${sid}`;
        rec.name = rec.name || `${item.tourName || ''}- ${st.stationName || ''}`.trim();
      }
      rec.updatedAt = now;
      touched.push({ itemId: sid, full: false, updated: true });
    } else {
      cat.items.push({
        id: `st-${sid}`,
        itemId: sid,
        projectId: item.projectId || '',
        tourId: item.tourId || '',
        tourName: item.tourName || '',
        stationName: st.stationName || '',
        name: `${item.tourName || ''}- ${st.stationName || ''}`.trim(),
        city: '',
        venue: '',
        showTime: '',
        stationShowTime: st.showTime || '',
        saleStatus: st.saleStatus || '',
        status: st.saleStatus || '',
        priceRange: '',
        purchaseLimit: '',
        saleTimeHints: [],
        fullData: false,
        source: 'damai-tour-index',
        sessions: [],
        priceTiers: [],
        updatedAt: now,
      });
      touched.push({ itemId: sid, full: false, created: true });
    }
  }

  // 3) 同步同巡演项的 stations 清单
  for (const rec of cat.items) {
    if (item.tourId && String(rec.tourId || '') === String(item.tourId) && Array.isArray(item.stations)) {
      rec.stations = item.stations;
    }
  }

  cat.updatedAt = now;
  return touched;
}

/* ==================== 主入口 ==================== */

async function probeItem(targetId, opts = {}) {
  const raw = String(targetId || '').trim();
  if (!raw) throw new Error('请提供演出 ID');
  // 支持直接粘贴链接/口令文本，从中提取数字 ID
  if (!/^\d{6,}$/.test(raw)) {
    const m = raw.match(/(\d{6,})/);
    if (!m) throw new Error(`无法从 "${raw}" 中提取演出 ID`);
    return probeItem(m[1], opts);
  }
  const payload = await fetchDetailPayload(raw, opts);
  if (!payload) {
    throw new Error(`未能获取演出 ${raw} 的详情数据（页面未返回有效响应，可能 ID 有误或网络异常）`);
  }
  const item = parseDetailPayload(payload);
  if (!item.itemId) throw new Error(`演出 ${raw} 详情解析失败`);
  return item;
}

async function main() {
  const args = process.argv.slice(2);
  let targetId = '';
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--id' || args[i] === '--item') && args[i + 1]) targetId = args[i + 1];
  }
  if (!targetId) {
    console.log('用法: node platforms/damai/probe-damai.mjs --id <演出ID或链接>');
    process.exit(1);
  }

  console.log('============================================================');
  console.log('📡 大麦演出探针 v2（真实采集 · 含巡演多站）');
  console.log('============================================================');

  const item = await probeItem(targetId);
  console.log(`✅ ${item.name}`);
  console.log(`   站点: ${item.stationName || '?'} | 状态: ${item.saleStatus || '?'} | 日期: ${item.showTime || '?'}`);
  console.log(`   场馆: ${item.venue || '?'} | 价格: ${item.priceRange || '?'} | 限购: ${item.purchaseLimit || '?'}`);
  if (item.tourId) {
    console.log(`   巡演: ${item.tourName} (tourId=${item.tourId})，共 ${item.stations.length} 站:`);
    item.stations.forEach((s) => console.log(`     * ${s.stationName} [${s.saleStatus || '?'}] ${s.showTime || ''} (itemId=${s.itemId})${s.current ? ' ← 本次' : ''}`));
  }
  console.log(`   日期场次 (${item.sessions.length}):`);
  item.sessions.forEach((s) => console.log(`     * ${s.name}`));
  if (item.saleTimeHints.length) console.log(`   开售提示: ${item.saleTimeHints.join('; ')}`);

  const cat = loadCatalog();
  const touched = mergeIntoCatalog(cat, item);
  saveCatalog(cat);
  console.log(`[合并完成] 本次影响 ${touched.length} 个条目: ${touched.map((t) => t.itemId + (t.full ? '(全量)' : '(概要)')).join(', ')}`);
}

if (process.argv[1] && process.argv[1].endsWith('probe-damai.mjs')) {
  main().catch((e) => {
    console.error(`❌ 探针失败: ${e.message}`);
    process.exit(1);
  });
}

export {
  probeItem,
  parseDetailPayload,
  mergeIntoCatalog,
  deriveTourName,
  deriveStationName,
  loadCatalog,
  saveCatalog,
};
