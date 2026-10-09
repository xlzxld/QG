/**
 * 抢购点击坐标方案验证 (2026-10-10)
 * =====================================================================
 * 标定来源: 用户三截图程序化测边 (图2 SKU抽屉/图3 确认页/图4 抢票弹窗), 标定分辨率 1080×2400。
 * 验证内容 (纯数学, 零副作用, 不碰设备):
 *   1. 统一锚点 (841,2310) 落在 立即预订/确定/立即提交 三键交集内
 *   2. 抖动上限 (X±100 / Y±40) 的随机落点 100% 仍在三键有效区域内 (含 6px 边缘安全余量)
 *   3. 「继续尝试」推算点 (540,1346) 落在弹窗按钮内, 且抖动后不碰下方「返回重新选购」(≥20px)
 *   4. 双流节拍: 主链 + 弹窗侧车共享 50ms 间距 → 任意 1 秒窗口合计 ≤20 击
 *   5. 控制台/中枢/手机端三处常量一致性护栏
 * 用法: node verify/verify-grab-points.mjs
 * =====================================================================
 */
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++; };

/* ---- 实测包围盒 (864×1920 截图 ×1.25 → 1080×2400) ---- */
const RECT = {
 确定:     { x1: 668, y1: 2244, x2: 1015, y2: 2375 },   // 图2 实测 x[534,812] y[1795,1900]
 立即提交:  { x1: 628, y1: 2245, x2: 1015, y2: 2375 },   // 图3 实测 x[502,812] y[1796,1900]
 立即预订:  { x1: 560, y1: 2245, x2: 1015, y2: 2375 },   // 无截图: 右缘对齐 + 旧标定点 682,2305 落内 (假设, 见报告)
 // 图4 来自另一台设备, 弹窗按钮只能跨设备推算 → 两条路径取交集作为"必中区":
 继续尝试A: { x1: 141, y1: 1284, x2: 939, y2: 1408 },    // 路径A: 按提交键宽比例换算 (中心 y≈1346)
 继续尝试B: { x1: 200, y1: 1355, x2: 880, y2: 1480 },    // 路径B: 弹窗垂直居中 + 同宽高比换算 (中心 y≈1418)
};
const BACK_TEXT_TOP = 1439;          // 「返回重新选购」文本顶 (两条路径中更保守/更严的一条)
const ANCHOR = { x: 841, y: 2310 };
const CAP = { x: 100, y: 40 };
const POPUP_PT = { x: 540, y: 1382 };     // 两路径推算的交集中心
const POPUP_CAP = { x: 80, y: 18 };
const INSET = 6;                     // 边缘安全余量 (圆角/描边)

const inside = (pt, r, inset = INSET) =>
  pt.x >= r.x1 + inset && pt.x <= r.x2 - inset && pt.y >= r.y1 + inset && pt.y <= r.y2 - inset;

function jitterAt(center, cap, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ x: center.x + Math.round((Math.random() * 2 - 1) * cap.x),
               y: center.y + Math.round((Math.random() * 2 - 1) * cap.y) });
  }
  return pts;
}

/* ---- 1. 统一锚点命中三键 ---- */
console.log('=== 1. 统一锚点 ===');
for (const name of ['立即预订', '确定', '立即提交']) {
  ok(inside(ANCHOR, RECT[name]), `锚点 (${ANCHOR.x},${ANCHOR.y}) 落在「${name}」内`);
}
// 旧标定点也应在交集内 (连续性)
ok(inside({ x: 682, y: 2305 }, RECT['确定']) && inside({ x: 682, y: 2305 }, RECT['立即提交']),
  '旧标定点 682,2305 仍落在 确定/立即提交 内 (向后兼容)');

/* ---- 2. 抖动上限下的命中率 (蒙特卡洛) ---- */
console.log('\n=== 2. 抖动落点模拟 (蒙特卡洛 20 万发/组) ===');
for (const [tag, cap] of [['上限 X±100/Y±40', CAP], ['推荐 X±40/Y±16', { x: 40, y: 16 }], ['旧默认 X±3/Y±3', { x: 3, y: 3 }]]) {
  const pts = jitterAt(ANCHOR, cap, 200000);
  let hit = 0;
  for (const p of pts) if (inside(p, RECT['确定']) && inside(p, RECT['立即提交']) && inside(p, RECT['立即预订'])) hit++;
  const rate = (hit / pts.length * 100).toFixed(4);
  ok(hit === pts.length, `${tag}: 命中三键交集 ${rate}% (${hit}/${pts.length})`);
}
// 单键最紧约束 = 确定 (最窄): 单独验证
{
  const pts = jitterAt(ANCHOR, CAP, 200000);
  const miss = pts.filter((p) => !inside(p, RECT['确定']));
  ok(miss.length === 0, `最紧约束「确定」零出界 (出界 ${miss.length} 发)`);
}

