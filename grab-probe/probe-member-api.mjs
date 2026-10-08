/**
 * 找用户信息接口（2026-10-07）
 *
 * 上一轮在产品页找不到账户入口。改从两处找线索：
 *   1. 产品页 DOM 里所有含 member/user/account 的 <a> 链接
 *   2. 在 acc1 里新开一个标签访问会员页，抓它请求的用户信息接口
 * 找到之后再回产品页验证：该接口能否区分登录态（那才是可用的响应判据）。
 *
 * 用法：node grab-probe/probe-member-api.mjs
 */
import { CDP } from '../grab/cdp-core.mjs';

const PORT = 9401;
const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = tabs.find((t) => t.type === 'page' && /comdetail/.test(t.url)) || tabs.find((t) => t.type === 'page');

const cdp = new CDP(tab.webSocketDebuggerUrl);
await cdp.connect();

const links = await cdp.eval(`(() => {
  const out = [];
  document.querySelectorAll('a').forEach((a) => {
    const h = a.getAttribute('href') || '';
    if (/member|user|account|login|uc\\.|passport/i.test(h)) out.push(h.slice(0, 120));
  });
  return JSON.stringify([...new Set(out)].slice(0, 20));
})()`);
console.log('产品页里的账户类链接：');
const urls = JSON.parse(links);
if (!urls.length) console.log('  （无）');
for (const u of urls) console.log(`  ${u}`);

// 挑一个会员页地址（优先 member）
const memberUrl = urls.find((u) => /member/i.test(u))
  || urls.find((u) => /user|account/i.test(u))
  || 'https://www.vmall.com/member/index.html';
const abs = memberUrl.startsWith('http') ? memberUrl : `https://www.vmall.com${memberUrl.startsWith('/') ? '' : '/'}${memberUrl}`;
console.log(`\n新标签访问：${abs}`);

// 新开标签（Chrome 新版要求 PUT）
const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(abs)}`, { method: 'PUT' })
  .then((r) => r.json()).catch((e) => ({ error: String(e) }));
if (created.error) { console.log(`开标签失败：${created.error}`); process.exit(1); }

const m = new CDP(created.webSocketDebuggerUrl);
await m.connect();
await m.send('Network.enable', { maxResourceBufferSize: 20 * 1024 * 1024 });
await m.send('Page.enable');

const recs = [];
m.on('Network.requestWillBeSent', (p) => {
  if (/vmall|huawei/i.test(p.request.url)) recs.push({ requestId: p.requestId, url: p.request.url, method: p.request.method });
});
m.on('Network.responseReceived', (p) => {
  const hit = recs.find((x) => x.requestId === p.requestId);
  if (hit) hit.status = p.response.status;
});

await new Promise((r) => setTimeout(r, 12000));

console.log(`\n会员页共 ${recs.length} 条请求（去重后）：`);
const seen = new Set();
for (const r of recs) {
  const p = r.url.replace(/^https?:\/\//, '').split('?')[0];
  if (seen.has(p + r.method)) continue;
  seen.add(p + r.method);
  console.log(`  [${r.status || '?'}] ${r.method} ${p}`);
}

console.log('\n含用户信息的响应：');
const USERISH = /昵称|nickName|memberLevel|会员|积分|point|头像|avatar|mobile|userName|accountName|等级|成长值/i;
let n = 0;
for (const r of recs) {
  if (!/openapi|member|user|account|bhm|uc\./i.test(r.url)) continue;
  const body = await m.send('Network.getResponseBody', { requestId: r.requestId }).catch(() => null);
  const txt = body?.body ? Buffer.from(body.body, body.bodyIsBase64 ? 'base64' : 'utf8').toString('utf8') : '';
  if (!txt) continue;
  if (USERISH.test(txt) || /未登录|not login/i.test(txt)) {
    n++;
    console.log(`\n  ● [${r.status}] ${r.url.split('?')[0].replace(/^https?:\/\//, '')}`);
    console.log(`    ${txt.replace(/\s+/g, ' ').slice(0, 350)}`);
  }
}
if (!n) console.log('  （没抓到）');

// 关掉新标签，保持 acc1 原状态
await fetch(`http://127.0.0.1:${PORT}/json/close/${created.id}`).catch(() => {});
console.log('\n（已关闭新标签）');
try { cdp.ws.close(); } catch { /* 收尾 */ }