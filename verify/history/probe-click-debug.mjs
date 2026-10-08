/** 点击调试：当前页面状态下，真点击 vs 内部入口，哪个能开确认页 */
import { CDP, listTabs, trustedClick, sleep } from '../grab/cdp-core.mjs';
const PORT = 9401;
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);
const tabs0 = new Set((await listTabs(PORT)).map((t) => t.id));
const tab = (await listTabs(PORT)).find((t) => /comdetail/.test(t.url || ''));
const cdp = new CDP(tab.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

// ① 读按钮状态 + 坐标
const st = await cdp.eval(`(() => {
  const a = document.getElementById('prd-botnav-rightbtn');
  const sel = (document.body.innerText.match(/已选[：:]([^\\n]{1,60})/) || [''])[1] || '';
  if (!a) return JSON.stringify({ btn: null, sel });
  const r = a.getBoundingClientRect();
  const host = a.querySelector('div[tabindex]');
  const hr = host ? host.getBoundingClientRect() : null;
  return JSON.stringify({
    btn: (a.innerText || '').replace(/[\\s]+/g, ' ').trim().slice(0, 16),
    sel: sel.trim(),
    anchor: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.bottom > 0 && r.top < innerHeight },
    host: hr ? { x: Math.round(hr.left + hr.width / 2), y: Math.round(hr.top + hr.height / 2) } : null,
    innerSize: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollY: Math.round(scrollY) },
  });
})()`);
log('按钮状态：', st);
const info = JSON.parse(st);

if (!info.btn || !/立即购买/.test(info.btn)) { log('按钮不是可买状态，退出'); process.exit(0); }

// ② 真点击锚点中心
log('真点击锚点中心…');
await trustedClick(cdp, info.anchor.x, info.anchor.y);
await sleep(4000);
let ts = await listTabs(PORT);
let cf = ts.find((t) => /orderConfirm/.test(t.url || '') && !tabs0.has(t.id));
log(cf ? `✅ 点击开出确认页：${cf.url.slice(0, 80)}` : '❌ 点击没开确认页');
if (cf) { await fetch(`http://127.0.0.1:${PORT}/json/close/${cf.id}`).catch(() => {}); process.exit(0); }

// ③ 点击 host（tabindex 元素）中心
if (info.host) {
  log(`真点击 host (${info.host.x},${info.host.y})…`);
  await trustedClick(cdp, info.host.x, info.host.y);
  await sleep(4000);
  ts = await listTabs(PORT);
  cf = ts.find((t) => /orderConfirm/.test(t.url || '') && !tabs0.has(t.id));
  log(cf ? `✅ host 点击开出确认页` : '❌ host 点击也没开');
  if (cf) { await fetch(`http://127.0.0.1:${PORT}/json/close/${cf.id}`).catch(() => {}); process.exit(0); }
}

// ④ 内部入口
log('内部入口…');
const r1 = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const root = document.getElementById('prd-botnav-rightbtn');
    if (!root) return null;
    const host = root.querySelector('div[tabindex]') || root.querySelector('[tabindex]');
    if (!host) return null;
    const key = Object.keys(host).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
    let node = key ? host[key] : null, hops = 0;
    while (node && hops < 25) {
      const p = node.memoizedProps;
      if (p && typeof p.onPress === 'function') { globalThis.__dbgPress = p.onPress; return 'ARMED'; }
      node = node.return; hops++;
    }
    return null;
  })()`,
  returnByValue: true,
}).catch((e) => ({ result: { value: 'EVAL_ERR:' + e.message } }));
log('arm:', r1.result && r1.result.value);
if (r1.result && r1.result.value === 'ARMED') {
  const g = await cdp.send('Runtime.evaluate', { expression: 'globalThis.__dbgPress', returnByValue: false });
  const fr = await cdp.send('Runtime.callFunctionOn', {
    objectId: g.result.objectId,
    functionDeclaration: 'function(){ try { this(); return "FIRED"; } catch (e) { return "ERR:" + e.message; } }',
    returnByValue: true, userGesture: true,
  });
  log('fire:', fr.result && fr.result.value);
  await sleep(4000);
  ts = await listTabs(PORT);
  cf = ts.find((t) => /orderConfirm/.test(t.url || '') && !tabs0.has(t.id));
  log(cf ? `✅ 内部入口开出确认页` : '❌ 内部入口也没开');
  if (cf) await fetch(`http://127.0.0.1:${PORT}/json/close/${cf.id}`).catch(() => {});
}
process.exit(0);
