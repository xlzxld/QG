/** 规格芯片点击失败诊断：悬停是否弹浮层 + 真点击 + fiber onPress 三种路径对比 */
import { CDP, listTabs, trustedClick, sleep } from '../grab/cdp-core.mjs';
const PORT = 9401;
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);
const tabs = await listTabs(PORT);
const tab = tabs.find((t) => /comdetail/.test(t.url || ''));
const cdp = new CDP(tab.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');

const SEL_EXPR = "((document.body.innerText.match(/已选[：:]([^\\n]{1,60})/) || [''])[1] || '').trim()";

const FIND = `(() => {
  const want = '曜石黑';
  for (const el of document.querySelectorAll('div[tabindex]')) {
    const t = (el.innerText || '').replace(/[\\s]+/g, ' ').trim();
    if (t !== want) continue;
    const r0 = el.getBoundingClientRect();
    if (r0.width <= 0) continue;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const key = Object.keys(el).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
    let node = key ? el[key] : null, hops = 0, found = null;
    while (node && hops < 25) {
      const p = node.memoizedProps;
      if (p && typeof p.onPress === 'function') { found = { hops, srcHead: String(p.onPress).slice(0, 160) }; break; }
      node = node.return; hops++;
    }
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), onPress: found });
  }
  return null;
})()`;
const info = JSON.parse((await cdp.eval(FIND)) || 'null');
log('芯片信息：', JSON.stringify(info, null, 1));

// ① 悬停诊断：mouseMoved 之后 elementFromPoint 命中了谁
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y, pointerType: 'mouse' });
await sleep(600);
const hit = await cdp.eval(`(() => {
  const hit = document.elementFromPoint(${info.x}, ${info.y});
  return hit ? JSON.stringify({ tag: hit.tagName, cls: String(hit.className || '').slice(0, 70), text: (hit.innerText || '').replace(/[\\s]+/g, ' ').slice(0, 30), cursor: getComputedStyle(hit).cursor }) : null;
})()`);
log('悬停后 elementFromPoint 命中：', hit);

// ② 完整真点击序列
const selBefore = await cdp.eval(SEL_EXPR);
await trustedClick(cdp, info.x, info.y);
await sleep(2500);
const selAfter = await cdp.eval(SEL_EXPR);
log(`真点击后已选：「${selBefore}」→「${selAfter}」${selBefore !== selAfter ? ' ✅ 切换成功' : ' ❌ 还是没切'}`);

// ③ 没切成 → 内部 onPress（带 userGesture 的 callFunctionOn）
if (selBefore === selAfter) {
  log('改用内部 onPress…');
  const arm = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const want = '曜石黑';
      for (const el of document.querySelectorAll('div[tabindex]')) {
        const t = (el.innerText || '').replace(/[\\s]+/g, ' ').trim();
        if (t !== want) continue;
        const key = Object.keys(el).find((k) => /^__react(Fiber|InternalInstance)\\$/.test(k));
        let node = key ? el[key] : null, hops = 0;
        while (node && hops < 25) {
          const p = node.memoizedProps;
          if (p && typeof p.onPress === 'function') { globalThis.__specTarget = p.onPress; return 'ARMED'; }
          node = node.return; hops++;
        }
      }
      return 'NOFN';
    })()`,
    returnByValue: false, objectGroup: 'spec-press',
  }).catch(() => null);
  const r0 = arm && arm.result;
  const objId = r0 && (r0.objectId || (r0.value === 'ARMED' && r0.objectId));
  // ARMED 返回的是字符串——重新拿函数对象
  let fnObjectId = null;
  if (r0 && r0.value === 'ARMED') {
    const g = await cdp.send('Runtime.evaluate', { expression: 'globalThis.__specTarget', returnByValue: false, objectGroup: 'spec-press' }).catch(() => null);
    fnObjectId = g && g.result && g.result.objectId;
  }
  if (fnObjectId) {
    const fr = await cdp.send('Runtime.callFunctionOn', {
      objectId: fnObjectId,
      functionDeclaration: 'function(){ try { this({ preventDefault(){}, stopPropagation(){} }); return "FIRED"; } catch (e) { return "ERR:" + e.message; } }',
      returnByValue: true, userGesture: true,
    }).catch((e) => ({ result: { value: 'ERR:' + e.message } }));
    log(`内部 onPress 调用返回：${fr.result && fr.result.value}`);
    await sleep(2500);
    const selFinal = await cdp.eval(SEL_EXPR);
    log(`调用后已选：「${selFinal}」${selFinal !== selBefore ? ' ✅ 切换成功' : ' ❌ 没切'}`);
  } else {
    log('onPress 不可达：', JSON.stringify(r0 && r0.value));
  }
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'spec-press' }).catch(() => {});
}
process.exit(0);
