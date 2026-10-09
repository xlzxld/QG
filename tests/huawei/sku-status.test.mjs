import { describe, it, expect } from 'vitest';
import { deriveSkuStatus, deriveNextSale, BUTTON_MODE_LABEL } from '../../platforms/huawei/sku-status.mjs';

// 固定"当前时间"，避免测试随墙钟漂移
const NOW = Date.parse('2026-10-09T16:00:00+08:00');
const T0_FUTURE = Date.parse('2026-10-10T10:08:00+08:00');
const T0_PAST = Date.parse('2026-10-09T10:08:00+08:00');
const T_END_PAST = Date.parse('2026-10-09T12:08:00+08:00');

describe('SKU 状态统一推导（2026-10-09 修复缺货显示不一致）', () => {
  it('库存 0 压过 buttonMode=1 的"现货可买"快照（Pura X View 实测案例）', () => {
    const d = deriveSkuStatus({ buttonMode: 1, inventoryQty: 0, isRushBuySku: false }, NOW);
    expect(d.statusText).toBe('缺货');
    expect(d.buyable).toBe(false);
    expect(d.oos).toBe(true);
    expect(d.source).toBe('inventory');
  });

  it('未来场次 → 待抢购（Mate XT 2 明天 10:08 案例）', () => {
    const d = deriveSkuStatus(
      { buttonMode: 29, inventoryQty: null, isRushBuySku: true, rushBuy: { startTimeMs: T0_FUTURE, startTime: 'x', endTimeMs: T0_FUTURE + 7200000 } },
      NOW,
    );
    expect(d.sessionState).toBe('upcoming');
    expect(d.statusText).toBe('抢购未开售');
    expect(d.buyable).toBe(false);
  });

  it('场次已结束且按钮未解锁 → 场次已结束（Mate 90 Pro Max 上午场次案例）', () => {
    const d = deriveSkuStatus(
      { buttonMode: 29, inventoryQty: null, isRushBuySku: true, rushBuy: { startTimeMs: T0_PAST, endTimeMs: T_END_PAST } },
      NOW,
    );
    expect(d.sessionState).toBe('ended');
    expect(d.statusText).toBe('场次已结束');
    expect(d.buyable).toBe(false);
  });

  it('场次已结束但按钮已是现货形态 → 现货可买', () => {
    const d = deriveSkuStatus(
      { buttonMode: 1, inventoryQty: 1000, isRushBuySku: true, rushBuy: { startTimeMs: T0_PAST, endTimeMs: T_END_PAST } },
      NOW,
    );
    expect(d.sessionState).toBe('ended');
    expect(d.statusText).toBe('现货可买');
    expect(d.buyable).toBe(true);
  });

  it('活动窗口内 → 抢购进行中', () => {
    const d = deriveSkuStatus(
      { buttonMode: 29, inventoryQty: null, isRushBuySku: true, rushBuy: { startTimeMs: NOW - 60000, endTimeMs: NOW + 3600000 } },
      NOW,
    );
    expect(d.sessionState).toBe('live');
    expect(d.statusText).toBe('抢购进行中');
  });

  it('在抢购名单但没有场次 → 无场次（Mate XT 2 四个无场次 SKU 案例）', () => {
    const d = deriveSkuStatus({ buttonMode: 29, inventoryQty: null, isRushBuySku: true, rushBuy: null }, NOW);
    expect(d.sessionState).toBe('none');
    expect(d.statusText).toBe('无场次（不在开售名单）');
    expect(d.buyable).toBe(false);
  });

  it('普通现货 SKU（buttonMode=1，库存未读）→ 现货可买', () => {
    const d = deriveSkuStatus({ buttonMode: 1, inventoryQty: null, isRushBuySku: false }, NOW);
    expect(d.statusText).toBe('现货可买');
    expect(d.buyable).toBe(true);
  });

  it('未知 buttonMode 原样透出不硬套', () => {
    const d = deriveSkuStatus({ buttonMode: 77, inventoryQty: null }, NOW);
    expect(d.statusText).toBe('未知');
    expect(d.buyable).toBe(false);
  });

  it('没有服务器钟时退回本机钟（不抛错）', () => {
    const d = deriveSkuStatus({ buttonMode: 29, inventoryQty: null, rushBuy: { startTimeMs: Date.now() + 3600000 } }, null);
    expect(d.sessionState).toBe('upcoming');
  });
});

describe('商品级"下一次开售"汇总 deriveNextSale', () => {
  const futureA = { sbomCode: 'A', rushBuy: { startTimeMs: T0_FUTURE + 1000, startTime: 'isoA' } };
  const futureB = { sbomCode: 'B', rushBuy: { startTimeMs: T0_FUTURE, startTime: 'isoB' } };
  const past = { sbomCode: 'C', rushBuy: { startTimeMs: T0_PAST, startTime: 'isoC' } };

  it('取最近的未来场次并归集同刻 SKU', () => {
    const ns = deriveNextSale([futureA, futureB, past], NOW);
    expect(ns.startTimeMs).toBe(T0_FUTURE);
    expect(ns.skuCodes).toEqual(['B']);
  });

  it('全场次都已结束 → null（不该再倒计时）', () => {
    expect(deriveNextSale([past], NOW)).toBeNull();
    expect(deriveNextSale([], NOW)).toBeNull();
    expect(deriveNextSale(null, NOW)).toBeNull();
  });
});

describe('buttonMode 映射表', () => {
  it('29 = 抢购未开售 / 9,10 = 缺货 / 1,3 = 现货可买', () => {
    expect(BUTTON_MODE_LABEL[29]).toEqual({ text: '抢购未开售', buyable: false });
    expect(BUTTON_MODE_LABEL[9].text).toBe('缺货');
    expect(BUTTON_MODE_LABEL[10].text).toBe('缺货');
    expect(BUTTON_MODE_LABEL[1].buyable).toBe(true);
    expect(BUTTON_MODE_LABEL[3].buyable).toBe(true);
  });
});
