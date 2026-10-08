import { CDP, listTabs, sleep } from '../grab/cdp-core.mjs';
const PORT = 9401;
const tabs = await listTabs(PORT);
const tab = tabs.find((t) => /comdetail/.test(t.url || ''));
const cdp = new CDP(tab.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
const readCluster = async () => {
  const all = (await cdp.send('Network.getAllCookies', {})).cookies || [];
  const c = all.filter((x) => /^(cluster|cartId|casid|sdevid|TID|user|uid|CSRF-TOKEN)$/.test(x.name));
  return c.map((x) => `${x.name}=${x.expires > 0 ? new Date(x.expires * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : 'SESS'}`).join(' ');
};
console.log('before:', await readCluster());
// 页面上下文里 fetch 一个 vmall web 端点（同站，带 Cookie）
const r = await cdp.eval("(async () => { try { const r = await fetch('https://www.vmall.com/', { credentials: 'include', mode: 'no-cors' }); return 'status=' + r.status + ' type=' + r.type; } catch (e) { return 'ERR:' + e.message; } })()");
console.log('fetch vmall 首页:', r);
await sleep(1000);
console.log('after vmall/:', await readCluster());
const r2 = await cdp.eval("(async () => { try { const r = await fetch('https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN', { credentials: 'include' }); return 'status=' + r.status; } catch (e) { return 'ERR:' + e.message; } })()");
console.log('fetch queryUserInfo:', r2);
await sleep(1000);
console.log('after queryUserInfo:', await readCluster());
process.exit(0);
