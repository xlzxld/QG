/**
 * 登录判据 · CDP 侧实测（2026-10-07）
 *
 * 验证 cdp-core.mjs 里 readLoginState()（驱动 + 体检共用）在真实环境下判得准：
 *   · 未登录（无头新 profile） → 应判 loggedIn=false
 *   · 已登录（acc1 专用窗口）  → 应判 loggedIn=true
 *
 * 用法：node grab-probe/verify-login-cdp.mjs
 */
import { chromium } from 'playwright-core';
import { CDP, readLoginState } from '../grab/cdp-core.mjs';

const PAGE = 'https://item.vmall.com/product/comdetail/index.html?prdId=10086683896486&sbomCode=2601010634026';

/* ── 未登录：无头新 profile，通过 CDP 连进去读 ── */
async function anonViaCdp() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--remote-debugging-port=9500'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const tabs = await (await fetch('http://127.0.0.1:9500/json/list')).json();
  const tab = tabs.find((t) => t.type === 'page' && /comdetail/.test(t.url)) || tabs.find((t) => t.type === 'page');
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Network.enable');
  const r = await readLoginState(cdp);
  await browser.close();
  return r;
}

/* ── 已登录：acc1 专用窗口 ── */
async function acc1ViaCdp(port) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const tab = tabs.find((t) => t.type === 'page' && /comdetail/.test(t.url)) || tabs.find((t) => t.type === 'page');
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Network.enable');
  const r = await readLoginState(cdp);
  try { cdp.ws.close(); } catch { /* 收尾 */ }
  return r;
}

console.log('判据：sid / hwid_cas_sid @ .id1.cloud.huawei.com\n');

const a = await anonViaCdp();
console.log(`【未登录（无头新 profile）】loggedIn=${a.loggedIn}`);
console.log(`  ${a.evidence}`);
console.log(`  ${a.loggedIn === false ? '✅ 判对了' : '❌ 判错了'}`);

const b = await acc1ViaCdp(9401);
console.log(`\n【已登录（acc1 专用窗口）】loggedIn=${b.loggedIn}`);
console.log(`  ${b.evidence}`);
console.log(`  ${b.loggedIn === true ? '✅ 判对了' : '❌ 判错了'}`);

const pass = a.loggedIn === false && b.loggedIn === true;
console.log(`\n${pass ? '===== 两侧都判对：共用判据可用 =====' : '===== 有误判 ====='}`);
process.exit(pass ? 0 : 1);