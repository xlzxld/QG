/**
 * grab (链接抢购) 纯逻辑单测 —— 2026-10-09 重写配套
 * =====================================================================
 * Agent 侧源文件是 AutoJs 脚本 (非 ESM, 内含 require/module.exports),
 * 本测试直接从源文件"抠出"纯函数源码, 用 new Function 注入依赖执行 ——
 * 测的是真实源码文本, 与打包产物同源, 不做任何复制粘贴。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const damaiSrc = fs.readFileSync(path.join(ROOT, 'platforms', 'app', 'agent', 'adapters', 'damai.js'), 'utf8');
const consoleSrc = fs.readFileSync(path.join(ROOT, 'web', 'hub-console.html'), 'utf8');
const hubSrc = fs.readFileSync(path.join(ROOT, 'core', 'device-hub.mjs'), 'utf8');
const transportSrc = fs.readFileSync(path.join(ROOT, 'platforms', 'app', 'agent', 'transport.js'), 'utf8');

/** 从源码中抠出某个顶层 function 声明 (以行首 } 结束) */
function extractFn(src, name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error(`未找到函数: ${name}`);
  return m[0];
}
function bindFn(src, name, argNames, ...argVals) {
  const body = extractFn(src, name) + `\nreturn ${name};`;
  // eslint-disable-next-line no-new-func
  return new Function(...argNames, body)(...argVals);
}

const signalChangedFrom = bindFn(damaiSrc, 'signalChangedFrom', []);
const textSignalFired = bindFn(damaiSrc, 'textSignalFired', []);
const jitterInt = bindFn(damaiSrc, 'jitterInt', []);
const parseItemId = bindFn(consoleSrc, 'parseItemId', []);
const buildKeywords = bindFn(consoleSrc, 'buildKeywords', []);
const parseXY = bindFn(consoleSrc, 'parseXY', []);

/* ---- 无障碍节点桩 (真实结构取自 2026-10-09 真机 dump) ---- */
const CONTAINER_ID = 'cn.damai:id/trade_project_detail_purchase_status_bar_container_fl';
const TV_ID = 'cn.damai:id/tv_left_main_text';
const BUY_ID = 'cn.damai:id/btn_buy';
const BUV_ID = 'cn.damai:id/btn_buy_view';
// 预约结构（开售那一刻集体消失）—— 主信号；候选放宽到 6 个以保证"一定能识别到"
const CD_ID = 'cn.damai:id/id_new_project_normal_count_down_layout';
const SELL_ID = 'cn.damai:id/id_project_count_sell_time';
const REMIND_ID = 'cn.damai:id/id_project_ticket_remind_me';
const REMIND2_ID = 'cn.damai:id/id_project_count_down_remind_layout';
const CD2_ID = 'cn.damai:id/id_project_count_down_layout';
const CDBG_ID = 'cn.damai:id/id_project_count_down_bg';   // 倒计时背景（原 tour_city_select_bg 实测开售后仍在，已剔除）
// 干扰项：内容是滚动词条，绝不可当信号
const GRAB_TIP_ID = 'cn.damai:id/id_new_project_grab_tip_text';

const makeNode = (p = {}) => ({
  text: () => (p.text !== undefined ? p.text : ''),
  contentDescription: () => (p.desc !== undefined ? p.desc : ''),
  childCount: () => (p.childCount !== undefined ? p.childCount : 0),
  clickable: () => !!p.clickable,
  bounds: () => ({ centerX: () => (p.cx !== undefined ? p.cx : 682), centerY: () => (p.cy !== undefined ? p.cy : 2305) }),
});
const makeId = (map) => (sel) => ({ findOnce: () => map[sel] || null });
const readButtonSignalWith = (map) => {
  const id = makeId(map);
  const fn = bindFn(damaiSrc, 'readButtonSignal', ['id'], id);
  return fn(); // 注意: 取出后必须调用, 返回信号元组对象
};
/** 预约态页面（真机 dump 实证：6 项预约结构齐全，底栏是静态占位容器） */
const PRESALE_MAP = {
  [CONTAINER_ID]: makeNode({ childCount: 1, clickable: false, cx: 682, cy: 2305 }),
  [CD_ID]: makeNode({}),
  [SELL_ID]: makeNode({ text: '10月09日 17:17开抢' }),
  [REMIND_ID]: makeNode({}),
  [REMIND2_ID]: makeNode({}),
  [CD2_ID]: makeNode({}),
  [CDBG_ID]: makeNode({}),
};
/** 开售后页面（同一 dump 实证：预约组件全部消失，底栏容器属性一模一样，且没有 tv/btn_buy*） */
const PRESALE_OVER_MAP = {
  [CONTAINER_ID]: makeNode({ childCount: 1, clickable: false, cx: 682, cy: 2305 }),
};

