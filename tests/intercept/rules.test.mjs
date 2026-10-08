import { describe, it, expect } from 'vitest';
import { rewriteRushInfo, dryRunRushInfo, MATCH, PATTERNS } from '../../platforms/huawei/intercept/rules.mjs';

/** 构造一份与 vmall 线上形状一致的响应体 */
const body = (startTime, extra = {}) =>
  JSON.stringify({ currentTime: 1791425280000, skuRushBuyInfoList: [{ sbomCode: 'X1', startTime, ...extra }] });

describe('rewriteRushInfo（R1 抢购信息提前解锁）', () => {
  it('毫秒时间戳：提前 leadMs，类型保持数字', () => {
    const out = rewriteRushInfo(body(1791425280000), { leadMs: 300 });
    const j = JSON.parse(out);
    expect(j.skuRushBuyInfoList[0].startTime).toBe(1791425279700);
    expect(typeof j.skuRushBuyInfoList[0].startTime).toBe('number');
  });

  it('字符串毫秒时间戳：输出仍是字符串', () => {
    const out = rewriteRushInfo(body('1791425280000'), { leadMs: 500 });
    const j = JSON.parse(out);
    expect(j.skuRushBuyInfoList[1 - 1].startTime).toBe('1791425279500');
  });

  it('秒级时间戳：按 leadMs/1000 提前', () => {
    const out = rewriteRushInfo(body(1791425280), { leadMs: 2000 });
    const j = JSON.parse(out);
    expect(j.skuRushBuyInfoList[0].startTime).toBeCloseTo(1791425278, 6);
  });

  it('ISO 字符串：输出 ISO', () => {
    const out = rewriteRushInfo(body('2026-10-09T10:08:00.000Z'), { leadMs: 1000 });
    const j = JSON.parse(out);
    expect(j.skuRushBuyInfoList[0].startTime).toBe('2026-10-09T10:07:59.000Z');
  });

  it('currentTime 不动（倒计时基准不能乱）', () => {
    const j = JSON.parse(rewriteRushInfo(body(1791425280000), { leadMs: 300 }));
    expect(j.currentTime).toBe(1791425280000);
  });

  it('列表里其它字段原样保留', () => {
    const out = rewriteRushInfo(body(1791425280000, { endTime: 1791430000000, limitNum: 1 }), { leadMs: 300 });
    const j = JSON.parse(out);
    expect(j.skuRushBuyInfoList[0].endTime).toBe(1791430000000);
    expect(j.skuRushBuyInfoList[0].limitNum).toBe(1);
    expect(j.skuRushBuyInfoList[0].sbomCode).toBe('X1');
  });

  it('多个 SKU 一起改', () => {
    const raw = JSON.stringify({
      skuRushBuyInfoList: [
        { sbomCode: 'A', startTime: 1791425280000 },
        { sbomCode: 'B', startTime: 1791425300000 },
      ],
    });
    const j = JSON.parse(rewriteRushInfo(raw, { leadMs: 100 }));
    expect(j.skuRushBuyInfoList[0].startTime).toBe(1791425279900);
    expect(j.skuRushBuyInfoList[1].startTime).toBe(1791425299900);
  });

  // ── 坏包回退：宁可不动，绝不弄坏页面 ──
  it('非 JSON → null（原样放行）', () => {
    expect(rewriteRushInfo('<html>gateway error</html>', { leadMs: 300 })).toBeNull();
    expect(rewriteRushInfo('', { leadMs: 300 })).toBeNull();
  });

  it('无 skuRushBuyInfoList / 空列表 → null', () => {
    expect(rewriteRushInfo(JSON.stringify({ foo: 1 }), { leadMs: 300 })).toBeNull();
    expect(rewriteRushInfo(JSON.stringify({ skuRushBuyInfoList: [] }), { leadMs: 300 })).toBeNull();
  });

  it('所有条目都没有 startTime → null', () => {
    expect(rewriteRushInfo(JSON.stringify({ skuRushBuyInfoList: [{ sbomCode: 'A' }] }), { leadMs: 300 })).toBeNull();
  });

  it('唯一条目语义不明（既非毫秒也非秒）→ 整体 null 原样放行', () => {
    // 没有任何可改字段时返回 null，由安装层放行原始响应体（该字段保持原值）
    expect(rewriteRushInfo(body(5), { leadMs: 300 })).toBeNull();
  });

  it('唯一条目不可解析的字符串日期 → 整体 null 原样放行', () => {
    expect(rewriteRushInfo(body('not-a-date'), { leadMs: 300 })).toBeNull();
  });

  it('混合：语义不明的条目不动，正常条目照改', () => {
    const raw = JSON.stringify({
      skuRushBuyInfoList: [
        { sbomCode: 'A', startTime: 1791425280000 },
        { sbomCode: 'B', startTime: 5 },
      ],
    });
    const j = JSON.parse(rewriteRushInfo(raw, { leadMs: 300 }));
    expect(j.skuRushBuyInfoList[0].startTime).toBe(1791425279700);
    expect(j.skuRushBuyInfoList[1].startTime).toBe(5);
  });

  it('leadMs=0 → null（关闭 R1）；不传 leadMs → 默认 300 生效', () => {
    expect(rewriteRushInfo(body(1791425280000), { leadMs: 0 })).toBeNull();
    const j = JSON.parse(rewriteRushInfo(body(1791425280000), {}));
    expect(j.skuRushBuyInfoList[0].startTime).toBe(1791425279700);
  });
});

describe('dryRunRushInfo（体检干跑）', () => {
  it('返回 before/after 样本', () => {
    const r = dryRunRushInfo(body(1791425280000), 500);
    expect(r.leadMs).toBe(500);
    expect(r.sample.before).toBe(1791425280000);
    expect(r.sample.after).toBe(1791425279500);
  });

  it('形状不符返回 null', () => {
    expect(dryRunRushInfo('oops', 500)).toBeNull();
    expect(dryRunRushInfo(JSON.stringify({ skuRushBuyInfoList: [] }), 500)).toBeNull();
  });

  it('不修改入参字符串', () => {
    const raw = body(1791425280000);
    dryRunRushInfo(raw, 300);
    expect(JSON.parse(raw).skuRushBuyInfoList[0].startTime).toBe(1791425280000);
  });
});

describe('匹配器与 CDP 模式', () => {
  it('MATCH.rushInfo 命中真实 URL 形态', () => {
    expect(MATCH.rushInfo.test('https://buy.vmall.com/queryRushbuyInfo.json?sbomCodes=X1')).toBe(true);
    expect(MATCH.rushInfo.test('https://buy.vmall.com/other.json')).toBe(false);
  });

  it('MATCH.queue 命中排队页/排队脚本', () => {
    expect(MATCH.queue.test('https://sale.vmall.com/rushbuy2/1.0.2/js/queue.js')).toBe(true);
    expect(MATCH.queue.test('https://sale.vmall.com/queue.html')).toBe(true);
    expect(MATCH.queue.test('https://www.vmall.com/product/comdetail/index.html')).toBe(false);
  });

  it('PATTERNS 只覆盖目标 URL', () => {
    expect(PATTERNS.rushInfo).toContain('queryRushbuyInfo.json');
    expect(PATTERNS.queue.length).toBe(2);
  });
});
