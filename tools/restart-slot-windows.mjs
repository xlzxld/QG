#!/usr/bin/env node
/** 重启槽位窗口（吃进 --disable-features=CalculateNativeWinOcclusion 修复）。
 *  登录态在磁盘 profile 里，重启不丢；服务端会话若失效，登录一次即可。
 *  2026-10-08 两处升级：
 *  ① 先走 CDP Browser.close 优雅关闭（Chrome 记"正常退出"），强杀只做兜底——
 *     之前 taskkill /F 直接毙掉，下次启动必弹「要恢复页面吗？Chrome 未正确关闭」，
 *     两个专用窗口都中过招；用户若手滑点了"恢复"还会把旧标签（可能含草稿订单页）拉回来。
 *  ② 启动参数加 --hide-crash-restore-bubble：就算将来真的崩过，也不弹恢复条。 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CDP } from '../core/cdp-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

const slots = JSON.parse(readFileSync(ROOT + 'data\\grab\\rush-slots.huawei.json', 'utf8')).slots || [];
if (!slots.length) { console.log('槽位是空的，没窗口可重启'); process.exit(0); }

// 第一步：优雅关闭（能连上调试端口就走 Browser.close，正常退出不留"未正确关闭"标记）
for (const s of slots) {
  try {
    const ver = await (await fetch(`http://127.0.0.1:${s.port}/json/version`)).json();
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(5000)]);
    try { cdp.ws.close(); } catch { /* 浏览器已退 */ }
    log(`已优雅关闭 ${s.id}（端口 ${s.port}）`);
  } catch {
    log(`端口 ${s.port} 没在跑或连不上（${s.id}），跳过优雅关闭`);
  }
}

await sleep(3000); // 给 Chrome 时间写盘退出

// 第二步：兜底强杀幸存者（优雅关闭失败/卡死的才轮得到）
try {
  const out = execSync('wmic process where "name=\'chrome.exe\'" get ProcessId,CommandLine /format:csv', { encoding: 'utf8' });
  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!line.includes('chrome-profile-rush')) continue;
    const m = line.trim().match(/(\d+)$/);
    if (m) pids.add(m[1]);
  }
  for (const pid of pids) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); log(`兜底强杀残留进程 ${pid}`); } catch { /* 已退出 */ }
  }
} catch (e) { log('枚举进程失败：' + e.message); }

await sleep(2000);

for (const s of slots) {
  const p = spawn(CHROME, [
    `--user-data-dir=${ROOT}data\\grab\\chrome-profile-rush\\${s.id}`,
    `--remote-debugging-port=${s.port}`,
    '--no-first-run', '--no-default-browser-check', '--start-maximized',
    '--disable-features=CalculateNativeWinOcclusion',
    '--hide-crash-restore-bubble',
    `https://item.vmall.com/product/comdetail/index.html?prdId=${s.prdId}&sbomCode=${s.sbomCode}`,
  ], { detached: true, stdio: 'ignore' });
  p.unref();
  log(`已重启 ${s.id} 窗口（端口 ${s.port}，带遮挡修复+弹条抑制）`);
}
await sleep(2000);
process.exit(0);