/* ---- 3. 弹窗按钮: 推算点 + 抖动 + 避开「返回重新选购」 ---- */
console.log('\n=== 3. 继续尝试 (弹窗, 双路径交集) ===');
ok(inside(POPUP_PT, RECT['继续尝试A']) && inside(POPUP_PT, RECT['继续尝试B']),
  `推算点 (${POPUP_PT.x},${POPUP_PT.y}) 同时落在两条推算路径的按钮区内`);
{
  const pts = jitterAt(POPUP_PT, POPUP_CAP, 200000);
  let hitA = 0, hitB = 0, minGap = Infinity;
  for (const p of pts) {
    if (inside(p, RECT['继续尝试A'])) hitA++;
    if (inside(p, RECT['继续尝试B'])) hitB++;
    minGap = Math.min(minGap, BACK_TEXT_TOP - p.y);
  }
  ok(hitA === pts.length, `抖动 X±${POPUP_CAP.x}/Y±${POPUP_CAP.y}: 路径A 按钮内 ${(hitA / pts.length * 100).toFixed(4)}%`);
  ok(hitB === pts.length, `抖动 X±${POPUP_CAP.x}/Y±${POPUP_CAP.y}: 路径B 按钮内 ${(hitB / pts.length * 100).toFixed(4)}%`);
  ok(minGap >= 20, `距「返回重新选购」最小间距 ${minGap}px (要求 ≥20px, 绝不误触返回)`);
}
{
  // 敏感性对照: 若把抖动放大到 Y±40 就会触线 → 证明内置上限 Y±18 必须收紧、不可调大
  const pts = jitterAt(POPUP_PT, { x: 120, y: 40 }, 50000);
  const bad = pts.filter((p) => BACK_TEXT_TOP - p.y < 20).length;
  ok(bad > 0, `反证: Y±40 会触「返回重新选购」(触线 ${bad} 发) → 内置上限 Y±18 不可调大`);
}

/* ---- 4. 双流节拍: 主链 12/s + 侧车 ≤13/s, 共享 50ms 间距 → 合计 ≤20/s ---- */
console.log('\n=== 4. 双流节拍合成 ===');
{
  // 模拟: 主链间隔 55~85ms, 侧车每 60ms 轮询且命中时插入一击; 全局 50ms 互斥间距
  let lastAt = -1e9, sideLast = -1e9;
  const stamps = [];
  let t = 0;
  let sideHits = 0;
  for (t = 0; t < 5000; t += 1) {
    if (t - lastAt >= 55 + Math.random() * 30) {   // 主链想击发
      const fireAt = Math.max(t, lastAt + 50, sideLast + 50);
      stamps.push(fireAt); lastAt = fireAt;
    }
    if (t % 60 === 0 && t >= 300) {                // 侧车命中弹窗
      const fireAt = Math.max(t, lastAt + 50, sideLast + 50);
      if (fireAt === t || fireAt - sideLast >= 50) { stamps.push(fireAt); sideLast = fireAt; sideHits++; }
    }
  }
  let peak = 0;
  stamps.sort((a, b) => a - b);
  for (let i = 0; i < stamps.length; i++) {
    let c = 0;
    for (let k = i; k < stamps.length && stamps[k] - stamps[i] < 1000; k++) c++;
    peak = Math.max(peak, c);
  }
  ok(peak <= 20, `5 秒合成击发峰值 ${peak} 击/秒 ≤ 20 (侧车插入 ${sideHits} 击)`);
}

/* ---- 5. 三处常量一致性 (源码护栏) ---- */
console.log('\n=== 5. 常量一致性护栏 ===');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const damaiSrc = fs.readFileSync(path.join(ROOT, 'platforms/app/agent/adapters/damai.js'), 'utf8');
const hubSrc = fs.readFileSync(path.join(ROOT, 'core/device-hub.mjs'), 'utf8');
const consoleSrc = fs.readFileSync(path.join(ROOT, 'web/hub-console.html'), 'utf8');
ok(damaiSrc.includes('anchor: { x: 841, y: 2310 }') && damaiSrc.includes('x: 540, y: 1382'), '手机端: 锚点/弹窗点常量在位');
ok(damaiSrc.includes('jitterCap: { x: 100, y: 40 }'), '手机端: 抖动上限常量在位');
ok(damaiSrc.includes('startChainSidecar') && damaiSrc.includes('CHAIN_CTL.stop'), '手机端: 侧车线程 + 主链停止旗标在位');
ok(damaiSrc.includes('markTapFired') && damaiSrc.includes('waitTapSlot'), '手机端: 全局击发间距在位 (双流 ≤20/秒)');
ok(hubSrc.includes('popup: validXY(ig.popup)'), '中枢: grab.popup 白名单透传');
ok(hubSrc.includes('0, 100, 3') && hubSrc.includes('0, 40, 3'), '中枢: 抖动 clamp 与几何上限一致 (X100/Y40)');
ok(consoleSrc.includes("placeholder=\"841,2310\"") && consoleSrc.includes("placeholder=\"540,1382\""), '控制台: 锚点/弹窗默认坐标在位');
ok(consoleSrc.includes('grab-popup-xy'), '控制台: 弹窗坐标输入框在位');

console.log(failed === 0 ? '\n🎉 全部通过' : `\n⚠️ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
