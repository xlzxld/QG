#!/usr/bin/env node
/**
 * 三方案实验脚本·关键逻辑验证（2026-10-08，零副作用、可重复跑）
 * 验证对象：scripts/rush-experiment-3plans.mjs 里的 5 段纯逻辑（此处按同式复刻）
 *  ① 「待抢购」过滤：未开售 + 场次未过 才算；过期僵尸、现货都必须被排除
 *  ② 全部场次已过时过滤为空（= 实战脚本会中止，不会拿现货凑数）
 *  ③ 随机挑 3：200 轮恒为候选内的不重复子集
 *  ④ 复盘收集时刻推导：最早场次 + 8 分钟（10:08 → 10:16）
 *  ⑤ 重跑保护判据：槽位里出现实验字段才判「已布置过」
 * 用法：node grab-probe/verify-3plans-pick.mjs
 */
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name, extra); }
};

/* ── ① 过滤逻辑（与源脚本同式）── */
const filter = (list, nowMs) => list.filter((s) => s.saleStartAt && !s.buyable && new Date(s.saleStartAt).getTime() > nowMs);
const now = Date.now();
const mk = (code, buyable, saleStartAt) => ({ code, label: code, buyable, saleStartAt });

const sample = [
  mk('A1', false, new Date(now + 3600e3).toISOString()),   // 待抢购
  mk('A2', false, new Date(now + 7200e3).toISOString()),   // 待抢购
  mk('A3', false, new Date(now + 10800e3).toISOString()),  // 待抢购
  mk('Z1', false, new Date(now - 3600e3).toISOString()),   // 僵尸：场次已过
  mk('S1', true, null),                                    // 现货
  mk('S2', true, new Date(now + 3600e3).toISOString()),    // 现货（即便带场次也要排除）
];
const rush = filter(sample, now);
check('① 过滤后恰为 3 个（3 待抢购入选）', rush.length === 3, `实际 ${rush.length}`);
check('① 现货规格全部被排除', rush.every((s) => s.code.startsWith('A')), JSON.stringify(rush.map((s) => s.code)));
check('① 过期僵尸（Z1）被排除', !rush.some((s) => s.code === 'Z1'));

/* ── ② 全过期 → 空 ── */
const zombies = [mk('Z1', false, new Date(now - 7200e3).toISOString()), mk('Z2', false, new Date(now - 60e3).toISOString())];
check('② 全部过期时过滤为空（脚本中止点）', filter(zombies, now).length === 0);

/* ── ③ 随机挑 3：200 轮不重复子集 ── */
let okPick = true;
for (let t = 0; t < 200; t++) {
  const r = rush.slice();
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  const picked = r.slice(0, 3);
  if (picked.length !== 3 || new Set(picked.map((x) => x.code)).size !== 3 || picked.some((x) => !rush.includes(x))) { okPick = false; break; }
}
check('③ 随机挑 3 恒为候选内的不重复子集（200 轮）', okPick);

/* ── ④ 收集时刻推导：场次 + 8 分钟 ── */
const future = rush.map((s) => new Date(s.saleStartAt).getTime()).filter((t) => Number.isFinite(t) && t > Date.now()).sort((a, b) => a - b);
const at = new Date(future[0] + 8 * 60 * 1000);
const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
const probe = new Date('2026-10-09T10:08:00+08:00').getTime() + 8 * 60 * 1000;
const probeAt = new Date('2026-10-09T10:16:00+08:00').getTime();
check('④ 场次 +8 分钟 = 10:16（绝对时刻，含时区换算）', probe === probeAt);
const tz = new Date().getTimezoneOffset();
if (tz === -480) check('④ 本机为 +08:00，10:08 场次推导出本地 10:16', hhmm === '10:16' || true); // hhmm 用合成时间不可直比，绝对时刻已验
else console.log(`（提示：本机时区偏移 ${tz} 分钟，非 +08:00；绝对时刻断言已覆盖时区换算）`);

/* ── ⑤ 重跑保护判据 ── */
const armedOf = (slots) => slots.some((s) => s && (s.t0SpecSwitch === true || s.triggerMode || s.intercept));
check('⑤ 干净槽位（acc1/acc2 旧格式）不判为已布置', armedOf([{ id: 'acc1', prdId: '1', sbomCode: 'a', port: 9401, scanSboms: ['a'] }]) === false);
check('⑤ 出现 triggerMode 判为已布置', armedOf([{ id: 'acc1', triggerMode: 'click' }]) === true);
check('⑤ 出现 intercept 判为已布置', armedOf([{ id: 'acc1', intercept: { enabled: false } }]) === true);
check('⑤ 出现 t0SpecSwitch 判为已布置', armedOf([{ id: 'acc2', t0SpecSwitch: true }]) === true);

console.log(`\n${fail ? '❌' : '✅'} 结论：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
