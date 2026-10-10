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
const runnerSrc = fs.readFileSync(path.join(ROOT, 'platforms', 'app', 'agent', 'runner.js'), 'utf8');

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

  it('16. 护栏: 首击/抖动参数「控制台 = 中枢 = 手机端」范围与默认值三处一致 (2026-10-10)', () => {
    // —— 手机端 (agent applyClickCfg): 夹取范围/默认值必须与控制台一致 ——
    expect(damaiSrc).toMatch(/firstTapTimeoutMs = cfgInt\(g\.firstTapTimeoutMs, 30, 3000,/);
    expect(damaiSrc).toMatch(/jitterXPx = cfgInt\([^)]*0, 100,/);      // 旧值 0,24 会让控制台填 40 静默变 24
    expect(damaiSrc).toMatch(/jitterYPx = cfgInt\([^)]*0, 40,/);
    expect(damaiSrc).not.toMatch(/cfgInt\([^)]*0, 24,/);               // 不得再夹死在 24
    expect(damaiSrc).not.toMatch(/firstTapTimeoutMs, 200,/);           // 首击超时下限不得是 200
    expect(damaiSrc).toMatch(/jitterXPx: 30,/);                        // 默认值也要与控制台一致
    expect(damaiSrc).toMatch(/jitterYPx: 12,/);
    // —— 中枢 (device-hub 白名单 clamp) ——
    expect(hubSrc).toMatch(/firstTapTimeoutMs, 30, 3000, 50\)/);
    expect(hubSrc).toMatch(/jitterXPx[^;]*0, 100, 30\)/);
    expect(hubSrc).toMatch(/jitterYPx[^;]*0, 40, 12\)/);
    // —— 控制台 (HTML 输入 + numVal 兜底) ——
    expect(consoleSrc).toMatch(/id="grab-ft-timeout"[^>]*value="50" min="30" max="3000"/);
    expect(consoleSrc).toMatch(/id="grab-jitter-x"[^>]*value="30" min="0" max="100"/);
    expect(consoleSrc).toMatch(/id="grab-jitter-y"[^>]*value="12" min="0" max="40"/);
    expect(consoleSrc).toMatch(/numVal\('grab-ft-timeout', 30, 3000, 50\)/);
    expect(consoleSrc).toMatch(/numVal\('grab-jitter-x', 0, 100, 30\)/);
    expect(consoleSrc).toMatch(/numVal\('grab-jitter-y', 0, 40, 12\)/);
    // —— 参数保存: 只手动保存; 不得再出现「清空已存/恢复默认」与自动保存绑定 ——
    expect(consoleSrc).not.toMatch(/resetGrabParams/);
    expect(consoleSrc).not.toMatch(/bindGrabParamAutosave/);
    expect(consoleSrc).toMatch(/onclick="saveGrabParams\(\)"/);
  });

  it('17. 护栏: 换商品必须重刷预填 + 手机脚本校验链路在位 (2026-10-10)', () => {
    // —— 换商品重刷预填: 关键词/开抢时间不能"非空就永不覆盖" (否则换商品后留着上一个城市的词) ——
    expect(consoleSrc).toMatch(/lastParsedItemId/);
    expect(consoleSrc).toMatch(/primeGrabLinkBaseline/);   // 启动先对齐基线, 免得冲掉本机恢复出来的已存值
    const linkFn = extractFn(consoleSrc, 'onGrabLinkInput');
    expect(linkFn).toMatch(/changed/);                     // 必须按"商品是否变了"决定覆盖
    expect(linkFn).toMatch(/grab-keywords/);
    expect(linkFn).toMatch(/grab-time/);
    // —— 校验链路: 控制台按钮 → 中枢端点 → 手机自检指令 → 端侧版本号 ——
    expect(consoleSrc).toMatch(/id="btn-verify-script"/);
    expect(consoleSrc).toMatch(/onclick="verifyPhoneScript\(\)"/);
    expect(consoleSrc).toMatch(/\/api\/device\/verify-script/);
    expect(consoleSrc).toMatch(/id="verify-steps"/);       // 明细落点 (提示要全面)
    expect(hubSrc).toMatch(/\/api\/device\/verify-script/);
    expect(hubSrc).toMatch(/canVerifyOp/);                 // 手机认不认自检指令
    expect(hubSrc).toMatch(/notifyPhoneViaAdb/);           // 旧脚本的 USB 通知兜底
    expect(hubSrc).toMatch(/hubVersion/);                  // 从脚本里认出电脑端版本号 (与手机上报的对比)
    expect(runnerSrc).toMatch(/op === "verify_script"/);   // 手机本地自检
    expect(runnerSrc).toMatch(/script_verified/);
    expect(transportSrc).toMatch(/AGENT_VERSION: "\d/);    // 版本号唯一来源
    expect(transportSrc).toMatch(/agentVersion: this\.AGENT_VERSION/);   // hello 上报引用它
  });

  it('18. autoFillGrabTime: 从开售提示反推开抢时间 (命中/已有值不覆盖/无提示不瞎填)', () => {
    const fields = { 'grab-time': { value: '' } };
    const fn = bindFn(consoleSrc, 'autoFillGrabTime', ['$'], (id) => fields[id]);
    // 命中: 取最后一条提示
    expect(fn(['10月17日-18日 → 10月7日 17:17', '10月24日-25日 → 10月9日 17:17'])).toBe(true);
    expect(fields['grab-time'].value).toMatch(/^\d{4}-10-09 17:17:00$/);
    // 已有值不覆盖 (调用方要覆盖时会先清空)
    fields['grab-time'].value = '2026-01-01 10:00:00';
    expect(fn(['10月7日 11:11'])).toBe(false);
    expect(fields['grab-time'].value).toBe('2026-01-01 10:00:00');
    // 没有开售提示 → 返回 false (由调用方决定清空 + 提示手填)
    fields['grab-time'].value = '';
    expect(fn([])).toBe(false);
    expect(fields['grab-time'].value).toBe('');
  });

  it('19. ★抢购前不拦截: 无二次确认/无拒绝, 时间异常只提醒 (2026-10-10 用户口径)', () => {
    const armFn = extractFn(consoleSrc, 'grabArm');
    expect(armFn).toMatch(/parseFireTime/);              // 用统一解析器
    expect(armFn).not.toMatch(/时间太近/);                // 旧的误导性硬拦提示必须消失
    expect(armFn).not.toMatch(/if \(fireAt - Date\.now\(\) < 8000\)/);   // 旧的"一条 8 秒硬拦"必须消失
    expect(armFn).not.toMatch(/confirmModal/);           // ★ 不许再有任何二次确认 (点抢购 = 直接下发)
    expect(armFn).not.toMatch(/仍要下发/);
    expect(armFn).toMatch(/已过去/);                      // 时间已过去 → 只提醒
    expect(armFn).toMatch(/直接下发/);                    // 且明确告知"照发"
    expect(armFn).toMatch(/twelveHourTypoHint/);         // 12/24 小时制写错要给出提示
    expect(armFn).toMatch(/fmtSpan/);
    // 输入框实时回显 (写错一眼可见, 但也不阻断)
    expect(consoleSrc).toMatch(/id="grab-time-parsed"/);
    expect(consoleSrc).toMatch(/updateGrabTimeHint/);
    expect(consoleSrc).toMatch(/setInterval\(updateGrabTimeHint/);
  });

  it('20. parseFireTime: 12/24 小时制陷阱 / 只写时分 / 全角冒号 / 非法', () => {
    const fn = bindFn(consoleSrc, 'parseFireTime', []);
    const now = new Date('2026-10-10T13:29:30').getTime();   // 事故时刻: 距 13:30 还有 30 秒
    expect(fn('2026-10-10 13:30:00').norm).toBe('2026-10-10 13:30:00');
    // ★ 事故根因: 用户想写 13:30 却写成 1:30 → 解析成 01:30 (已过去 12 小时)
    const trap = fn('2026-10-10 1:30:00');
    expect(trap.ok).toBe(true);
    expect(trap.norm).toBe('2026-10-10 01:30:00');
    expect(trap.ms - now).toBeLessThan(0);                   // 是"已过去", 不是"不足 8 秒"
    // 只写时分 → 按今天补日期 (注入 nowMs 保证确定性)
    const only = fn('13:30', now);
    expect(only.ok).toBe(true);
    expect(only.norm).toBe('2026-10-10 13:30:00');
    expect(only.onlyTime).toBe(true);
    expect(fn('13:30:05', now).norm).toBe('2026-10-10 13:30:05');
    expect(fn('2026-10-10 13：30：00').norm).toBe('2026-10-10 13:30:00');   // 全角冒号
    // 非法不兜底
    expect(fn('').ok).toBe(false);
    expect(fn('下午一点半').ok).toBe(false);
    expect(fn('10月10日 13:30').ok).toBe(false);
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

  it('21. ★2026-10-10 改版护栏: 双读/盲点/弹窗/看护节奏四参数贯通三层 + 旧模式移除 + 风控硬约束去除', () => {
    // —— 手机端默认值 (四个新参数 + 到点盲点开关) ——
    expect(damaiSrc).toMatch(/doubleReadMs:\s*50/);
    expect(damaiSrc).toMatch(/blindFire:\s*false/);
    expect(damaiSrc).toMatch(/popupDelayMs:\s*300/);
    expect(damaiSrc).toMatch(/popupPollMs:\s*50/);
    expect(damaiSrc).toMatch(/watchPollMs:\s*400/);
    // 双读必须走参数 (不能再写死 80ms)
    expect(damaiSrc).not.toMatch(/sleep\(80\)/);
    expect(damaiSrc).toMatch(/sleep\(CLICK_CFG\.doubleReadMs\)/);
    // 到点盲点: 开关 + 走 emitFirstTap 统一出手链 (USB/WiFi 都支持)
    expect(damaiSrc).toMatch(/CLICK_CFG\.blindFire && !blindFired/);
    expect(damaiSrc).toMatch(/blind_deadline/);
    // 侧车节奏全部走参数 (旧写死 600ms 必须消失)
    const sidecarFn = extractFn(damaiSrc, 'startChainSidecar');
    expect(sidecarFn).toMatch(/CLICK_CFG\.popupDelayMs/);
    expect(sidecarFn).toMatch(/CLICK_CFG\.popupPollMs/);
    expect(sidecarFn).toMatch(/CLICK_CFG\.watchPollMs/);
    expect(sidecarFn).not.toMatch(/> 600\)/);
    // —— 中枢白名单 (四个新参数 clamp) ——
    expect(hubSrc).toMatch(/doubleReadMs: clampInt\(ig\.doubleReadMs, 0, 500, 50\)/);
    expect(hubSrc).toMatch(/blindFire: !!ig\.blindFire/);
    expect(hubSrc).toMatch(/popupDelayMs: clampInt\(ig\.popupDelayMs, 0, 3000, 300\)/);
    expect(hubSrc).toMatch(/popupPollMs: clampInt\(ig\.popupPollMs, 10, 1000, 50\)/);
    expect(hubSrc).toMatch(/watchPollMs: clampInt\(ig\.watchPollMs, 50, 5000, 400\)/);
    // —— 控制台 (输入在位 + 下发) ——
    expect(consoleSrc).toMatch(/id="grab-double-read"[^>]*value="50"/);
    expect(consoleSrc).toMatch(/id="grab-blindfire"/);
    expect(consoleSrc).toMatch(/id="grab-popup-delay"[^>]*value="300"/);
    expect(consoleSrc).toMatch(/id="grab-popup-poll"[^>]*value="50"/);
    expect(consoleSrc).toMatch(/id="grab-watch-poll"[^>]*value="400"/);
    const armFn = extractFn(consoleSrc, 'grabArm');
    expect(armFn).toMatch(/blindFire: \$\('grab-blindfire'\)\.checked/);
    expect(armFn).toMatch(/doubleReadMs: numVal\('grab-double-read', 0, 500, 50\)/);
    expect(armFn).toMatch(/popupDelayMs: numVal\('grab-popup-delay', 0, 3000, 300\)/);
    expect(armFn).toMatch(/popupPollMs: numVal\('grab-popup-poll', 10, 1000, 50\)/);
    expect(armFn).toMatch(/watchPollMs: numVal\('grab-watch-poll', 50, 5000, 400\)/);
    // —— 旧模式彻底移除: 彩排 / 无脑高频 + 执行方式下拉 ——
    expect(consoleSrc).not.toMatch(/grab-exec/);
    expect(consoleSrc).not.toMatch(/onGrabExecChange/);
    expect(consoleSrc).not.toMatch(/grab-reh-/);
    expect(consoleSrc).not.toMatch(/hammer/);
    expect(damaiSrc).not.toMatch(/hammer/);
    expect(damaiSrc).not.toMatch(/rehearsalMs/);
    expect(hubSrc).not.toMatch(/hammer/);
    expect(hubSrc).not.toMatch(/maxChainMs/);
    expect(hubSrc).not.toMatch(/humanMs/);
    // —— 绿色测试按钮 (抢购左侧) + 全面自检按钮 ——
    expect(consoleSrc).toMatch(/onclick="grabArm\(true\)"/);
    expect(consoleSrc).toMatch(/onclick="grabArm\(false\)"/);
    expect(consoleSrc).toMatch(/class="btn ok"[^>]*onclick="grabArm\(true\)"/);
    expect(consoleSrc).toMatch(/onclick="grabFullCheck\(\)"/);
    expect(consoleSrc).toMatch(/buildGrabChainDoc/);
    // —— 频率硬约束去除: 不得再有 20 击/秒 硬上限与 ≥50ms 间隔地板 ——
    expect(damaiSrc).not.toMatch(/Math\.max\(50, humanGapMs\(\)\)/);
    expect(damaiSrc).not.toMatch(/cfgInt\(rateMax, 1, 20,/);
    expect(hubSrc).not.toMatch(/clampInt\(ig\.rateMax, 1, 20,/);
    // —— 注入熔断移除: 连点链不得因 3 次失败自己收工 (延续已删的"首击重试"思路) ——
    expect(damaiSrc).not.toMatch(/adb_down/);
    expect(damaiSrc).toMatch(/injectFails/);
  });

  it('22. 行为验证: applyClickCfg 让四个新参数 + 到点盲点开关在手机端真生效 (含范围夹取/不再卡 20)', () => {
    const cfgInt = bindFn(damaiSrc, 'cfgInt', []);
    const deriveCadence = bindFn(damaiSrc, 'deriveCadence', ['cfgInt'], cfgInt);
    const GRAB_POINTS = { jitterCap: { x: 100, y: 40 }, popup: { x: 540, y: 1382, jitterX: 80, jitterY: 18 }, anchor: { x: 841, y: 2310 }, popupFromSubmit: { dx: -301, dy: -928 } };
    const mkCfg = () => ({
      rateMin: 8, rateMax: 12, rttMs: 40, gapMinMs: 55, gapMaxMs: 85, pressMinMs: 38, pressMaxMs: 56,
      jitterPx: 30, jitterXPx: 30, jitterYPx: 12, chainMs: 12000, watchHardCapMs: 60000, autoRefresh: false,
      firstTapTries: 1, firstTapTimeoutMs: 50,
      doubleReadMs: 50, blindFire: false, popupDelayMs: 300, popupPollMs: 50, watchPollMs: 400,
    });
    const run = (g) => {
      const cfg = mkCfg();
      const apply = bindFn(damaiSrc, 'applyClickCfg', ['cfgInt', 'deriveCadence', 'CLICK_CFG', 'GRAB_POINTS'], cfgInt, deriveCadence, cfg, GRAB_POINTS);
      apply(g);
      return cfg;
    };

    // 默认值 (空对象不动)
    const d = run({});
    expect(d.doubleReadMs).toBe(50);
    expect(d.blindFire).toBe(false);
    expect(d.popupDelayMs).toBe(300);
    expect(d.popupPollMs).toBe(50);
    expect(d.watchPollMs).toBe(400);

    // 真值透传 (控制台填多少 → 手机端就是多少)
    const a = run({ doubleReadMs: 40, popupDelayMs: 120, popupPollMs: 45, watchPollMs: 350, blindFire: true });
    expect(a.doubleReadMs).toBe(40);
    expect(a.popupDelayMs).toBe(120);
    expect(a.popupPollMs).toBe(45);
    expect(a.watchPollMs).toBe(350);
    expect(a.blindFire).toBe(true);

    // 开关关: 显式 false / 缺省 / 假值一律为 false
    expect(run({ blindFire: 0 }).blindFire).toBe(false);
    expect(run({ blindFire: undefined }).blindFire).toBe(false);

    // 范围夹取 (与控制台 / 中枢一致): 双读 0~500 / 弹窗起始 0~3000 / 弹窗间隔 10~1000 / 看护 50~5000
    expect(run({ doubleReadMs: 9999 }).doubleReadMs).toBe(500);
    expect(run({ doubleReadMs: -5 }).doubleReadMs).toBe(0);
    expect(run({ popupDelayMs: 9999 }).popupDelayMs).toBe(3000);
    expect(run({ popupPollMs: 1 }).popupPollMs).toBe(10);
    expect(run({ watchPollMs: 99999 }).watchPollMs).toBe(5000);

    // 节拍不再卡 20: 填 25 击/秒 → 真的按 25 反解 (旧版夹到 20 时 gapMax 会是 10)
    const fast = run({ rateMin: 25, rateMax: 25, rttMs: 40 });
    expect(fast.gapMaxMs).toBe(0);            // floor(1000/25 - 40) = 0；若被夹成 20 则为 10

    // 抖动上限开到几何极限 X≤100 / Y≤40: 填 100/40 原样生效 (旧版夹 24)
    const jit = run({ jitterXPx: 100, jitterYPx: 40 });
    expect(jit.jitterXPx).toBe(100);
    expect(jit.jitterYPx).toBe(40);
    expect(run({ jitterXPx: 9999 }).jitterXPx).toBe(100);   // 超出几何极限才夹
    expect(run({ jitterYPx: 9999 }).jitterYPx).toBe(40);
  });

  it('23. ★2026-10-10 二轮护栏: 无障碍手势点击兜底已彻底删除 + 抖动上限开到 X100/Y40 + 日志人话化', () => {
    // —— 手势点击兜底: fastPress 整个函数删除; adbPress/criticalTap 内不得再出现 press(/click( 手势注入 ——
    expect(damaiSrc).not.toMatch(/function fastPress/);
    expect(damaiSrc).not.toMatch(/fastPress\(/);
    const adbPressFn = extractFn(damaiSrc, 'adbPress');
    expect(adbPressFn).toMatch(/adbTapBurst/);      // ① PC-ADB
    expect(adbPressFn).toMatch(/LocalInjector/);    // ② 手机本地 Shizuku
    expect(adbPressFn).not.toMatch(/press\(/);      // ✘ 不再有无障碍手势注入
    expect(adbPressFn).not.toMatch(/click\(/);
    const critFn = extractFn(damaiSrc, 'criticalTap');
    expect(critFn).toMatch(/LocalInjector/);
    expect(critFn).not.toMatch(/humanPress/);       // ✘ 不再有手势兜底通道
    // 首击: 两路都不通必须"如实失败", 不许假装成功
    expect(damaiSrc).toMatch(/first_tap_failed/);
    expect(damaiSrc).not.toMatch(/gesture\(告警\)/);
    // —— 端侧 / 中枢 / 控制台: gesture 点击链路整体下线 ——
    expect(runnerSrc).not.toMatch(/localGesture/);
    expect(runnerSrc).not.toMatch(/op === "gesture"/);
    expect(hubSrc).not.toMatch(/case 'gesture'/);
    expect(hubSrc).not.toMatch(/gestureReliable/);
    expect(hubSrc).toMatch(/tapShizuku/);           // 能力矩阵改成 ADB / Shizuku 两路
    // —— 抖动上限确实开到了几何极限 X≤100 / Y≤40 (三层一致) ——
    expect(damaiSrc).toMatch(/jitterCap: \{ x: 100, y: 40 \}/);
    expect(damaiSrc).toMatch(/jitterXPx[^;]*0, 100,/);
    expect(damaiSrc).toMatch(/jitterYPx[^;]*0, 40,/);
    expect(hubSrc).toMatch(/jitterXPx[^;]*0, 100, 30\)/);
    expect(hubSrc).toMatch(/jitterYPx[^;]*0, 40, 12\)/);
    expect(consoleSrc).toMatch(/id="grab-jitter-x"[^>]*max="100"/);
    expect(consoleSrc).toMatch(/id="grab-jitter-y"[^>]*max="40"/);
    // 控制台侧的节拍反解也不得再卡 20
    expect(consoleSrc).not.toMatch(/Math\.min\(20, parseInt\(rateM/);
    // —— 日志: 手机端事件人话化 + 控制台有本地操作日志 ——
    expect(consoleSrc).toMatch(/function localLog/);
    expect(consoleSrc).toMatch(/function viaText/);
    expect(consoleSrc).toMatch(/function mEndReason/);
    expect(consoleSrc).toMatch(/function friendlyDetail/);
    expect(consoleSrc).not.toMatch(/JSON\.stringify\(det\)\.slice\(0, 160\)/);   // 旧的整段 JSON 兜底已去掉
    expect(damaiSrc).toMatch(/\[出手\]/);
    expect(damaiSrc).toMatch(/\[盯梢\]/);
    expect(damaiSrc).toMatch(/\[副手\]/);
    expect(damaiSrc).toMatch(/\[连点\]/);
  });

  it('24. ★2026-10-10 三轮护栏: 自检强制验 Shizuku + 全程记录(含人工操作) + 取证不卡链 (人工介入闸门已按用户口径撤掉)', () => {
    // —— 自检: 必须检查手机 Shizuku, 且 WiFi 通道下视为硬条件 ——
    const checkFn = extractFn(consoleSrc, 'grabFullCheck');
    expect(checkFn).toMatch(/shizuku/);
    expect(checkFn).toMatch(/Shizuku/);
    expect(checkFn).toMatch(/mode === 'wifi'/);
    expect(checkFn).toMatch(/shizukuOk \? 'ok' : 'bad'/);   // WiFi + 没开 = 红项, 不是黄项
    // 中枢通道信息里要带 shizuku 状态 (控制台据它判定)
    expect(hubSrc).toMatch(/shizuku: agent \? \(agent\.shizuku/);
    expect(hubSrc).toMatch(/shizukuReady/);
    expect(consoleSrc).toMatch(/chanState\.shizuku/);
    // —— 全程记录: 控制台操作落盘 + 可导出人话 Markdown ——
    expect(consoleSrc).toMatch(/\/api\/events\/console/);
    expect(hubSrc).toMatch(/\/api\/events\/console/);
    expect(hubSrc).toMatch(/console_op/);
    expect(consoleSrc).toMatch(/exportRunRecord/);
    expect(consoleSrc).toMatch(/onclick="exportRunRecord\(\)"/);
    expect(consoleSrc).toMatch(/\/api\/record\/digest/);
    expect(hubSrc).toMatch(/\/api\/record\/digest/);
    expect(hubSrc).toMatch(/function buildDigest/);
    expect(hubSrc).toMatch(/DIGEST_EVENT_CN/);
    expect(hubSrc).toMatch(/\*\*【人工\/控制台】/);          // 人工操作在记录里被显式标出
    // —— 人工介入保护: 已按用户口径**撤掉** (用户: "基本不会出现这种切走的场景, 徒增负担") ——
    //    出手判定必须无条件执行, 不许再加"页面在不在商品页"的前置闸门
    expect(damaiSrc).not.toMatch(/page_left_watch/);
    expect(damaiSrc).not.toMatch(/leftStreak/);
    expect(damaiSrc).not.toMatch(/skipFire/);
    expect(damaiSrc).not.toMatch(/onDetailAct/);
    expect(damaiSrc).toMatch(/if \(signalChangedFrom\(s, anchor\)\)/);
    expect(damaiSrc).toMatch(/if \(pollCount % 10 === 0\)/);
    expect(damaiSrc).toMatch(/CLICK_CFG\.blindFire && !blindFired && now\(\) >= fireLocal/);   // 盲点不设前置条件
    expect(consoleSrc).not.toMatch(/page_left_watch/);
    expect(hubSrc).not.toMatch(/page_left_watch/);
    // —— 取证: 弹窗首见 / 验证码 都留证据, 且**必须异步**(不许卡住连点链) ——
    expect(damaiSrc).toMatch(/function captureEvidenceAsync/);
    const evFn = extractFn(damaiSrc, 'captureEvidenceAsync');
    expect(evFn).toMatch(/threads\.start/);                  // 独立线程
    expect(damaiSrc).toMatch(/popup_first_seen/);
    expect(damaiSrc).toMatch(/captcha_seen/);
    expect(damaiSrc).toMatch(/captcha_evidence/);
    expect(damaiSrc).toMatch(/popup_never_seen/);
    // —— 控制台能读懂这些新事件 ——
    expect(consoleSrc).toMatch(/popup_first_seen/);
    expect(consoleSrc).toMatch(/captcha_seen/);
    expect(consoleSrc).toMatch(/popup_never_seen/);
  });

  it('25. ★停止脚本流程 (用户口径): 手机退出前回报「我要退了」→ 中枢确认后立刻刷新; 不许中枢自己假设停掉', () => {
    // —— 手机端: 退场前必须回报 ——
    expect(transportSrc).toMatch(/notifyStopping: function/);
    expect(transportSrc).toMatch(/\/api\/device\/stopping/);
    const stopFn = extractFn(runnerSrc, 'stopAgentNow');
    expect(stopFn).toMatch(/notifyStopping/);                 // 退出前先"打招呼"
    expect(stopFn.indexOf('notifyStopping')).toBeLessThan(stopFn.indexOf('engines.stopAll'));
    // 控制指令抽成公共方法, 心跳与长轮询共用 (手机闲着时也能秒级收到停止)
    expect(transportSrc).toMatch(/applyControl: function/);
    expect(transportSrc).toMatch(/this\.applyControl\(hbJson\.control\)/);
    expect(transportSrc).toMatch(/status === "control"/);
    expect(transportSrc).toMatch(/Transport\.applyControl\(json\.control\)/);
    // —— 中枢: 收到回报才标记已停止; 点停止**不许**自己假设停掉 ——
    expect(hubSrc).toMatch(/\/api\/device\/stopping/);
    expect(hubSrc).toMatch(/function markStopConfirmed/);
    expect(hubSrc).toMatch(/function discardStopMark/);
    expect(hubSrc).toMatch(/function deliverControlNow/);
    const stopEp = hubSrc.slice(hubSrc.indexOf("'/api/device/stop-agent'"), hubSrc.indexOf("'/api/device/stop-agent'") + 2200);
    expect(stopEp).toMatch(/deliverControlNow/);              // 先尽力即时送达
    expect(stopEp).not.toMatch(/dev\.stoppingAt = Date\.now\(\)/);   // ✘ 不再"点击即标记已停止"
    expect(stopEp).toMatch(/stopPushedAt/);                  // 只记"已下发", 等手机回报
    // 复探: 回报过停止却仍有心跳/轮询 → 撤回
    expect(hubSrc).toMatch(/discardStopMark\(dev, '回报停止后仍在发心跳'\)/);
    expect(hubSrc).toMatch(/discardStopMark\(d0, '回报停止后仍在轮询任务'\)/);
    // —— 控制台: 两档状态 + 收到回报立刻刷新 ——
    expect(consoleSrc).toMatch(/agent_stopping/);
    expect(consoleSrc).toMatch(/⏹ 已停止/);
    expect(consoleSrc).toMatch(/正在停止…/);
    // —— 更新脚本: Wi-Fi 路径必须回 ok:true (曾因缺 ok 字段 → 控制台**必然**误报"更新未完成") ——
    expect(hubSrc).toMatch(/ok: true, pending: true, status: 'pending'/);
    expect(consoleSrc).toMatch(/r\.ok && r\.pending/);
    expect(consoleSrc).toMatch(/confirmScriptUpdated/);       // 下完用真实凭据复核
    expect(consoleSrc).toMatch(/r\.warn/);                    // "已下发但没确认到"要单独一档, 不叫失败
    expect(transportSrc).toMatch(/scriptSize: this\.scriptSize\(\)/);   // hello 也报体积 → 换引擎后立刻能确认
  });

  it('26. ★中枢停止 / 拔掉数据线后, 抢购必须照常跑 (判定与出手手机本地闭环)', () => {
    // —— ① 行为验证: 中枢/USB 不可用时, 每一次点击都自动走手机本地注入 (Shizuku) ——
    const cfg = { firstTapTimeoutMs: 50 };
    const deadTransport = { adbTapBurst: () => false, adbTap: () => false, remoteUsb: () => false };
    const taps = [];
    const liveInjector = { available: () => true, tap: (x, y, p) => { taps.push([x, y, p]); return true; } };
    const logs = [];
    const press = bindFn(damaiSrc, 'adbPress',
      ['Transport', 'CLICK_CFG', 'LocalInjector', 'sendLog'],
      deadTransport, cfg, liveInjector, (t, m) => logs.push(m));
    expect(press(841, 2310, 40)).toBe(true);          // ★ 中枢不可用 → 仍然点得出去
    expect(taps.length).toBe(1);
    expect(taps[0]).toEqual([841, 2310, 40]);

    // 两路都不通 → 如实返回 false (不假装成功), 并且只报警一次
    const noInjector = { available: () => false, tap: () => false };
    const press2 = bindFn(damaiSrc, 'adbPress',
      ['Transport', 'CLICK_CFG', 'LocalInjector', 'sendLog'],
      deadTransport, cfg, noInjector, (t, m) => logs.push(m));
    expect(press2(841, 2310, 40)).toBe(false);
    expect(press2(841, 2310, 40)).toBe(false);
    expect(logs.length).toBe(1);                      // 只报一次, 不刷屏

    // —— ② 中枢可达性熔断: 上报不许阻塞抢购热路径 ——
    expect(transportSrc).toMatch(/hubReachable: function/);
    expect(transportSrc).toMatch(/noteHubFail: function/);
    expect(transportSrc).toMatch(/HUB_DOWN_COOLDOWN_MS: \d+/);
    const ev = transportSrc.slice(transportSrc.indexOf('sendEvent: function'), transportSrc.indexOf('sendEvent: function') + 1200);
    expect(ev).toMatch(/if \(!this\.hubReachable\(\)\) return;/);      // 熔断期直接丢日志
    expect(ev).toMatch(/timeout: to/);                                 // 失败后改用短超时
    const tapFn = transportSrc.slice(transportSrc.indexOf('adbTap: function'), transportSrc.indexOf('adbTap: function') + 700);
    expect(tapFn).toMatch(/if \(!this\.hubReachable\(\)\) return false;/);   // 熔断期不再每发去撞墙

    // —— ③ 其它"中枢没了也不影响"的兜底都在位 ——
    expect(transportSrc).toMatch(/openItemLocal/);          // 打开商品页: USB 失败 → 本地深链
    expect(transportSrc).toMatch(/enqueueOutbox/);          // 结果上报失败 → 进发件箱
    expect(transportSrc).toMatch(/flushOutbox/);            // 中枢回来 → 心跳时补发
    expect(runnerSrc).toMatch(/Transport\.flushOutbox\(\)/); // 确有人调用
    expect(transportSrc).toMatch(/remoteUsb: function/);    // 走局域网地址 → 立即判"不能走中枢 ADB"
    expect(transportSrc).toMatch(/scanSubnetForHub/);       // 换网络后还能自己找到中枢
    // 对时/开售判定都不依赖中枢: 时间基准来自大麦服务器 (TimeSync), 结构信号来自无障碍节点
    expect(damaiSrc).toMatch(/TimeSync\.cachedOffset/);
    expect(damaiSrc).toMatch(/readButtonSignal/);
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
