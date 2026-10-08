#!/usr/bin/env node
/**
 * 槽位登录预检（2026-10-08 10:00 定时任务第一步）：逐个窗口问服务端"我登录了吗"
 * 返回码：0=全部登录正常；2=有窗口掉线（输出哪个）；3=有窗口没在跑
 * 2026-10-08 晚改：端口从槽位文件动态读（新增 acc3 等槽位后自动纳入检查，
 * 不再写死 9401/9402 漏掉新窗口）。
 */
import fs from 'node:fs';
import { CDP, listTabs, judgeVmallLoginBody } from '../core/cdp-core.mjs';

const PORTS = (() => {
  try {
    const sf = JSON.parse(fs.readFileSync(new URL('../data/grab/rush-slots.huawei.json', import.meta.url), 'utf8'));
    const ps = [...new Set((sf.slots || []).map((s) => Number(s && s.port)).filter(Boolean))].sort((a, b) => a - b);
    if (ps.length) return ps;
  } catch { /* 读不到就退回默认 */ }
  return [9401, 9402];
})();
console.log(`本次检查 ${PORTS.length} 个槽位窗口：${PORTS.join('、')}（端口清单来自槽位文件）`);
let bad = 0;
for (const port of PORTS) {
  try {
    const up = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json().catch(() => null);
    if (!up) { console.log(`端口 ${port}：❌ 专用窗口没在运行（需要先手动打开或派发一次）`); bad = Math.max(bad, 3); continue; }
    const tabs = await listTabs(port);
    const tab = tabs.find((t) => /comdetail/.test(t.url || '')) || tabs[0];
    if (!tab) { console.log(`端口 ${port}：❌ 窗口里没有商品页标签`); bad = Math.max(bad, 3); continue; }
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable').catch(() => {});
    const r = await cdp.eval(`(async () => {
      try {
        const r = await fetch('https://openapi.vmall.com/mcp/queryUserInfo?portal=1&lang=zh_CN&country=CN', { credentials: 'include' });
        return (await r.text()).slice(0, 300);
      } catch (e) { return '__ERR__' + ((e && e.message) || e); }
    })()`).catch(() => '__ERR__');
    try { cdp.ws.close(); } catch { /* 忽略 */ }
    // 2026-10-08：vmall 部分响应会把 "s" 挖成空格（userInfo→"u erInfo"），原文正则
    // 会把已登录误判成掉线（13:58 误报 9401 即此因）。统一走抗混淆判定。
    const verdict = String(r).startsWith('__ERR__') ? 'err' : judgeVmallLoginBody(r);
    const nick = (String(r).match(/"nickName"\s*:\s*"([^"]*)"/) || [])[1] || '';
    if (verdict === 'ok') console.log(`端口 ${port}（${tab.title || ''}）：✅ 已登录（${nick || '昵称未读到'}）`);
    else if (verdict === null) console.log(`端口 ${port}（${tab.title || ''}）：⚠️ 响应读不懂（不当掉线，建议窗口里人工瞄一眼）：${String(r).replace(/\s+/g, ' ').slice(0, 80)}`);
    else if (verdict === 'err') { console.log(`端口 ${port}：❌ 检查出错（${String(r).slice(7)}）`); bad = Math.max(bad, 2); }
    else { console.log(`端口 ${port}：❌ 未登录——去这个窗口登录一次华为账号！`); bad = Math.max(bad, 2); }
  } catch (e) {
    console.log(`端口 ${port}：❌ 检查出错（${e.message}）`);
    bad = Math.max(bad, 3);
  }
}
await new Promise((r) => setTimeout(r, 400));
process.exit(bad);
