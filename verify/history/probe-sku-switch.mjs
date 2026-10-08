#!/usr/bin/env node
/**
 * SKU 切换触发数据重拉 · 实测 v2（2026-10-08，任务8可行性证据）
 * =====================================================================
 * v1 教训：真点击规格芯片对 RNW Pressable 不生效；改用芯片自己的 onPress
 * （fiber 向上 2 层，与买按钮 A 方案同一招）。
 *
 * 做什么（不买任何东西）：
 *   1. 订阅 Network.requestWillBeSent，采 3 秒静息基线
 *   2. 内部 onPress 切到「别的颜色」→ 记录 5 秒内新发起的 API 请求
 *   3. 读「已选」行 + 按钮状态变化
 *   4. 切回原颜色，确认已选恢复
 *
 * 用法：node grab-probe/probe-sku-switch.mjs [--port=9401]
 * =====================================================================
 */
import { CDP, sleep, listTabs } from '../grab/cdp-core.mjs';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PORT = Number(args.port) || 9401;
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

const slots = JSON.parse(readFileSync(new URL('../data/grab/rush-slots.huawei.json', import.meta.url), 'utf8')).slots;
const slot = slots.find((s) => Number(s.port) === PORT) || slots[0];
const catalog = JSON.parse(readFileSync(new URL('../data/grab/huawei.catalog.json', import.meta.url), 'utf8'));
const prod = (catalog.products || []).find((p) => String(p.prdId) === String(slot.prdId));
if (!prod) { log('目录里没有该商品'); process.exit(1); }

const skuOf = (code) => (prod.skus || []).find((s) => String(s.sbomCode ?? s.skuId) === String(code));
const bound = skuOf(slot.sbomCode);
const boundColor = bound && bound.attrs && bound.attrs['颜色'];
const otherColors = [...new Set((prod.skus || []).map((s) => s.attrs && s.attrs['颜色']).filter((v) => v && v !== boundColor))];
log(`商品：${prod.name}；绑定 ${slot.sbomCode} 颜色=${boundColor}；其他颜色：${otherColors.join('、')}`);

const tabs = await listTabs(PORT);
const tab = tabs.find((t) => /comdetail/.test(t.url || ''));
const cdp = new CDP(tab.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');

const seen = [];
const isApi = (u) => !/\.(js|css|png|jpg|jpeg|webp|svg|woff2?|ttf|gif|mp4)(\?|$)/i.test(u)
  && /vmall\.com|huawei\.com/i.test(u);
cdp.on('Network.requestWillBeSent', (p) => {
  const u = (p.request && p.request.url) || '';
  if (isApi(u)) seen.push({ t: Date.now(), u: u.replace(/\?([^?]{80}).*$/, '?$1…'), m: p.request.method });
});

const readSel = () => cdp.eval(`(() => {
  const m = (document.body.innerText.match(/已选[：:]([^\\n]{1,60})/) || [''])[1] || '';
  const a = document.getElementById('prd-botnav-rightbtn');
  return JSON.stringify({ sel: m.trim(), btn: a ? (a.innerText || '').replace(/[\\s]+/g, ' ').trim().slice(0, 20) : null });
})()`).then((s) => JSON.parse(s || '{}'));

/** 内部 onPress 切换规格（芯片 fiber 向上找 onPress，callFunctionOn 带 userGesture） */
async function switchSpec(text) {
  const arm = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const want = ${JSON.stringify(text)};
      for (const el of document.querySelectorAll('div[tabindex]')) {
        const t = (el.innerText || '').replace(/[\\s]+/g, ' ').trim();
        if (t !== want) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0) continue;
        const key = Object.keys(el).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
        let node = key ? el[key] : null, hops = 0;
        while (node && hops < 25) {
          const p = node.memoizedProps;
          if (p && typeof p.onPress === 'function') { globalThis.__specTarget = p.onPress; return 'ARMED'; }
          node = node.return; hops++;
        }
      }
      globalThis.__specTarget = null;
      return 'NOFN';
    })()`,
    returnByValue: true,
  }).catch(() => null);
  if (!arm || arm.result.value !== 'ARMED') return arm ? arm.result.value : 'EVAL_ERR';
  const g = await cdp.send('Runtime.evaluate', { expression: 'globalThis.__specTarget', returnByValue: false, objectGroup: 'spec-press' });
  const fr = await cdp.send('Runtime.callFunctionOn', {
    objectId: g.result.objectId,
    functionDeclaration: 'function(){ try { this({ preventDefault(){}, stopPropagation(){} }); return "FIRED"; } catch (e) { return "ERR:" + e.message; } }',
    returnByValue: true, userGesture: true,
  }).catch((e) => ({ result: { value: 'ERR:' + e.message } }));
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'spec-press' }).catch(() => {});
  return fr.result && fr.result.value;
}

const s0 = await readSel();
log(`当前：已选「${s0.sel}」按钮「${s0.btn}」`);

const baseCount0 = seen.length;
await sleep(3000);
log(`\n静息 3 秒 API 请求数：${seen.length - baseCount0}`);
const cut0 = seen.length;

const other = otherColors[0];
log(`\n=== 内部 onPress 切到「${other}」 ===`);
const tClick = Date.now();
const r1 = await switchSpec(other);
log(`onPress 返回：${r1}`);
await sleep(5000);
const s1 = await readSel();
const fired = seen.slice(cut0);
log(`5 秒后：已选「${s1.sel}」按钮「${s1.btn}」`);
log(`新发起的 API 请求（${fired.length} 条，+ms 相对切换）：`);
fired.slice(0, 30).forEach((r) => log(`  +${r.t - tClick}ms ${r.m} ${r.u.slice(0, 120)}`));

log(`\n=== 切回「${boundColor}」 ===`);
const cut1 = seen.length;
const tBack = Date.now();
const r2 = await switchSpec(boundColor);
await sleep(5000);
const s2 = await readSel();
const fired2 = seen.slice(cut1);
log(`onPress 返回：${r2}；切回后：已选「${s2.sel}」按钮「${s2.btn}」`);
log(`切回触发的 API 请求（${fired2.length} 条）：`);
fired2.slice(0, 30).forEach((r) => log(`  +${r.t - tBack}ms ${r.m} ${r.u.slice(0, 120)}`));
log(s2.sel === s0.sel ? '✅ 已选恢复一致' : `⚠ 已选没恢复：${s2.sel} ≠ ${s0.sel}`);
process.exit(0);
