#!/usr/bin/env node
/**
 * 槽位选品探测：在指定槽位窗口里逐个检查候选 SKU 是否"现货可买"。
 * 用途：配槽位前挑有货的 SKU；或排查"驱动盯不到购买按钮"。
 *
 * 用法：node grab/probe-sku.mjs --port=9402 --sbom=2601010615067,2601010615069
 *   不传 --sbom 时默认探测该商品的全部 24 个 SKU 编号（从采集目录读）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const PORT = Number(args.port || 9401);
const PRD = String(args.prdId || '10086621059876');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let candidates = args.sbom ? String(args.sbom).split(',') : [];
if (!candidates.length) {
  try {
    const cat = JSON.parse(readFileSync(new URL('../data/grab/huawei.catalog.json', import.meta.url), 'utf8'));
    const prods = Array.isArray(cat) ? cat : cat.products || [cat];
    const prod = prods.find((p) => (p.prdId || '').includes(PRD) || JSON.stringify(p).includes(PRD));
    const skus = (prod && (prod.skus || [])) || [];
    candidates = skus.map((s) => s.skuId ?? s.sbomCode ?? s.code).filter(Boolean);
  } catch {
    console.error('读采集目录失败，请用 --sbom= 指定候选');
    process.exit(1);
  }
}

const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = tabs.filter((t) => t.type === 'page' && /comdetail/.test(t.url)).pop()
  || tabs.find((t) => t.type === 'page');
if (!tab) { console.error('窗口里没有页面标签'); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', () => j(new Error('CDP 连接失败')), { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
async function evalJs(expr) {
  for (let i = 0; i < 12; i++) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (!r.exceptionDetails && r.result && r.result.value !== undefined) return r.result.value;
    await sleep(700);
  }
  return null;
}

console.log(`探测 ${candidates.length} 个候选 SKU（窗口端口 ${PORT}）`);
for (const sb of candidates) {
  await send('Page.navigate', { url: `https://item.vmall.com/product/comdetail/index.html?prdId=${PRD}&sbomCode=${sb}` });
  await sleep(6000);
  const r = await evalJs(`(() => {
    const t = document.body ? document.body.innerText : '';
    const btns = [];
    for (const el of document.querySelectorAll('a,button,div,span')) {
      const s = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (s && s.length <= 12 && /立即购买|加入购物车/.test(s)) btns.push(s);
    }
    return {
      oos: /暂时缺货|售罄|无货|补货中/.test(t),
      buy: btns.some((s) => s.includes('立即购买')) || (btns.length > 0 && !/暂时缺货/.test(t)),
      label: (t.match(/HUAWEI Pura X Max[^\\n]{0,30}/) || [''])[0],
    };
  })()`);
  if (!r) { console.log(`${sb}  探测失败（页面没就绪？）`); continue; }
  const tag = r.buy && !r.oos ? '✅ 现货可买' : r.oos ? '⛔ 缺货' : '⚠️ 未知';
  console.log(`${sb}  ${tag}  ${r.label}`);
  await sleep(400);
}
ws.close();
