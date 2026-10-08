#!/usr/bin/env node
/**
 * 拦截链路自测（本地 mock 页 + 真 Chrome，不碰 vmall）
 * =====================================================================
 * 用本地假 vmall 页面把 B 方案整条链跑通：
 *   Fetch 拦截 → R1 改写 startTime → 页面按钮提前解锁 → 可信点击
 *   → 确认订单页（新标签）→ 可信点击「提交订单」→ mock 服务器收到提交
 *   → R2 排队脚本样本留证。
 * 再验证第二件事：leadMs=0 时响应必须原样到达页面（放行路径不弄坏页面）。
 *
 * 用法：node grab/selftest-intercept.mjs
 * 退出码 0=全链通过。全程约 30 秒。
 * =====================================================================
 */

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CDP, cdpUp, listTabs, sleep, trustedClick, CHROME } from './cdp-core.mjs';
import { installInterception } from './intercept/install.mjs';

const PROFILE = fileURLToPath(new URL('../data/grab/selftest-profile/', import.meta.url));
const PORT_HTTP_FIRST = 9461;
const PORT_CDP_FIRST = 9462;
const LEAD_MS = 9000; // mock 开售 = 请求时刻+10s；改写-9s → 页面加载约 1s 后解锁
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ── mock vmall ─────────────────────────────── */
// saleAt 是固定时刻（与真实 vmall 一致：开售时刻不随请求变）。
// 阶段间用 /__setSale 重设，模拟"下一场开售"。
const serverState = { submitted: false, rushHits: 0, saleAt: Date.now() + 10000 };
const PAGE_HTML = `<!doctype html><html><body>
<div id="prd-botnav-rightbtn"><span id="buyBtn">暂不售卖</span></div>
<script>
window.__lastResp = null;
async function poll() {
  try {
    const r = await fetch('/queryRushbuyInfo.json?sbomCodes=X1');
    const j = await r.json();
    window.__lastResp = j;
    const st = Number(j.skuRushBuyInfoList[0].startTime);
    if (st <= Date.now()) {
      const b = document.getElementById('buyBtn');
      if (b.innerText !== '立即购买') {
        b.innerText = '立即购买';
        b.parentElement.onclick = () => window.open('/orderConfirm');
        fetch('/queue.js'); // 模拟商品页对排队脚本的预取（R2 留证路径）
      }
    }
  } catch (e) { window.__lastErr = String(e); }
}
setInterval(poll, 200); poll();
</script></body></html>`;
const CONFIRM_HTML = `<!doctype html><html><head><script src="/queue.js"></script></head><body>
<div id="pay">应付 ¥5999</div>
<button id="submitBtn">提交订单</button>
<div id="done"></div>
<script>
document.getElementById('submitBtn').onclick = async () => {
  await fetch('/submitOrder');
  document.getElementById('done').innerText = '订单号：MOCK-SELFTEST-001';
};
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/__setSale')) {
    const inMs = Number(new URL(url, 'http://x').searchParams.get('inMs')) || 10000;
    serverState.saleAt = Date.now() + inMs;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ saleAt: serverState.saleAt }));
  }
  if (url.startsWith('/queryRushbuyInfo.json')) {
    serverState.rushHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      currentTime: Date.now(),
      skuRushBuyInfoList: [{ sbomCode: 'X1', startTime: serverState.saleAt }],
    }));
  }
  if (url.startsWith('/orderConfirm')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(CONFIRM_HTML);
  }
  if (url.startsWith('/submitOrder')) {
    serverState.submitted = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (url.startsWith('/queue.js')) {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end('// mock queue script');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});

const listen = (port) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));

/* ── Chrome ─────────────────────────────── */
let chromeChild = null;
async function launchChrome(port, url) {
  fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(PROFILE, { recursive: true });
  chromeChild = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1100,800',
    '--disable-features=CalculateNativeWinOcclusion',
    url,
  ], { detached: false, stdio: 'ignore' });
}
function killChrome() {
  if (!chromeChild) return;
  try { spawnSync('taskkill', ['/PID', String(chromeChild.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  chromeChild = null;
}

/* ── 主流程 ─────────────────────────────── */
async function main() {
  const httpPort = await listen(PORT_HTTP_FIRST);
  const base = `http://127.0.0.1:${httpPort}`;
  console.log(`mock vmall: ${base}`);

  let cdpPort = PORT_CDP_FIRST;
  while (await cdpUp(cdpPort)) cdpPort++; // 避开已占用的调试端口
  await launchChrome(cdpPort, 'about:blank');

  let t0;
  try {
    // 等调试端口起来 + 拿到 about:blank 标签
    let tab = null;
    for (let i = 0; i < 60 && !tab; i++) {
      await sleep(500);
      try { tab = (await listTabs(cdpPort)).find((t) => /about:blank/.test(t.url)) || (await listTabs(cdpPort))[0]; } catch { /* 未起 */ }
    }
    if (!tab) throw new Error('Chrome 调试端口未就绪');
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // 安装拦截：显式 patterns（只指 mock 域），leadMs=9000
    const cfg = { intercept: { enabled: true, leadMs: LEAD_MS, patterns: [`*://${base.replace('http://', '')}/queryRushbuyInfo.json*`, `*://${base.replace('http://', '')}/queue.js*`] } };
    const icStat = await installInterception(cdp, cfg, (m) => console.log('  [intercept]', m));
    ok('拦截安装', !!icStat && icStat.patterns.length === 2);

    // ── 阶段 1：R1 改写 → 按钮提前解锁 ──
    // 开售时刻设为 10s 后（固定值，模拟真实场次）；改写提前 9s → 页面应在 ~1s 解锁
    await fetch(`${base}/__setSale?inMs=10000`);
    t0 = Date.now();
    await cdp.send('Page.navigate', { url: `${base}/` });
    await sleep(800);
    let unlockedAt = null;
    let lastResp = null;
    while (Date.now() - t0 < 8000) {
      const r = await cdp.eval(`(() => ({ btn: document.getElementById('buyBtn').innerText, resp: window.__lastResp, err: window.__lastErr || null }))()`).catch(() => null);
      if (r && r.resp) lastResp = r.resp;
      if (r && r.btn === '立即购买') { unlockedAt = Date.now(); break; }
      await sleep(150);
    }
    ok('R1 按钮提前解锁', !!unlockedAt && unlockedAt - t0 < 5000,
      unlockedAt ? `页面加载后 ${unlockedAt - t0}ms 解锁（不改写要等 ~10s）` : '8 秒内未解锁');
    ok('R1 响应确实被改写', !!lastResp && Number(lastResp.skuRushBuyInfoList[0].startTime) <= Date.now() + 2000,
      lastResp ? `页面收到的 startTime=${lastResp.skuRushBuyInfoList[0].startTime}` : '页面没拿到响应');
    ok('R1 改写计数', icStat.rewritten >= 1, `rewritten=${icStat.rewritten}`);

    // ── 阶段 2：可信点击 → 确认页新标签 ──
    const pos = await cdp.eval(`(() => {
      const el = document.getElementById('buyBtn');
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await trustedClick(cdp, pos.x, pos.y);
    let confirmTab = null;
    const cT0 = Date.now();
    while (Date.now() - cT0 < 6000) {
      await sleep(300);
      confirmTab = (await listTabs(cdpPort)).find((t) => /orderConfirm/.test(t.url));
      if (confirmTab) break;
    }
    ok('可信点击 → 确认订单页（新标签）', !!confirmTab, confirmTab ? `${Date.now() - cT0}ms 内出现` : '6 秒内未出现');

    // ── 阶段 3：确认页可信点击提交 → mock 服务器收到 ──
    if (confirmTab) {
      const c2 = new CDP(confirmTab.webSocketDebuggerUrl);
      await c2.connect();
      await c2.send('Runtime.enable');
      let sPos = null;
      for (let i = 0; i < 20 && !sPos; i++) {
        await sleep(300);
        sPos = await c2.eval(`(() => {
          const el = document.getElementById('submitBtn');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return r.width > 0 ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
        })()`).catch(() => null);
      }
      ok('确认页找到「提交订单」', !!sPos);
      if (sPos) {
        await trustedClick(c2, sPos.x, sPos.y);
        let doneText = null;
        const sT0 = Date.now();
        while (Date.now() - sT0 < 5000) {
          await sleep(200);
          if (serverState.submitted) {
            doneText = await c2.eval(`document.getElementById('done').innerText`).catch(() => null);
            if (doneText) break;
          }
        }
        ok('提交订单到达 mock 服务器', serverState.submitted);
        ok('页面显示真实回执', !!doneText && doneText.includes('MOCK-SELFTEST-001'), doneText || '未读到');
      }
      try { c2.ws.close(); } catch { /* 收尾 */ }
    }

    // ── 阶段 4：R2 排队脚本样本留证 ──
    await sleep(500);
    ok('R2 排队脚本样本已留证', icStat.samples.length >= 1, icStat.samples.map((s) => s.url).join(', ') || '无样本');
    ok('拦截零失败', icStat.failures === 0, `failures=${icStat.failures} passthrough=${icStat.passthrough}`);

    // ── 阶段 5：leadMs=0 放行路径——响应必须原样到达 ──
    // installInterception 的闭包直接引用 cfg.intercept 对象，原地改 leadMs 即可
    // 生效（不重装 Fetch.enable，避免注册出第二个 requestPaused 监听器）。
    cfg.intercept.leadMs = 0;
    await fetch(`${base}/__setSale?inMs=10000`); // 新一场：10s 后开售
    serverState.rushHits = 0;
    const pT0 = Date.now();
    await cdp.send('Page.navigate', { url: `${base}/?pass=1` });
    let passOk = false;
    while (Date.now() - pT0 < 6000) {
      await sleep(300);
      const r = await cdp.eval(`(() => ({ btn: document.getElementById('buyBtn').innerText, resp: window.__lastResp }))()`).catch(() => null);
      // 原样放行的判定：页面拿到了响应（startTime≈now+10s，未被改写），按钮尚未解锁
      if (r && r.resp && r.btn !== '立即购买') {
        const st = Number(r.resp.skuRushBuyInfoList[0].startTime);
        passOk = st > Date.now() + 3000; // 还没到点 = 未被改提前
        break;
      }
    }
    ok('leadMs=0 响应原样放行（页面不被弄坏）', passOk);
  } finally {
    killChrome();
    server.close();
  }

  const fails = results.filter((r) => !r.pass);
  console.log(`\n===== 自测结果：${results.length - fails.length}/${results.length} 通过 =====`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`[自测异常] ${e.message}`);
  killChrome();
  process.exit(1);
});
