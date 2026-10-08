/**
 * vmall 官方接口探测（Node 侧，免鉴权，2026-10-07 实测可用）
 * =====================================================================
 * cdp-rush.mjs（抢购）和 checkup-vmall.mjs（体检）共用的一套接口读取，
 * 字段解析只写这一份，避免两处实现漂移。只旁听官方公开接口，不构造、
 * 不重放、不带任何账号凭据。
 *
 *   https://openapi.vmall.com/serverTime.json                   → serverTimeMs
 *   https://buy.vmall.com/queryRushbuyInfo.json?sbomCodes=<SKU> → currentTime + 各 SKU startTime/endTime
 *
 * 时间口径：一律以华为服务器钟为准（NTP 中点法 + 中位数）。
 * offset = 本地中点(t0+t1)/2 − 服务器时间。offset>0 = 本地钟快；serverNow = Date.now() − offset。
 * 参考实现：lov3smu/hw_seckill、bytehola/vmall_huawei_seckill。
 * =====================================================================
 */

import { sleep } from './cdp-core.mjs';

export const TIME_APIS = [
  'https://openapi.vmall.com/serverTime.json',
  'https://buy.vmall.com/queryRushbuyInfo.json?sbomCodes=0',
];

export async function probeServerTime(ua) {
  for (const api of TIME_APIS) {
    try {
      const t0 = Date.now();
      const res = await fetch(api, {
        headers: { 'user-agent': ua || 'Mozilla/5.0', referer: 'https://www.vmall.com/' },
        signal: AbortSignal.timeout(3000),
      });
      const j = await res.json();
      const t1 = Date.now();
      const s = Number(j.serverTimeMs ?? j.currentTime ?? j.serverTime);
      if (s > 1e12) return { s, t0, t1 };
    } catch { /* 换下一个接口 */ }
  }
  return null;
}

/** 采 samples 个样本。先预热一次连接（建连/TLS 不计入测量）。
 *  2026-10-08 起：取「RTT 最小样本」的偏差（NTP 最佳实践——RTT 越小，往返中点
 *  越接近真实时钟差；中位数会被慢样本拖偏），并保留全部样本做离散度日志。 */
export async function calibrateClock(ua, log, samples = 5) {
  await probeServerTime(ua); // 预热
  const offs = [];
  for (let i = 0; i < samples; i++) {
    const p = await probeServerTime(ua);
    if (p) offs.push({ offset: (p.t0 + p.t1) / 2 - p.s, rtt: p.t1 - p.t0 });
    await sleep(120);
  }
  if (!offs.length) return null;
  offs.sort((a, b) => a.rtt - b.rtt);
  const best = offs[0];
  const median = offs[Math.floor(offs.length / 2)].offset;
  const spread = Math.round(offs[offs.length - 1].offset - offs[0].offset);
  const pick = Math.round(best.offset);
  log?.(`服务器钟校准：本地钟${pick >= 0 ? '快' : '慢'} ${Math.abs(pick)}ms（${offs.length} 样本，取最小RTT ${best.rtt}ms 样本；中位数口径 ${Math.round(median)}ms，离散 ${spread}ms）。开售触发按服务器钟执行。`);
  return { offsetMs: pick, samples: offs.length, spreadMs: spread, bestRttMs: Math.round(best.rtt) };
}

/** 抓原始响应文本（体检用：拿到线上真实形状，供 R1 规则干跑）。失败返回 null。 */
export async function fetchRushbuyInfoRaw(sbomCode, ua) {
  try {
    const res = await fetch(`https://buy.vmall.com/queryRushbuyInfo.json?sbomCodes=${encodeURIComponent(sbomCode)}`, {
      headers: { 'user-agent': ua || 'Mozilla/5.0', referer: 'https://www.vmall.com/' },
      signal: AbortSignal.timeout(3000),
    });
    return { url: res.url, text: await res.text() };
  } catch { return null; }
}

/**
 * 抓一帧 SKU 抢购状态接口（免鉴权）。
 * 用途：① 拿官方开售 startTime；② 开售前后各拍一帧，对比按钮为何没自动解锁
 * （页面自动变 vs 需要重新拉数据——网上“疯狂切 SKU”视频的原理就是切规格强制
 * 页面重新拉这份数据）。拿不到返回 null。
 */
export async function probeRushbuyInfo(sbomCode, ua) {
  const raw = await fetchRushbuyInfoRaw(sbomCode, ua);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw.text);
    const list = j.skuRushBuyInfoList || [];
    return {
      serverNowMs: j.currentTime != null ? Number(j.currentTime) : null,
      item: list.find((x) => String(x.sbomCode) === String(sbomCode)) || list[0] || null,
    };
  } catch { return null; }
}

/** 查 SKU 的官方开售时刻（服务器钟毫秒时间戳）。拿不到返回 null。 */
export async function fetchSaleStartServerMs(sbomCode, ua) {
  const p = await probeRushbuyInfo(sbomCode, ua);
  if (!p || !p.item || p.item.startTime == null) return null;
  let ms = Number(p.item.startTime);
  if (!Number.isFinite(ms)) ms = Date.parse(String(p.item.startTime));
  else if (ms < 1e12) ms *= 1000; // 秒级时间戳
  return Number.isFinite(ms) && ms > 1e12 ? ms : null;
}