describe('grab 信号元组与突变判定 (源文件直取)', () => {
  it('1. 预约态基线: 预约结构齐全(6/6), 自身比对 => 不判变化', () => {
    const sig = readButtonSignalWith(PRESALE_MAP);
    expect(sig.hasContainer).toBe(true);
    expect(sig.center).toEqual({ x: 682, y: 2305 });
    expect(sig.presale.filter((x) => x).length).toBe(6);
    expect(signalChangedFrom(sig, sig)).toBe(false);
  });

  it('2. ★开售翻转(真机两态实证): 预约结构成片消失 => 判变化', () => {
    const base = readButtonSignalWith(PRESALE_MAP);
    const over = readButtonSignalWith(PRESALE_OVER_MAP);
    // 关键: 旧信号在两种状态下完全相同（这就是 17:17 失败的原因）
    expect(over.cAttrs).toBe(base.cAttrs);
    expect(over.tvText).toBe(base.tvText);
    // 新判定必须能区分
    expect(signalChangedFrom(over, base)).toBe(true);
  });

  it('3. 瞬时单节点丢失(重渲染) => 不判变化 (防假信号误点已预约)', () => {
    const base = readButtonSignalWith(PRESALE_MAP);
    const partial = readButtonSignalWith({ ...PRESALE_MAP, [SELL_ID]: null }); // 6 项只掉 1 项
    expect(partial.presale.filter((x) => x).length).toBe(5);
    expect(signalChangedFrom(partial, base)).toBe(false);
  });

  it('3b. 只剩 1 项且它消失 => 判变化 (候选不全时也要能识别)', () => {
    const base = readButtonSignalWith({ [CONTAINER_ID]: makeNode({ childCount: 1 }), [SELL_ID]: makeNode({ text: '10月09日 17:17开抢' }) });
    const over = readButtonSignalWith({ [CONTAINER_ID]: makeNode({ childCount: 1 }) });
    expect(base.presale.filter((x) => x).length).toBe(1);
    expect(signalChangedFrom(over, base)).toBe(true);
  });

  it('4. 兜底: 底栏容器属性变化 => 判变化', () => {
    const base = readButtonSignalWith(PRESALE_MAP);
    const changed = readButtonSignalWith({ ...PRESALE_MAP, [CONTAINER_ID]: makeNode({ childCount: 2, clickable: true }) });
    expect(signalChangedFrom(changed, base)).toBe(true);
  });

  it('5. 容器消失(读异常)但无正向信号 => 不判变化 (防把一次读失败当翻转)', () => {
    const base = readButtonSignalWith(PRESALE_MAP);
    const s = readButtonSignalWith({});
    expect(s.hasContainer).toBe(false);
    expect(signalChangedFrom(s, base)).toBe(false);
  });

  it('6. 容器消失但出现 btn_buy_view 正向信号 => 判变化', () => {
    const base = readButtonSignalWith(PRESALE_MAP);
    const s = readButtonSignalWith({ [BUV_ID]: makeNode({}) });
    expect(s.buv).toBe(1);
    expect(signalChangedFrom(s, base)).toBe(true);
  });

  it('7. 节点读取全部抛异常时不崩溃, 返回默认元组', () => {
    const id = () => { throw new Error('a11y tree busy'); };
    const fn = bindFn(damaiSrc, 'readButtonSignal', ['id'], id);
    const s = fn();
    expect(s.hasContainer).toBe(false);
    expect(s.presale.filter((x) => x).length).toBe(0);   // 读不到时视为"没有预约结构"
    expect(s.sig).toContain('presale=000000');
  });

  it('8. 回归护栏: 结构信号必须被读; 滚动词条 grab_tip 不得进入信号; 观察窗/盲点不得复活', () => {
    const sigFn = extractFn(damaiSrc, 'readButtonSignal');
    for (const idStr of [
      'id_new_project_normal_count_down_layout', 'id_project_count_sell_time', 'id_project_ticket_remind_me',
      'id_project_count_down_remind_layout', 'id_project_count_down_layout', 'id_project_count_down_bg',
    ]) {
      expect(sigFn).toContain(idStr);
    }
    expect(sigFn).not.toContain('grab_tip');                 // 滚动词条是干扰项
    expect(damaiSrc).not.toMatch(/blind_deadline/);          // 盲点不得复活
    expect(damaiSrc).not.toMatch(/postFireWatchMs/);         // 观察窗已按用户要求移除
    expect(damaiSrc).toMatch(/watchHardCapMs:\s*60000/);     // 兜底闸门上限 1 分钟（用户拍板）
    expect(consoleSrc).not.toMatch(/grab-watch-ms/);         // 控制台也不再有观察窗输入框
    expect(consoleSrc).toMatch(/GRAB_SAVE_KEY/);             // 控制台必须带参数本机保存
  });

  it('13. 落点抖动语义: 上限±N、每次两轴同时生效、各自独立、0=不抖', () => {
    let last = null;
    const adbPressStub = (x, y, press) => { last = { x, y, press }; return true; };
    const jit = bindFn(damaiSrc, 'jitterInt', []);
    const cfg = { jitterXPx: 9, jitterYPx: 2, pressMinMs: 38, pressMaxMs: 56 };
    const humanTapFn = bindFn(damaiSrc, 'humanTap', ['jitterInt', 'adbPress', 'CLICK_CFG'], jit, adbPressStub, cfg);

    const xs = new Set(), ys = new Set();
    for (let i = 0; i < 300; i++) {
      humanTapFn(682, 2305);                        // 不传 ampX/ampY → 用配置里的两轴上限
      expect(last.x).toBeGreaterThanOrEqual(673);   // 682-9
      expect(last.x).toBeLessThanOrEqual(691);      // 682+9
      expect(last.y).toBeGreaterThanOrEqual(2303);  // 2305-2
      expect(last.y).toBeLessThanOrEqual(2307);     // 2305+2
      expect(last.press).toBeGreaterThanOrEqual(38);
      expect(last.press).toBeLessThanOrEqual(56);
      xs.add(last.x); ys.add(last.y);
    }
    expect(xs.size).toBeGreaterThan(5);             // X 确实在抖（不是固定值）
    expect(ys.size).toBeGreaterThan(2);             // Y 也在抖（两轴同时生效）
    let xNeg = 0, xPos = 0, yNeg = 0, yPos = 0;
    for (const v of xs) { if (v < 682) xNeg++; if (v > 682) xPos++; }
    for (const v of ys) { if (v < 2305) yNeg++; if (v > 2305) yPos++; }
    expect(xNeg).toBeGreaterThan(1);                // 负方向出现过
    expect(xPos).toBeGreaterThan(1);                // 正方向出现过（即 -上限~+上限）
    expect(yNeg).toBeGreaterThan(0);                // Y 轴同样两个方向都有
    expect(yPos).toBeGreaterThan(0);

    // 上限 0 => 该轴完全不抖
    cfg.jitterXPx = 0; cfg.jitterYPx = 0;
    for (let i = 0; i < 20; i++) { humanTapFn(682, 2305); expect(last.x).toBe(682); expect(last.y).toBe(2305); }

    // jitterInt 本身: 给定 amp=9, 取值必须在 [-9, +9] 且两方向都能出现
    let neg = 0, pos = 0;
    for (let i = 0; i < 500; i++) { const d = jit(682, 9) - 682; expect(Math.abs(d)).toBeLessThanOrEqual(9); if (d < 0) neg++; if (d > 0) pos++; }
    expect(neg).toBeGreaterThan(10);
    expect(pos).toBeGreaterThan(10);
  });
  it('12. 护栏: 页面身份只认标题(防跑错站); 抖动分 XY 轴; 未实证的正向词条已清空', () => {
    expect(damaiSrc).toMatch(/info_v2_title_tv1/);            // 标题节点是页面身份权威
    expect(damaiSrc).toMatch(/站名是强判据/);                  // 站名不在标题里 => 直接否决
    expect(damaiSrc).toMatch(/jitterXPx/);                    // 抖动分轴
    expect(damaiSrc).toMatch(/jitterYPx/);
    expect(damaiSrc).toMatch(/LIVE_POS_TEXTS = \[\]/);        // 实测读不到的正向词条不得复活
    expect(consoleSrc).toMatch(/grab-jitter-x/);              // 控制台两轴输入
    expect(consoleSrc).toMatch(/grab-jitter-y/);
    expect(hubSrc).toMatch(/jitterXPx/);                      // 中枢白名单带上分轴字段
  });

  it('14. 护栏: 手机脚本可"局域网停止 / 局域网更新"(全链路在位, 2026-10-09 通道化改版)', () => {
    expect(hubSrc).toMatch(/\/api\/device\/stop-agent/);          // 中枢: 停止脚本端点
    expect(hubSrc).toMatch(/\/api\/device\/update-script-lan/);   // 中枢: 局域网更新端点
    expect(hubSrc).toMatch(/stopAgent: true/);                    // 中枢: 心跳回带停止指令
    expect(hubSrc).toMatch(/selfUpdate: true/);                   // 中枢: 心跳回带自更新指令
    expect(hubSrc).toMatch(/hubAgentScriptSize/);                 // 中枢: 脚本体积对账字段
    expect(transportSrc).toMatch(/stopRequested/);                // 端侧: 接收停止指令
    expect(transportSrc).toMatch(/selfUpdate: function/);         // 端侧: 自更新实现
    expect(transportSrc).toMatch(/scriptSize: this\.scriptSize\(\)/); // 端侧: 上报脚本体积
    expect(transportSrc).toMatch(/updateRequested/);              // 端侧: 接收自更新指令
    expect(transportSrc).toMatch(/remoteUsb/);                    // 端侧: 统一通道判定
    // 修复闭环: 标志位必须有人消费 (否则停止/更新按钮永远无效) — 消费点在 runner.js 的 1s 控制 tick
    expect(transportSrc).toMatch(/hubChannel/);                   // 心跳回带通道, 端侧据此短路 ADB 调用
    // 控制台: 停止按钮 + 更新按钮(已合并局域网更新, 按通道自动选)
    expect(consoleSrc).toMatch(/stopAgent\(/);
    expect(consoleSrc).toMatch(/update-script-lan/);
    expect(consoleSrc).not.toMatch(/updateScriptLan\(/);          // 独立「局域网更新」按钮已并入「更新手机脚本并重启」
  });

  it('15. 护栏: 统一通道 (USB 优先 → WiFi 降级) 全链路在位', () => {
    expect(hubSrc).toMatch(/function resolveChannel/);            // 中枢: 通道解析
    expect(hubSrc).toMatch(/\/api\/channel/);                     // 中枢: 通道查询端点
    expect(hubSrc).toMatch(/\/api\/phone\/cmd/);                  // 中枢: 统一代操作入口
    expect(hubSrc).toMatch(/dispatchPhoneOp/);                    // 中枢: WiFi 降级 = 下发 phone_op
    expect(hubSrc).toMatch(/mode: 'phone_op'/);                   // phone_op 是合法任务模式
    expect(hubSrc).toMatch(/usb_auto_connect/);                   // USB 插入自动一键连接
    expect(hubSrc).toMatch(/openItemGate/);                       // 白名单闸门(通道无关, 先于通道判定)
    expect(consoleSrc).toMatch(/applyChannel/);                   // 控制台: 通道渲染
    expect(consoleSrc).toMatch(/requireChannel/);                 // 控制台: 按钮通道预检
    expect(consoleSrc).toMatch(/\/api\/phone\/cmd/);              // 控制台: 打开商品页走统一入口
  });

  it('9. jitterInt 抖动在设定幅度内', () => {
    for (let i = 0; i < 200; i++) {
      const v = jitterInt(100, 3);
      expect(v).toBeGreaterThanOrEqual(97);
      expect(v).toBeLessThanOrEqual(103);
    }
  });

  it('10. 文案兜底: 只在"朝开售方向"变化时才判命中（防误报）', () => {
    const base = { pos: 0, neg: 1 };                       // 预约态: 无"立即购买"类字样, 有"…开抢"
    expect(textSignalFired({ pos: 0, neg: 1 }, base)).toBe(false);  // 无变化
    expect(textSignalFired({ pos: 1, neg: 1 }, base)).toBe(true);   // 开售后文案出现
    expect(textSignalFired({ pos: 0, neg: 0 }, base)).toBe(true);   // 开抢文案消失
    expect(textSignalFired({ pos: 1, neg: 0 }, base)).toBe(true);   // 两者同时
    expect(textSignalFired({ pos: 0, neg: 2 }, base)).toBe(false);  // 反方向(多了"开抢")不算
    expect(textSignalFired({ pos: 0, neg: 1 }, null)).toBe(false);  // 无基线不判
  });

  it('11. 护栏: 文案兜底不得把滚动词条当判据; 保活优化/自动刷新开关在位', () => {
    const fn = extractFn(damaiSrc, 'scanTexts');
    expect(fn).not.toContain('大麦全速护航');   // 滚动词条
    expect(fn).not.toContain('预售');           // 滚动提示
    expect(damaiSrc).toMatch(/autoRefresh: false/);           // 自动刷新默认关
    expect(consoleSrc).toMatch(/grab-autorefresh/);           // 控制台有开关
    expect(consoleSrc).toMatch(/perfBoost/);                  // 控制台有保活优化
    expect(hubSrc).toMatch(/\/api\/device\/perf-boost/);      // 中枢有端点
    expect(hubSrc).toMatch(/perfBoostOff/);                   // 中枢有"恢复原状"
    expect(hubSrc).toMatch(/autoRefresh/);                    // dispatch 白名单带 autoRefresh
  });
});

describe('控制台 链接解析 (hub-console.html 直取)', () => {
  it('8. parseItemId: 分享链接 / 原生链接 / item.htm / 纯数字 / 非法', () => {
    expect(parseItemId('https://m.damai.cn/shows/item.html?itemId=1085142029424&from=appshare')).toBe('1085142029424');
    expect(parseItemId('https://m.damai.cn/damai/perform/item.html?itemId=123456')).toBe('123456');
    expect(parseItemId('https://detail.damai.cn/item.htm?id=998877')).toBe('998877');
    expect(parseItemId('  1085142029424  ')).toBe('1085142029424');
    expect(parseItemId('')).toBe(null);
    expect(parseItemId('abc')).toBe(null);
    expect(parseItemId('12345')).toBe(null); // 不足 6 位
    expect(parseItemId(null)).toBe(null);
  });

  it('9. buildKeywords: 剔除通用词与"站"后缀, 生成核对关键词', () => {
    const kw = buildKeywords({ name: '贵阳·薛之谦“万兽之王”巡回演唱会- 贵阳站', city: '贵阳市', stationName: '贵阳站' });
    const list = kw.split(',');
    expect(list).toContain('薛之谦');
    expect(list).toContain('万兽之王');
    expect(kw).not.toContain('演唱会');
    expect(list.length).toBeLessThanOrEqual(3);
  });

  it('10. parseXY: 半角/全角逗号与非法输入', () => {
    expect(parseXY('682,2305')).toEqual({ x: 682, y: 2305 });
    expect(parseXY('682，2305')).toEqual({ x: 682, y: 2305 });
    expect(parseXY('abc')).toBe(null);
    expect(parseXY('')).toBe(null);
  });
});
