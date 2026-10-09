/**
 * SKU 状态统一推导（纯函数，无副作用）
 * =====================================================================
 * 为什么要有这个文件（2026-10-09 修复"缺货有的商品显示、有的不显示"）：
 *
 *   以前"能不能买"只看 __NEXT_DATA__ 里的 buttonMode（SSR 快照），
 *   "库存多少"只看旁听 querySkuInventoryV2 的响应。两个字段经常打架：
 *     · Pura X View / Mate 90 Pro / Pura X Max 都有一批 SKU：buttonMode=1
 *       （现货可买）但库存接口返回 0 —— 页面快照说能买，实时库存说没货；
 *     · Mate XT 2 有 4 个 SKU：挂在 rushBuySkuCodes 名单里（SSR 静态），
 *       但 queryRushbuyInfo 里没有它的场次 —— 显示"抢购未开售"，
 *       实际根本不在下一次开售名单里，选了也白选。
 *   面板按不同字段渲染，就出现"有的商品显示缺货、有的不显示"。
 *
 * 规则（优先级从高到低）：
 *   1. inventoryQty === 0                 → 缺货（实时库存是地面真值，压过一切快照）
 *   2. 场次（queryRushbuyInfo）：
 *      · 开始时间在未来                    → 待抢购（未开售）   sessionState=upcoming
 *      · 活动窗口内（开始≤现在<结束）       → 抢购进行中         sessionState=live
 *      · 已结束                           → 场次已结束         sessionState=ended
 *   3. 在抢购名单（rushBuySkuCodes）但没有场次 → 无场次（抢不了）  sessionState=none
 *   4. buttonMode 映射（现货可买/即将开售/缺货/预约中…）
 *   5. 都没有                             → 未知
 *
 * 约定：写入统一字段 statusText / buyable / sessionState；
 *      buttonMode 的原始映射保留在 buyableNow / buyableText（不改写，留作排查）。
 * =====================================================================
 */

/** 平台 buttonMode 数值含义（以页面渲染为准的映射，未知值原样透出不硬套） */
export const BUTTON_MODE_LABEL = {
  1: { text: '现货可买', buyable: true },
  2: { text: '即将开售', buyable: false },
  3: { text: '现货可买', buyable: true },
  9: { text: '缺货', buyable: false },
  10: { text: '缺货', buyable: false },
  29: { text: '抢购未开售', buyable: false },
  31: { text: '预约中', buyable: false },
};

/**
 * 推导一个 SKU 的统一状态。
 * @param {object} sku  采集后的 SKU（含 buttonMode / inventoryQty / rushBuy / isRushBuySku）
 * @param {number|null} serverNowMs  平台服务器当前时间（毫秒）；没有就退回本机钟
 * @returns {{ statusText: string, buyable: boolean, sessionState: 'upcoming'|'live'|'ended'|'none'|null,
 *              oos: boolean, source: string }}
 *   source = 结论依据（'inventory' / 'session' / 'rush-list' / 'buttonMode' / 'unknown'），排查用
 */
export function deriveSkuStatus(sku, serverNowMs = null) {
  const now = Number.isFinite(serverNowMs) && serverNowMs > 0 ? serverNowMs : Date.now();

  // ① 实时库存为 0 = 缺货（最高优先级，压过 buttonMode 快照）
  if (sku.inventoryQty === 0) {
    return { statusText: '缺货', buyable: false, sessionState: sessionStateOf(sku, now), oos: true, source: 'inventory' };
  }

  // ② 抢购场次状态（queryRushbuyInfo 的 startTime/endTime 是平台权威口径）
  const rb = sku.rushBuy || null;
  if (rb && rb.startTimeMs != null && rb.startTimeMs > 1e12) {
    const endMs = rb.endTimeMs != null && rb.endTimeMs > 1e12 ? rb.endTimeMs : null;
    if (rb.startTimeMs > now) {
      return { statusText: '抢购未开售', buyable: false, sessionState: 'upcoming', oos: false, source: 'session' };
    }
    if (endMs == null || endMs > now) {
      // 活动窗口内：能不能立刻买仍以按钮为准（窗口内可能要排队/可能已抢完）
      const bm = buttonModeOf(sku);
      return {
        statusText: bm && bm.buyable ? '现货可买（抢购进行中）' : '抢购进行中',
        buyable: !!(bm && bm.buyable),
        sessionState: 'live',
        oos: false,
        source: 'session',
      };
    }
    // 场次已结束：若按钮已是现货形态则照常显示可买，否则明确"已结束"而不是误导性的"未开售"
    const bm = buttonModeOf(sku);
    if (bm && bm.buyable) {
      return { statusText: '现货可买', buyable: true, sessionState: 'ended', oos: false, source: 'session' };
    }
    return { statusText: '场次已结束', buyable: false, sessionState: 'ended', oos: false, source: 'session' };
  }

  // ③ 在抢购名单里但没有任何场次 —— 不在开售名单，选了也白选
  if (rb === null && sku.isRushBuySku === true) {
    return { statusText: '无场次（不在开售名单）', buyable: false, sessionState: 'none', oos: false, source: 'rush-list' };
  }

  // ④ buttonMode 映射；⑤ 未识别
  const bm = buttonModeOf(sku);
  if (bm) {
    return { statusText: bm.text, buyable: bm.buyable, sessionState: sessionStateOf(sku, now), oos: bm.text.includes('缺货'), source: 'buttonMode' };
  }
  return { statusText: '未知', buyable: false, sessionState: null, oos: false, source: 'unknown' };
}

function buttonModeOf(sku) {
  if (sku.buttonMode == null) return null;
  return BUTTON_MODE_LABEL[Number(sku.buttonMode)] || null;
}

/** 没有场次数据时给 sessionState 一个保守值：有 rushBuy 记录但读不出时间 = 'none'，否则 null */
function sessionStateOf(sku, now) {
  const rb = sku.rushBuy || null;
  if (rb && rb.startTimeMs != null && rb.startTimeMs > 1e12) {
    const endMs = rb.endTimeMs != null && rb.endTimeMs > 1e12 ? rb.endTimeMs : null;
    if (rb.startTimeMs > now) return 'upcoming';
    if (endMs == null || endMs > now) return 'live';
    return 'ended';
  }
  return rb ? 'none' : null;
}

/**
 * 商品级"下一次开售"汇总：取所有 SKU 里最近的一个未来场次。
 * 返回 null = 该商品没有任何待开售场次。
 */
export function deriveNextSale(skus, serverNowMs = null) {
  const now = Number.isFinite(serverNowMs) && serverNowMs > 0 ? serverNowMs : Date.now();
  let best = null;
  for (const s of skus || []) {
    const rb = s.rushBuy;
    if (!rb || rb.startTimeMs == null || !(rb.startTimeMs > 1e12) || !(rb.startTimeMs > now)) continue;
    if (!best || rb.startTimeMs < best.startTimeMs) {
      best = { startTimeMs: rb.startTimeMs, startTime: rb.startTime || null, endTimeMs: rb.endTimeMs ?? null, endTime: rb.endTime || null, skuCodes: [] };
    }
  }
  if (!best) return null;
  for (const s of skus || []) {
    const rb = s.rushBuy;
    if (rb && rb.startTimeMs != null && rb.startTimeMs === best.startTimeMs) best.skuCodes.push(String(s.sbomCode ?? s.skuId));
  }
  return best;
}
