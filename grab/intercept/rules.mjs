/**
 * 响应改写规则（纯函数 + 匹配器，无副作用，可单测）
 * =====================================================================
 * 三条规则对应调研成熟脚本（bytehola/vmall_huawei_seckill、a6051529/vmall-rush-to-buy、
 * greasyfork 397649/393577）验证过的收益点，在「本机浏览器收到的内容」上做手脚，
 * 不构造、不重放、不伪造任何请求——所有网络流量仍由页面自己的代码发起。
 *
 *   R1 rushInfo    改写 queryRushbuyInfo.json：各 SKU 的 startTime 提前 leadMs
 *                  → 页面倒计时提前归零 → 购买按钮提前解锁（消灭「到点后才确认
 *                  解锁」的那一拍）。
 *   R2 queueCapture 排队页/排队脚本：目前只落盘留证 + 原样放行。真实排队页样本
 *                  从未到手（国内抢购排队页只在真实场次出现），不写盲改逻辑；
 *                  样本到手后在本文件迭代接管逻辑。
 *   R3 confirmSignal 确认订单页零延迟信号：不走 Fetch（新标签域名未知，全局
 *                  拦截代价大），改用浏览器级 Target.targetCreated 事件——
 *                  window.open 新开确认页的瞬间即知（在 cdp-rush.mjs 里实现）。
 *
 * 契约：
 *   · rewrite() 返回 null = 原样放行；返回字符串 = 用它替代响应体。
 *   · 任何解析失败 / 形状不符 / 语义不明 → 一律 null。宁可不动，绝不弄坏页面。
 *   · 本文件不 import 任何模块、不碰网络不碰磁盘。
 * =====================================================================
 */

/** CDP Fetch.enable 用的 URL 模式（只列目标 URL，页面其余请求零开销） */
export const PATTERNS = {
  rushInfo: '*://buy.vmall.com/queryRushbuyInfo.json*',
  queue: ['*://*.vmall.com/*queue*', '*://*.vmall.com/rushbuy2/*'],
};

/** 自家匹配器（不依赖 CDP 通配语义，规则内部判断用） */
export const MATCH = {
  rushInfo: /queryRushbuyInfo\.json/i,
  queue: /queue|rushbuy2\//i,
};

/**
 * R1：把 queryRushbuyInfo.json 里各 SKU 的 startTime 提前 leadMs。
 * 只动 startTime，不动 currentTime（倒计时 = startTime − currentTime，
 * 只提前 startTime 即可让倒计时提前归零；currentTime 是服务器钟基准，
 * 动了反而会搞乱页面其它逻辑）。
 *
 * 形态兼容（与 cdp-rush 的 fetchSaleStartServerMs 同一套判断）：
 *   · 毫秒时间戳（>1e12）/ 秒时间戳（>1e9）/ ISO 字符串；
 *   · 原始值是字符串就输出字符串，是数字就输出数字（不改变类型）。
 */
export function rewriteRushInfo(bodyText, { leadMs = 300 } = {}) {
  if (!(leadMs > 0)) return null;
  let j;
  try { j = JSON.parse(bodyText); } catch { return null; }
  const list = j && Array.isArray(j.skuRushBuyInfoList) ? j.skuRushBuyInfoList : null;
  if (!list || !list.length) return null;
  let touched = 0;
  for (const item of list) {
    if (!item || item.startTime == null) continue;
    const raw = item.startTime;
    const isStr = typeof raw === 'string';
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      const t = Date.parse(String(raw));
      if (!Number.isFinite(t)) continue; // 既不是数字也不是可解析日期：不动
      item.startTime = new Date(t - leadMs).toISOString();
      touched++;
      continue;
    }
    if (num > 1e12) {
      item.startTime = isStr ? String(num - leadMs) : num - leadMs; // 毫秒
    } else if (num > 1e9) {
      item.startTime = isStr ? String(num - leadMs / 1000) : num - leadMs / 1000; // 秒
    } else {
      continue; // 语义不明的数值（ neither 毫秒 nor 秒），不动
    }
    touched++;
  }
  return touched ? JSON.stringify(j) : null;
}

/**
 * R1 自检：对一份真实响应体做干跑，验证改写有效且 JSON 仍可解析、
 * 除 startTime 外字段原样。体检脚本用它离线验证规则对当前线上形状仍成立。
 * 返回 null = 规则不适用；否则返回 { leadMs, sample: { before, after } }。
 */
export function dryRunRushInfo(bodyText, leadMs = 300) {
  let j;
  try { j = JSON.parse(bodyText); } catch { return null; }
  if (!j || !Array.isArray(j.skuRushBuyInfoList) || !j.skuRushBuyInfoList.length) return null;
  const item = j.skuRushBuyInfoList.find((x) => x && x.startTime != null);
  if (!item) return null;
  const out = rewriteRushInfo(bodyText, { leadMs });
  if (out == null) return null;
  let after;
  try { after = JSON.parse(out); } catch { return null; }
  const b = item.startTime;
  const a = after.skuRushBuyInfoList.find((x) => x && x.startTime != null)?.startTime;
  return { leadMs, sample: { before: b, after: a } };
}
