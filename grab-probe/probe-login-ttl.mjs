#!/usr/bin/env node
/**
 * 登录态存活排查 + 规格按钮结构侦察（全部只读，不点击不下单）
 * =====================================================================
 * 1. 连专用窗口 → 读 sid/hwid_cas_sid 的 expires（判断：会话 Cookie 还是短寿命持久 Cookie）
 * 2. 问一次 queryUserInfo（页面自己的接口），看响应是否带 Set-Cookie 续期
 *    （用 CDP Network 事件抓响应头，比 fetch 可靠）
 * 3. 读全部 .id1.cloud.huawei.com / vmall.com Cookie 的名字+过期，画出"谁先死"
 * 4. 扫商品页规格按钮（RNW div[tabindex]）结构：文字、class、位置、fiber 是否在
 *
 * 用法：node grab-probe/probe-login-ttl.mjs [--port=9401]
 * =====================================================================
 */
import { CDP, sleep, listTabs } from '../grab/cdp-core.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PORT = Number(args.port) || 9401;
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);
const fmtExp = (exp) => {
  if (!exp || exp < 0) return '会话Cookie(关浏览器就没)';
  const dt = new Date(exp * 1000);
  const left = dt.getTime() - Date.now();
  const h = (left / 3600000).toFixed(1);
  return `${dt.toLocaleString('zh-CN', { hour12: false })}（剩 ${h} 小时）`;
};

const tabs = await listTabs(PORT);
const prod = tabs.find((t) => /comdetail/.test(t.url || ''));
if (!prod) { log('窗口里没有商品页标签。标签列表：'); tabs.forEach((t) => log('  ', t.type, (t.url || '').slice(0, 90))); process.exit(1); }
log(`商品页：${(prod.url || '').slice(0, 110)}`);

const cdp = new CDP(prod.webSocketDebuggerUrl);
await cdp.connect();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Network.enable');

/* ── 1. Cookie 过期时间全景 ── */
const all = await cdp.send('Network.getAllCookies', {});
const interesting = (all.cookies || []).filter((c) =>
  /id1\.cloud\.huawei\.com|vmall\.com$|\.vmall\.com$/.test(c.domain) && !/^(HWWAF|HWWAFSES|Hm_lvt|Hm_lpvt|WAF)/.test(c.name));
log('\n===== 关键 Cookie（按过期时间升序）=====');
interesting.sort((a, b) => (a.expires < 0 ? 1e15 : a.expires) - (b.expires < 0 ? 1e15 : b.expires));
for (const c of interesting.slice(0, 40)) {
  log(`  ${c.name.padEnd(22)} @${c.domain.padEnd(24)} 过期: ${fmtExp(c.expires)}  len=${(c.value || '').length}`);
}
const sid = interesting.find((c) => c.name === 'sid');
const cas = interesting.find((c) => c.name === 'hwid_cas_sid');
log(`\nsid          → ${sid ? fmtExp(sid.expires) : '（不存在）'}`);
log(`hwid_cas_sid → ${cas ? fmtExp(cas.expires) : '（不存在）'}`);

/* ── 2. queryUserInfo 是否续期 Cookie ── */
log('\n===== queryUserInfo 续期测试（抓响应头看 Set-Cookie）=====');
const respHeaders = [];
const onResp = (p) => { if (/queryUserInfo/.test(p.response.url)) respHeaders.push(p.response); };
cdp.on('Network.responseReceived', onResp);
const before = interesting.map((c) => `${c.name}:${c.expires}`);
const r = await cdp.eval(`(async () => {
  try {
    const r = await fetch('https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN', { credentials: 'include' });
    const t = await r.text();
    return JSON.stringify({ status: r.status, bodyHead: t.slice(0, 120) });
  } catch (e) { return JSON.stringify({ error: String(e.message || e) }); }
})()`).catch((e) => JSON.stringify({ error: e.message }));
await sleep(800);
log(`接口返回：${r}`);
if (respHeaders.length) {
  const h = respHeaders[respHeaders.length - 1].headers || {};
  const sc = Object.entries(h).filter(([k]) => /set-cookie/i.test(k));
  log(`响应头里 Set-Cookie：${sc.length ? JSON.stringify(sc.map(([, v]) => String(v).slice(0, 120))) : '（无——接口不续期 Cookie）'}`);
} else {
  log('（没抓到响应头事件——看下面的 Cookie 对比也能判断）');
}
const all2 = (await cdp.send('Network.getAllCookies', {})).cookies || [];
const after = all2.filter((c) => /id1\.cloud\.huawei\.com/.test(c.domain)).map((c) => `${c.name}:${c.expires}`);
const changed = after.filter((x) => !before.includes(x));
const gone = before.filter((x) => !after.includes(x));
log(`续期前后对比：${changed.length ? '有变化 → ' + JSON.stringify(changed) : '无变化（Cookie 过期时间没被刷新）'}${gone.length ? '；消失：' + JSON.stringify(gone) : ''}`);

/* ── 3. 规格按钮结构（RNW）── */
log('\n===== 规格按钮结构侦察 =====');
const spec = await cdp.eval(`(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = { yixuan: (document.body.innerText.match(/已选[：:]([^\\n]{1,60})/) || [''])[1] || null, chips: [] };
  // 规格区的候选：带 tabindex 的 div/span（RNW Pressable），且文字短
  for (const el of document.querySelectorAll('#prd-detail div[tabindex], div[tabindex]')) {
    const t = clean(el.innerText);
    if (!t || t.length > 24) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const aria = el.getAttribute('aria-selected') || el.getAttribute('data-selected') || '';
    out.chips.push({
      text: t.slice(0, 24), cls: String(el.className || '').slice(0, 60),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      aria, tabindex: el.getAttribute('tabindex'),
    });
    if (out.chips.length >= 30) break;
  }
  // 已选样式探测：找出与"已选"文字匹配的 chip 的 class 差异
  return out;
})()`);
log(`页面已选：${spec.yixuan}`);
spec.chips.forEach((c) => log(`  [${c.x},${c.y}] "${c.text}" aria=${c.aria || '-'} cls=${c.cls.slice(0, 40)}`));

process.exit(0);
