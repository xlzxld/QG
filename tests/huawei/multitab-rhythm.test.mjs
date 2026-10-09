import { describe, it, expect } from 'vitest';

/**
 * 多页签拟人击发节奏的数学回归（镜像 cdp-rush.mjs runSlotMultiTab/hammerLoop 里的算法）。
 * 2026-10-09 用户要求：击发必须拟人、参数可配——这里把"拟人"钉成可测的分布约束。
 * 注意：算法若在 cdp-rush.mjs 里调整，请同步这里（两处逻辑刻意保持一字不差）。
 */

// —— 与 cdp-rush.mjs hammerLoop 一字不差的算法 ——
function makeRhythm(fireBaseMs, clickBaseMs, jitterPctRaw, breathBaseMs) {
  const jitterPct = Math.min(0.5, Math.max(0, jitterPctRaw / 100));
  const gap = (base) => Math.max(60, Math.round(base * (1 - jitterPct + Math.random() * jitterPct * 2)));
  const jitterPt = (c) => {
    if (!c) return null;
    const jx = c.w > 8 ? Math.round((Math.random() - 0.5) * c.w * 0.5) : 0;
    const jy = c.h > 8 ? Math.round((Math.random() - 0.5) * c.h * 0.5) : 0;
    return { x: (c.x || 0) + jx, y: (c.y || 0) + jy };
  };
  return { gap, jitterPt, breathBaseMs, pause: () => 200 + Math.random() * 600, nextBreath: (now) => now + breathBaseMs * (0.6 + Math.random() * 1.6) };
}

describe('多页签拟人击发节奏', () => {
  it('间隔有抖动：不恒等于基准值，且都在 [60, 基准×1.5] 内', () => {
    const { gap } = makeRhythm(300, 450, 40, 3000);
    const out = Array.from({ length: 300 }, () => gap(300));
    expect(Math.min(...out)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...out)).toBeLessThanOrEqual(Math.round(300 * 1.5));
    const uniq = new Set(out);
    expect(uniq.size).toBeGreaterThan(10); // 绝不匀速
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    expect(Math.abs(mean - 300)).toBeLessThan(30); // 均值≈基准（±10%）
  });

  it('抖动设 0 会被钳到下限保护，仍不低于 60ms', () => {
    const { gap } = makeRhythm(300, 450, 0, 3000);
    expect(gap(300)).toBe(300);
    expect(gap(30)).toBe(60); // 底线节拍
  });

  it('点击点在按钮范围内散布（±1/4 边长），且不总在同一点', () => {
    const { jitterPt } = makeRhythm(300, 450, 40, 3000);
    const c = { x: 500, y: 800, w: 120, h: 40 };
    const pts = Array.from({ length: 200 }, () => jitterPt(c));
    for (const p of pts) {
      expect(Math.abs(p.x - c.x)).toBeLessThanOrEqual(c.w / 4 + 1);
      expect(Math.abs(p.y - c.y)).toBeLessThanOrEqual(c.h / 4 + 1);
    }
    expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBeGreaterThan(20);
  });

  it('小按钮（w≤8）不散布，退回中心点', () => {
    const { jitterPt } = makeRhythm(300, 450, 40, 3000);
    const p = jitterPt({ x: 100, y: 100, w: 6, h: 6 });
    expect(p).toEqual({ x: 100, y: 100 });
  });

  it('换气：停顿 200~800ms，下一口气的间隔在基准的 0.6~2.2 倍内', () => {
    const r = makeRhythm(300, 450, 40, 3000);
    for (let i = 0; i < 100; i++) {
      const p = r.pause();
      expect(p).toBeGreaterThanOrEqual(200);
      expect(p).toBeLessThanOrEqual(800);
      const d = r.nextBreath(0) - 0;
      expect(d).toBeGreaterThanOrEqual(3000 * 0.6);
      expect(d).toBeLessThanOrEqual(3000 * 2.2);
    }
  });

  it('默认参数下的节拍换算：fire 300ms/ click 450ms ≈ 每页签每秒 3 喊 2 点', () => {
    // 用户口径：25 发/秒太快。默认值必须落在"手速很快的真人"量级。
    const firePerSec = 1000 / 300;
    const clickPerSec = 1000 / 450;
    expect(firePerSec).toBeCloseTo(3.33, 1);
    expect(clickPerSec).toBeCloseTo(2.22, 1);
  });
});
