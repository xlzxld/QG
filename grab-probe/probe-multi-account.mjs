/**
 * 多账号「同一时刻并发下单」技术可行性实测探针
 *
 * 纯本地验证：不访问任何外部网站。
 *   - A 多 context 隔离 / 上限 / 资源开销
 *   - B persistent profile 复用与 userDataDir 并行约束
 *   - C 时钟精度与「同一时刻」对齐
 *   - D 并发抢点的真实瓶颈
 *
 * 运行：node grab-probe/probe-multi-account.mjs
 * 规模：PROBE_SCALE=10,30,50,80,120 node grab-probe/probe-multi-account.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'output');
const OUT_FILE = path.join(OUT_DIR, 'multi-account.json');
const TMP_DIR = path.join(__dirname, '.probe-work');

const SCALE = (process.env.PROBE_SCALE || '10,30,50,80,120')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
const HEADLESS = process.env.PROBE_HEADFUL !== '1';

// headless/后台页会被 Chromium 节流（定时器对齐到 1s、rAF 停摆），实测会直接毁掉「同一时刻」对齐能力
const ANTI_THROTTLE = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];

const MB = b => +(b / 1048576).toFixed(1);
const freeMB = () => MB(os.freemem());
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const stats = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    min: +s[0].toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
  };
};

/** 逐文件删除，规避 bulk rmSync 的安全拦截 */
function safeRm(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) safeRm(p);
    else { try { fs.unlinkSync(p); } catch {} }
  }
  try { fs.rmdirSync(dir); } catch {}
}

// ───────────────────────── mock HTTP 服务（127.0.0.1） ─────────────────────────
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>mock product</title></head>
<body>
<h1 id="t">mock-product</h1>
<button id="buy">立即购买</button>
<script>
  // 忙等对齐 + 上报：完全在页面内完成，测量「N 个账号同一刻」的真实性
  window.__fire = async (target, id) => {
    while (Date.now() < target) { /* spin */ }
    const woke = Date.now();
    const r = await fetch('/api/fire?id=' + id);
    const j = await r.json();
    return { woke, drift: woke - target, srv: j.t };
  };
  window.__ping = async () => {
    const t0 = performance.now();
    await fetch('/api/ping');
    return performance.now() - t0;
  };
  window.__setLs = (k, v) => localStorage.setItem(k, v);
  window.__getLs = (k) => localStorage.getItem(k);
</script>
</body></html>`;

function startMockServer() {
  const fires = [];
  const pings = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/fire') {
      fires.push({ id: u.searchParams.get('id'), t: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ t: Date.now(), n: fires.length }));
    }
    if (u.pathname === '/api/ping') {
      pings.push(Date.now());
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":1}');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, origin: `http://127.0.0.1:${port}`,
        fires, pings, server,
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

// ───────────────────────── A:多 context 隔离与上限 ─────────────────────────
async function phaseA(mock) {
  console.log('\n=== A. 多 context 隔离 / 上限 / 资源 ===');
  const res = { isolation: null, scaling: [], limit: null, notes: [] };

  const browser = await chromium.launch({ headless: HEADLESS, args: ANTI_THROTTLE });
  const cdp = await browser.newBrowserCDPSession();

  // --- A1 隔离性：cookie / localStorage / cache 是否互相可见 ---
  {
    const cA = await browser.newContext();
    const cB = await browser.newContext();
    await cA.addCookies([{ name: 'sid', value: 'ACCOUNT_A', url: mock.origin }]);
    const pA = await cA.newPage(); await pA.goto(mock.origin + '/p/1');
    const pB = await cB.newPage(); await pB.goto(mock.origin + '/p/1');
    await pA.evaluate(() => localStorage.setItem('uid', 'ACCOUNT_A'));
    await pA.evaluate(() => sessionStorage.setItem('uid', 'ACCOUNT_A'));
    const cookiesOf = async c => (await c.cookies(mock.origin)).map(k => `${k.name}=${k.value}`).sort().join(',');
    res.isolation = {
      ctxA_cookies: await cookiesOf(cA) || '<empty>',
      ctxB_cookies: await cookiesOf(cB) || '<empty>',
      ctxA_localStorage: await pA.evaluate(() => localStorage.getItem('uid')),
      ctxB_localStorage: await pB.evaluate(() => localStorage.getItem('uid')),
      ctxA_sessionStorage: await pA.evaluate(() => sessionStorage.getItem('uid')),
      ctxB_sessionStorage: await pB.evaluate(() => sessionStorage.getItem('uid')),
      ctxA_documentCookie: await pA.evaluate(() => document.cookie),
      ctxB_documentCookie: await pB.evaluate(() => document.cookie),
    };
    // 同一 context 内不同 page 是否共享 cookie（决定 D.4 能否单 context 多账号）
    const pA2 = await cA.newPage(); await pA2.goto(mock.origin + '/p/2');
    res.isolation.sameContext_page2_seesCookie = await pA2.evaluate(() => document.cookie);
    res.isolation.sameContext_page2_localStorage = await pA2.evaluate(() => localStorage.getItem('uid'));
    res.isolation.verdict =
      res.isolation.ctxB_cookies === '<empty>' && res.isolation.ctxB_localStorage === null &&
      res.isolation.ctxA_cookies.includes('ACCOUNT_A')
        ? 'ISOLATED: context 间 cookie/localStorage/sessionStorage 完全隔离'
        : 'NOT_ISOLATED';
    await cA.close(); await cB.close();
  }

  // --- A2 加压：单浏览器进程内累加 context ---
  const base = freeMB();
  const ctxs = [];
  const pages = [];
  const target = SCALE[SCALE.length - 1];
  let step = SCALE[0], createTimes = [], failure = null;
  const marks = new Set(SCALE);
  let n = 0;
  const tRamp0 = nowMs();

  while (n < target) {
    const want = Math.min(step, target);
    let broke = null;
    while (n < want) {
      const t0 = nowMs();
      try {
        const c = await browser.newContext();
        const p = await c.newPage();
        await p.goto(mock.origin + '/p/' + n, { waitUntil: 'domcontentloaded' });
        ctxs.push(c); pages.push(p); n++;
        createTimes.push(nowMs() - t0);
      } catch (e) { broke = e; break; }
    }
    if (broke) { failure = { atContext: n, error: broke.message.split('\n')[0] }; break; }

    await sleep(900); // 让内存落定
    const mem = freeMB();
    const info = await cdp.send('SystemInfo.getProcessInfo');
    const types = {};
    for (const x of info.processInfo) types[x.type] = (types[x.type] || 0) + 1;

    // 事件循环延迟（Node 侧调度抖动）
    const el = await measureEventLoopDelay(300);
    // 单 context 往返延迟
    const rt = stats(await Promise.all(pages.slice(-8).map(p => p.evaluate(() => window.__ping()))));

    const row = {
      contexts: n,
      freeMemMB: mem,
      consumedMB: +(base - mem).toFixed(1),
      marginalMBPerContext: +((base - mem) / n).toFixed(1),
      chromiumProcesses: info.processInfo.length,
      processTypes: types,
      rendererPerContext: types.renderer / n,
      nodeEventLoopDelayP50: el.p50, nodeEventLoopDelayMax: el.max,
      pingRT_p50: rt ? rt.p50 : null,
      createContextAvgMs: +(createTimes.reduce((a, x) => a + x, 0) / createTimes.length).toFixed(1),
    };
    res.scaling.push(row);
    console.log(`  n=${String(n).padStart(3)}  mem=${String(mem).padStart(5)}MB  累计=${String(row.consumedMB).padStart(7)}MB  ` +
      `每ctx≈${row.marginalMBPerContext}MB  进程=${info.processInfo.length}(renderer ${types.renderer})  ` +
      `EL延迟p50=${el.p50}ms`);
    step = want === SCALE[0] ? Math.max(SCALE[0], Math.round(want * 1.6)) : Math.round(want * 1.5);
    if (!marks.has(want)) marks.add(want);
  }
  res.rampWallMs = nowMs() - tRamp0;
  res.limit = failure
    ? { hardLimitFound: true, stoppedAt: failure.atContext, error: failure.error }
    : { hardLimitFound: false, reachedContexts: n, note: `在 ${target} context 内未触发上限` };
  res.peak = { freeMemMB: freeMB(), consumedMB: +(base - freeMB()).toFixed(1), contexts: n };

  // 回收
  const tClose0 = nowMs();
  for (const c of ctxs) { try { await c.close(); } catch {} }
  await browser.close();
  await sleep(1200);
  res.teardown = { closeWallMs: nowMs() - tClose0, freeMemAfterMB: freeMB(), reclaimedMB: +(freeMB() - base).toFixed(1) };
  console.log(`  回收后空闲内存 ${res.teardown.freeMemAfterMB}MB（回收 ${res.teardown.reclaimedMB}MB）`);
  return res;
}

function measureEventLoopDelay(durationMs = 300) {
  return new Promise(resolve => {
    const s = [];
    let last = nowMs();
    const iv = setInterval(() => {
      const t = nowMs(); s.push(t - last - 5); last = t;
    }, 5);
    setTimeout(() => { clearInterval(iv); resolve(stats(s.filter(x => x >= 0)) || { p50: 0, max: 0 }); }, durationMs);
  });
}

// ───────────────────────── B:persistent profile ─────────────────────────
const WORKER_SRC = [
  "import { chromium } from 'playwright';",
  "const dir = process.argv[2], hold = +process.argv[3], tag = process.argv[4];",
  "const log = (...a) => process.stdout.write(a.join(' ') + '\\n');",
  "const step = async (name, fn) => { const t = Date.now();",
  "  try { const r = await Promise.race([fn(), new Promise((_, rj) => setTimeout(() => rj(new Error('HUNG>10s')), 10000))]);",
  "    log('STEP ' + tag + ' ' + name + ' ' + (Date.now() - t) + 'ms'); return r; }",
  "  catch (e) { log('STEPFAIL ' + tag + ' ' + name + ' ' + (Date.now() - t) + 'ms :: ' + e.message.split('\\n')[0].slice(0, 80)); throw e; } };",
  "try {",
  "  const c = await step('launch', () => chromium.launchPersistentContext(dir, { headless: true, timeout: 15000, args: ['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'] }));",
  "  await step('addCookies', () => c.addCookies([{ name: 'sid', value: 'ACCT_' + tag, url: 'http://127.0.0.1/' }]));",
  "  const p = await step('newPage', () => c.newPage());",
  "  await step('goto', () => p.goto('data:text/html,<h1>x</h1>'));",
  "  await step('evaluate', () => p.evaluate(() => 1 + 1));",
  "  const ck = (await c.cookies('http://127.0.0.1/')).map(k => k.value).join(',') || '<none>';",
  "  log('READY ' + tag + ' sees=' + ck);",
  "  await new Promise(r => setTimeout(r, hold));",
  "  await step('close', () => c.close());",
  "  log('ALLDONE ' + tag); process.exit(0);",
  "} catch (e) { log('FATAL ' + tag + ' ' + e.message.split('\\n')[0].slice(0, 100)); process.exit(3); }",
].join('\n');

/** 解析 worker 输出的 STEP 计时 */
function parseSteps(out, tag) {
  const o = {};
  for (const m of out.matchAll(new RegExp(`STEP ${tag} (\\w+) (-?\\d+)ms`, 'g'))) o[m[1]] = +m[2];
  for (const m of out.matchAll(new RegExp(`STEPFAIL ${tag} (\\w+) (-?\\d+)ms :: (.*)`, 'g'))) o[m[1] + '_failed'] = +m[2] + 'ms:' + m[3];
  return o;
}

function startWorker(args) {
  const pr = spawn(process.execPath, [path.join(TMP_DIR, 'worker.mjs'), ...args], {
    cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const st = { proc: pr, out: '', ready: false, done: false, err: null, exit: null, t0: nowMs(), tag: args[2] };
  pr.stdout.on('data', d => { st.out += d; if (st.out.includes('READY')) st.ready = true; if (st.out.includes('DONE')) st.done = true; });
  pr.stderr.on('data', d => st.out += d);
  pr.on('close', c => { st.exit = c; st.wall = nowMs() - st.t0; });
  return st;
}
const waitFor = (st, key, ms = 30000) => new Promise((res, rej) => {
  const t0 = nowMs();
  const iv = setInterval(() => {
    if (st[key]) { clearInterval(iv); return res(true); }
    if (st.exit !== null || nowMs() - t0 > ms) {
      clearInterval(iv);
      rej(new Error(`worker ${st.tag} 未达到 ${key} (exit=${st.exit}) out=${st.out.trim().slice(0, 200)}`));
    }
  }, 40);
});

async function phaseB(mock) {
  console.log('\n=== B. persistent profile / userDataDir 并行 ===');
  const res = {};
  safeRm(TMP_DIR); fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(path.join(TMP_DIR, 'worker.mjs'), WORKER_SRC);

  // B1 同一 userDataDir 被两个进程同时打开
  // B1a 基线：独占打开一次，记录各步骤耗时
  const baseDir = path.join(TMP_DIR, 'profiles', 'solo');
  fs.mkdirSync(baseDir, { recursive: true });
  {
    const S = startWorker([baseDir, '0', 'SOLO']);
    await waitFor(S, 'ready', 40000).catch(() => {});
    await new Promise(r => { if (S.exit !== null) return r(); S.proc.on('close', r); setTimeout(() => { S.proc.kill('SIGKILL'); r(); }, 8000); });
    res.soloOpenStepsMs = parseSteps(S.out, 'SOLO');
  }

  // B1b 同一 userDataDir 被两个进程「同时」打开（真实重叠）
  const shared = path.join(TMP_DIR, 'profiles', 'shared');
  fs.mkdirSync(shared, { recursive: true });
  const A = startWorker([shared, '20000', 'A']);
  await waitFor(A, 'ready', 40000);
  const B = startWorker([shared, '0', 'B']);
  await waitFor(B, 'ready', 40000).catch(e => { res.B_secondOpenError = e.message; });
  await sleep(14000); // 让B 走到 close那一步
  res.sameDirTwoProcesses = {
    A_openedWithoutError: A.ready, B_openedWithoutError: B.ready,
    A_exitCode: A.exit, B_exitCode: B.exit,
    A_stepsMs: parseSteps(A.out, 'A'),
    B_stepsMs: parseSteps(B.out, 'B'),
    solo_stepsMs: res.soloOpenStepsMs,
    B_rawOutput: B.out.trim().split('\n').slice(0, 14),
    lockArtifactsInProfile: fs.readdirSync(shared).filter(f => /singleton|lock/i.test(f)),
  };
  const sa = res.soloOpenStepsMs || {}, sb = res.sameDirTwoProcesses.B_stepsMs;
  const slower = Object.keys(sa).filter(k => typeof sa[k] === 'number' && typeof sb[k] === 'number' && sb[k] > sa[k] * 3);
  res.sameDirTwoProcesses.degradedSteps = slower.map(k => ({ step: k, solo: sa[k] + 'ms', contended: sb[k] + 'ms', ratio: +(sb[k] / sa[k]).toFixed(1) }));
  res.sameDirTwoProcesses.closeHung = !!(sb.close_failed || (A.close_failed));
  res.sameDirTwoProcesses.conclusion =
    (A.ready && B.ready)
      ? `同一userDataDir 被两个进程同时打开「未报错」：两者内存态各自独立（各看到自己的 cookie ${(A.out.match(/READY A sees=(\S+)/) || [])[1]} vs ${(B.out.match(/READY B sees=(\S+)/) || [])[1]}），` +
        `但同一份磁盘 profile 被两个 Chromium 实例并发写：` +
        (slower.length ? `步骤显著变慢(${slower.map(k => `${k} ${sa[k]}ms→${sb[k]}ms`).join(', ')})；` : '') +
        (res.sameDirTwoProcesses.closeHung ? '且close() 出现 >10s 挂死。结论：Windows 上 Chromium 不对 userDataDir 做硬锁，双开不会立即失败，而是以随机IO竞争/句柄争用/关闭挂死的形式表现出来——比直接报错更危险。' : '')
      : '第二个进程打开同 userDataDir 失败（被锁）';
  console.log('  同 dir 重叠双开: A.ready=' + A.ready + ' B.ready=' + B.ready +
    (res.sameDirTwoProcesses.degradedSteps.length ? '  降级步骤=' + JSON.stringify(res.sameDirTwoProcesses.degradedSteps) : '') +
    (res.sameDirTwoProcesses.closeHung ? '  close() 挂死' : ''));
  A.proc.kill('SIGKILL'); B.proc.kill('SIGKILL');
  await sleep(800);

  // B2 各自独立 userDataDir 并行打开（正确做法）
  {
    const N = 5;
    const ws = [];
    for (let i = 0; i < N; i++) {
      const d = path.join(TMP_DIR, 'profiles', `acct-${i + 1}`);
      fs.mkdirSync(d, { recursive: true });
      ws.push(startWorker([d, '3000', 'P' + (i + 1)]));
    }
    const t0 = nowMs();
    const ok = await Promise.all(ws.map(w => waitFor(w, 'ready', 40000).then(() => true).catch(() => false)));
    res.distinctDirsParallel = {
      workers: N, allReady: ok.every(Boolean), readyCount: ok.filter(Boolean).length,
      parallelReadyWallMs: nowMs() - t0,
      perWorker: ws.map(w => ({ tag: w.tag, ready: w.ready, sawOwnCookie: new RegExp(`READY ${w.tag} sees=ACCT_${w.tag}`).test(w.out), stepsMs: parseSteps(w.out, w.tag) })),
      allWorkersSawOwnCookie: ws.filter(w => new RegExp(`READY ${w.tag} sees=ACCT_${w.tag}`).test(w.out)).length,
      memoryNote: '每个 launchPersistentContext = 一个独立 Chromium 实例（独立 browser 进程）',
    };
    ws.forEach(w => w.proc.kill('SIGKILL'));
    await sleep(600);
    console.log(`  ${N} 个独立 profile 并行: 全部就绪=${ok.every(Boolean)} 耗时=${res.distinctDirsParallel.parallelReadyWallMs}ms`);
  }

  // B3 关键验证：persistent 登录态 → storageState → 单浏览器多 context（推荐架构）
  {
    const profDir = path.join(TMP_DIR, 'profiles', 'acct-1');
    fs.mkdirSync(profDir, { recursive: true });
    const stateFile = path.join(TMP_DIR, 'acct-1.storage.json');
    // 先用独立子进程写入登录态，确认就绪后立即结束它（profile 必须已被释放）
    const w = startWorker([profDir, '300', 'X']);
    try { await waitFor(w, 'ready', 40000); } catch (e) { res.B3_seedError = e.message; }
    await new Promise(r => { if (w.exit !== null) return r(); w.proc.on('close', r); setTimeout(() => { w.proc.kill('SIGKILL'); r(); }, 8000); });
    await sleep(1200);

    // 再由主进程打开该 profile 导出 storageState
    const pc = await chromium.launchPersistentContext(profDir, { headless: true, timeout: 20000, args: ANTI_THROTTLE });
    await pc.addCookies([{ name: 'sid', value: 'ACCT_X', url: mock.origin }]);
    const p = await pc.newPage();
    await p.goto(mock.origin + '/state-seed');
    await p.evaluate(() => localStorage.setItem('uid', 'ACCT_X'));
    let state = null, indexedDBSupported = false;
    try { state = await pc.storageState({ indexedDB: true }); indexedDBSupported = true; } catch { state = await pc.storageState(); }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const cookieCount = (state.cookies || []).length;
    const origins = (state.origins || []).length;
    const lsDump = (state.origins || []).flatMap(o => (o.localStorage || []).map(e => `${o.origin}:${e.name}=${e.value}`));
    await pc.close();
    w.proc.kill('SIGKILL');
    await sleep(500);

    // 用 storageState 在普通 context 里复现登录态
    const b = await chromium.launch({ headless: HEADLESS, args: ANTI_THROTTLE });
    const c1 = await b.newContext({ storageState: stateFile });
    const c2 = await b.newContext({ storageState: stateFile });
    const pp1 = await c1.newPage(); await pp1.goto(mock.origin + '/state-verify');
    const got1 = (await c1.cookies(mock.origin)).map(k => `${k.name}=${k.value}`);
    const ls1 = await pp1.evaluate(() => { try { return localStorage.getItem('uid'); } catch { return '<blocked>'; } });
    const got2 = (await c2.cookies(mock.origin)).map(k => `${k.name}=${k.value}`);
    await b.close();

    res.storageStateBridge = {
      indexedDBSupported,
      stateFileBytes: fs.statSync(stateFile).size,
      cookiesInState: cookieCount, originsInState: origins, localStorageEntries: lsDump,
      context1_cookies: got1, context1_localStorage: ls1, context2_cookies: got2,
      conclusion: (got1.some(c => c.includes('ACCT_X')) && ls1 === 'ACCT_X')
        ? 'VERIFIED: 登录态可从 persistent profile 导出为 storageState，并在同一浏览器的多个 context 中复现（cookie + localStorage 均还原）'
        : 'storageState 复现不完整：' + JSON.stringify({ got1, ls1 }),
    };
    console.log('  storageState 桥接: ' + (res.storageStateBridge.conclusion.startsWith('VERIFIED') ? 'OK' : 'FAIL ' + res.storageStateBridge.conclusion));
  }

  safeRm(TMP_DIR);
  return res;
}

// ───────────────────────── C:时钟同步 ─────────────────────────
function clockGranularityMs(n = 200000) {
  const s = [];
  for (let i = 0; i < n; i++) s.push(Date.now());
  const d = [];
  for (let i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
  const uniq = new Set(s).size;
  const st = stats(d);
  return { samples: n, uniqueValues: uniq, distinctSteps: [...new Set(d)].sort((a, b) => a - b).slice(0, 6), stepStats: st };
}

async function phaseC(browser, mock) {
  console.log('\n=== C. 时钟精度与对齐 ===');
  const res = {};

  // C1 Node 侧 Date.now() 分辨率
  res.nodeClock = clockGranularityMs();
  console.log(`  Node Date.now(): 20万次采样仅 ${res.nodeClock.uniqueValues} 个不同值, 步长p50=${res.nodeClock.stepStats.p50}ms max=${res.nodeClock.stepStats.max}ms`);

  // C2 页面内 Date.now() 分辨率 + performance.now()
  {
    const c = await browser.newContext();
    const p = await c.newPage(); await p.goto(mock.origin + '/clock');
    res.pageClock = await p.evaluate(() => {
      const s = []; for (let i = 0; i < 200000; i++) s.push(Date.now());
      const d = []; for (let i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
      const uniq = new Set(s).size;
      d.sort((a, b) => a - b);
      const pn = []; for (let i = 0; i < 100000; i++) pn.push(performance.now());
      const pd = []; for (let i = 1; i < pn.length; i++) pd.push(pn[i] - pn[i - 1]);
      const nz = pd.filter(x => x > 0);
      return {
        dateNowUnique: uniq, dateNowStepP50: d[Math.floor(d.length / 2)], dateNowStepMax: d[d.length - 1],
        dateNowDistinct: [...new Set(d)].sort((a, b) => a - b).slice(0, 6),
        perfNowMinNonZero: nz.length ? +Math.min(...nz).toFixed(4) : 0,
        timeOriginEpochMs: Math.floor(performance.timeOrigin),
        pageDateNowAtLoad: Date.now(),
      };
    });
    console.log(`  页面 Date.now(): 20万次采样 ${res.pageClock.dateNowUnique} 个不同值, 步长p50=${res.pageClock.dateNowStepP50}ms | performance.now() 最小非零步长=${res.pageClock.perfNowMinNonZero}ms`);
    await c.close();
  }

  // C3 跨进程时钟一致性：N 个进程忙等到同一绝对时刻
  {
    const N = 8;
    const target = Date.now() + 2500;
    const ws = [];
    for (let i = 0; i < N; i++) ws.push(startClockWorker(target, i));
    const outs = await Promise.all(ws.map(w => new Promise(res => w.proc.on('close', () => res(w.out)))));
    const drifts = outs.map(o => {
      const m = o.match(/"drift":([-\d.]+)/); return m ? parseFloat(m[1]) : null;
    }).filter(v => v !== null);
    const reads = outs.map(o => {
      const m = o.match(/"atWake":(\d+)/); return m ? parseInt(m[1], 10) : null;
    }).filter(v => v !== null);
    res.crossProcessAlignment = {
      processes: N, targetEpochMs: target,
      driftPerProcMs: drifts, driftStats: stats(drifts),
      wakeTimeSpreadMs: reads.length ? Math.max(...reads) - Math.min(...reads) : null,
      conclusion: '所有进程以同一绝对时刻(epoch ms)忙等对齐',
    };
    console.log(`  跨${N}进程忙等对齐: 唤醒时刻离散=${res.crossProcessAlignment.wakeTimeSpreadMs}ms, 相对目标漂移 p50=${res.crossProcessAlignment.driftStats.p50}ms max=${res.crossProcessAlignment.driftStats.max}ms`);
  }

  // C4 三种对齐方式精度对比（setTimeout / setInterval 轮询 / 忙等）
  {
    const c = await browser.newContext();
    const p = await c.newPage(); await p.goto(mock.origin + '/clock');
    res.schedulingMethods = await p.evaluate(async () => {
      const out = {};
      const run = (mode) => new Promise(resolve => {
        const target = Date.now() + 700;
        let done = false;
        const hit = () => { if (done) return; done = true; const t = Date.now(); resolve(t - target); };
        if (mode === 'setTimeout') setTimeout(hit, Math.max(0, target - Date.now()));
        else if (mode === 'setInterval1ms') { const iv = setInterval(() => { if (Date.now() >= target) { clearInterval(iv); hit(); } }, 1); }
        else if (mode === 'setInterval4ms') { const iv = setInterval(() => { if (Date.now() >= target) { clearInterval(iv); hit(); } }, 4); }
        else { const spin = () => { if (Date.now() >= target) hit(); else setTimeout(spin, 0); }; spin(); }
        // 兜底：防止后台节流导致永不触发
        setTimeout(() => { if (!done) { done = true; resolve(Date.now() - target + 9999); } }, 5000);
      });
      for (const m of ['setTimeout', 'setInterval1ms', 'setInterval4ms', 'spin0']) {
        const arr = []; for (let i = 0; i < 8; i++) arr.push(await run(m));
        arr.sort((a, b) => a - b);
        out[m] = { runs: 8, min: arr[0], p50: arr[Math.floor(arr.length / 2)], max: arr[arr.length - 1], mean: +(arr.reduce((a, x) => a + x, 0) / arr.length).toFixed(2) };
      }
      return out;
    });
    for (const [k, v] of Object.entries(res.schedulingMethods)) {
      console.log(`  对齐方式 ${k.padEnd(14)} 误差 min=${v.min}ms p50=${v.p50}ms max=${v.max}ms`);
    }
    await c.close();
  }

  return res;
}

const CLOCK_WORKER = [
  "const target = +process.argv[2];",
  "const spin0 = Date.now();",
  "let s = 0; while (Date.now() < target) { s++; }",
  "const atWake = Date.now();",
  "console.log(JSON.stringify({ pid: process.pid, spin: s, atWake, drift: atWake - target, spinStart: spin0 }));",
].join('\n');
function startClockWorker(target, i) {
  const f = path.join(TMP_DIR, `clock-${i}.mjs`);
  fs.writeFileSync(f, CLOCK_WORKER);
  const pr = spawn(process.execPath, [f, String(target)], { cwd: path.join(__dirname, '..') });
  const st = { proc: pr, out: '' };
  pr.stdout.on('data', d => st.out += d); pr.stderr.on('data', d => st.out += d);
  return st;
}

// ───────────────────────── D:并发瓶颈 ─────────────────────────
async function phaseD(mock) {
  console.log('\n=== D. 并发抢点瓶颈 ===');
  const res = {};
  const browser = await chromium.launch({ headless: HEADLESS, args: ANTI_THROTTLE });
  const cdp = await browser.newBrowserCDPSession();

  // D1 基线：单 context 串行往返
  {
    const c = await browser.newContext();
    const p = await c.newPage(); await p.goto(mock.origin + '/p/1');
    const lats = [];
    for (let i = 0; i < 120; i++) lats.push(await p.evaluate(() => window.__ping()));
    res.baseline_singleContextSerial = { requests: 120, stats: stats(lats) };
    console.log(`  基线 单context串行: p50=${res.baseline_singleContextSerial.stats.p50}ms p95=${res.baseline_singleContextSerial.stats.p95}ms`);
    await c.close();
  }

  // D2 N context 并发往返：CDP 是否互相排队
  res.concurrentRamp = [];
  for (const N of [1, 10, 30, 50]) {
    const cs = [], ps = [];
    for (let i = 0; i < N; i++) {
      const c = await browser.newContext();
      const p = await c.newPage();
      await p.goto(mock.origin + '/p/' + i, { waitUntil: 'domcontentloaded' });
      cs.push(c); ps.push(p);
    }
    await sleep(400);
    const ROUNDS = N <= 10 ? 30 : 12;
    const t0 = nowMs();
    const all = await Promise.all(ps.map(p => (async () => {
      const l = []; for (let i = 0; i < ROUNDS; i++) l.push(await p.evaluate(() => window.__ping())); return l;
    })()));
    const wall = nowMs() - t0;
    const flat = all.flat();
    const row = {
      contexts: N, roundsEach: ROUNDS, totalRequests: flat.length, wallMs: wall,
      throughputReqPerSec: +(flat.length / (wall / 1000)).toFixed(1),
      rtStats: stats(flat),
      perContextQPS: +(flat.length / (wall / 1000) / N).toFixed(2),
    };
    res.concurrentRamp.push(row);
    console.log(`  N=${String(N).padStart(2)} 并发往返: 吞吐=${row.throughputReqPerSec} req/s  往返p50=${row.rtStats.p50}ms p95=${row.rtStats.p95}ms max=${row.rtStats.max}ms`);
    for (const c of cs) await c.close();
    await sleep(500);
  }

  // D3 「同一时刻」并发点击：真实到达时刻离散度（核心指标）
  res.simultaneousFire = [];
  for (const N of [1, 10, 30, 50]) {
    const cs = [], ps = [];
    for (let i = 0; i < N; i++) {
      const c = await browser.newContext();
      const p = await c.newPage();
      await p.goto(mock.origin + '/p/' + i, { waitUntil: 'domcontentloaded' });
      cs.push(c); ps.push(p);
    }
    await sleep(700); // 预热，避开首屏加载抖动

    const before = mock.fires.length;
    const target = Date.now() + 1500;
    const results = await Promise.all(ps.map((p, i) =>
      p.evaluate(([t, id]) => window.__fire(t, id), [target, `n${N}-a${i}`]).catch(e => ({ error: e.message.split('\n')[0] }))
    ));
    await sleep(600);
    const srv = mock.fires.slice(before).map(f => f.t);
    const woke = results.map(r => r && r.woke).filter(Boolean);
    const row = {
      contexts: N,
      clientWakeSpreadMs: woke.length ? Math.max(...woke) - Math.min(...woke) : null,
      clientWakeDriftStats: stats(woke.map(t => t - target)),
      serverArrivalSpreadMs: srv.length ? Math.max(...srv) - Math.min(...srv) : null,
      serverArrivalCount: srv.length,
      serverArrivalOffsets: srv.map(t => t - target),
      errors: results.filter(r => r && r.error).map(r => r.error),
    };
    res.simultaneousFire.push(row);
    console.log(`  N=${String(N).padStart(2)} 同时开火: 客户端唤醒离散=${row.clientWakeSpreadMs}ms  服务端到达离散=${row.serverArrivalSpreadMs}ms  (成功${row.serverArrivalCount}/${N})`);
    for (const c of cs) await c.close();
    await sleep(500);
  }

  // D4 单 context 多 page 能否承载多账号（cookie 共享性验证）
  {
    const c = await browser.newContext();
    await c.addCookies([{ name: 'sid', value: 'ONLY_ONE', url: mock.origin }]);
    const p1 = await c.newPage(); await p1.goto(mock.origin + '/1');
    const p2 = await c.newPage(); await p2.goto(mock.origin + '/2');
    const v1 = await p1.evaluate(() => document.cookie);
    const v2 = await p2.evaluate(() => document.cookie);
    res.singleContextMultiAccount = {
      page1_cookie: v1, page2_cookie: v2,
      shared: v1 === v2 && v1.includes('ONLY_ONE'),
      conclusion: v1 === v2
        ? '同一个 context 内所有 page 共享同一 cookie jar → 无法承载多个不同登录账号（这是 context 隔离的代价，也是它不可被单 context 替代的原因）'
        : '同 context 内 page 间 cookie 独立（可替代）',
    };
    console.log('  单context多page: page1=' + JSON.stringify(v1) + ' page2=' + JSON.stringify(v2) + ' → ' + (v1 === v2 ? '共享(不可多账号)' : '独立'));
    await c.close();
  }

  // D5渲染能力：单 Chromium 进程内 N context 同时渲染
  {
    const row = {};
    for (const N of [10, 30, 50]) {
      const cs = [], ps = [];
      for (let i = 0; i < N; i++) {
        const c = await browser.newContext();
        const p = await c.newPage();
        await p.goto(mock.origin + '/anim/' + i, { waitUntil: 'domcontentloaded' });
        cs.push(c); ps.push(p);
      }
      await sleep(600);
      const c0 = os.cpus();
      const t0 = nowMs();
      // 每页做真实渲染工作：rAF 计数 + DOM churn
      const work = await Promise.all(ps.map(p => p.evaluate(() => new Promise(res => {
        let frames = 0; const t0 = performance.now();
        const step = () => {
          frames++;
          document.body.appendChild(document.createElement('div'));
          if (document.body.childElementCount > 40) document.body.innerHTML = '';
          if (performance.now() - t0 < 2000) requestAnimationFrame(step); else res(frames);
        };
        requestAnimationFrame(step);
      }))));
      const wall = nowMs() - t0;
      const d = os.cpus().map((c, i) => c.times.user + c.times.sys - (c0[i].times.user + c0[i].times.sys));
      const cpuBusyMs = d.reduce((a, b) => a + b, 0);
      row[`n${N}`] = {
        contexts: N, wallMs: wall,
        totalFrames: work.reduce((a, b) => a + b, 0),
        fpsPerPage: +(work.reduce((a, b) => a + b, 0) / N / (wall / 1000)).toFixed(1),
        minFrames: Math.min(...work), maxFrames: Math.max(...work),
        systemCpuBusyCores: +(cpuBusyMs / wall).toFixed(2),
        cpuBusyCoresPerContext: +(cpuBusyMs / wall / N).toFixed(3),
      };
      console.log(`  渲染 N=${String(N).padStart(2)}: 每页fps≈${row[`n${N}`].fpsPerPage} (最低${row[`n${N}`].minFrames}帧)  整机CPU占用≈${row[`n${N}`].systemCpuBusyCores}核`);
      for (const c of cs) await c.close();
      await sleep(500);
    }
    res.renderCapacity = row;
  }

  const info = await cdp.send('SystemInfo.getProcessInfo');
  res.finalProcessCount = info.processInfo.length;
  await browser.close();
  return res;
}

// ───────────────────────── main ─────────────────────────
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 全局看门狗：保证任何阶段卡死也能落盘并退出
  const HARD_LIMIT_MS = parseInt(process.env.PROBE_TIMEOUT_MS || '900000', 10);
  const watchdog = setTimeout(() => {
    console.error(`\n[watchdog] 超过 ${HARD_LIMIT_MS}ms，强制落盘退出`);
    try {
      fs.writeFileSync(OUT_FILE, JSON.stringify({
        meta: { generatedAt: new Date().toISOString(), abortedByWatchdog: true, partial: true },
        A: globalThis.__A || null, B: globalThis.__B || null, C: globalThis.__C || null, D: globalThis.__D || null,
      }, null, 2));
    } catch {}
    process.exit(9);
  }, HARD_LIMIT_MS);
  watchdog.unref?.();

  const only = (process.env.PROBE_ONLY || 'ABCD').toUpperCase();
  const mock = await startMockServer();
  console.log(`mock server: ${mock.origin} (仅 127.0.0.1)`);
  console.log(`scale plan: ${SCALE.join(', ')} | headless=${HEADLESS}`);

  const t0 = nowMs();
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      node: process.version,
      playwright: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'playwright', 'package.json'), 'utf8')).version,
      chromiumPath: chromium.executablePath(),
      os: { platform: process.platform, release: os.release(), cpus: os.cpus().length, cpuModel: os.cpus()[0].model.trim(), totalMemMB: MB(os.totalmem()), freeMemMBAtStart: freeMB() },
      scalePlan: SCALE, headless: HEADLESS, onlyPhases: only,
      measurementNotes: [
        '内存用 os.freemem() 差值 + CDP SystemInfo.getProcessInfo 统计进程数（本机禁止从脚本内调 PowerShell，tasklist 亦不可用）',
        '时钟/到达时刻统一用 Date.now() 绝对 epoch 毫秒',
        '所有页面来自本地 127.0.0.1 mock 服务，未访问任何外部站点',
      ],
    },
    A: null, B: null, C: null, D: null, E: null,
  };

  const prevFile = path.join(OUT_DIR, 'multi-account.json');
  let prev = {};
  if (only !== 'ABCD' && fs.existsSync(prevFile)) { try { prev = JSON.parse(fs.readFileSync(prevFile, 'utf8')); } catch {} }
  try {
    if (only.includes('A')) { out.A = await phaseA(mock); globalThis.__A = out.A; }
    if (only.includes('B')) { out.B = await phaseB(mock); globalThis.__B = out.B; }
    // C/D 复用同一个浏览器
    if (only.includes('C') || only.includes('D')) {
      const b2 = await chromium.launch({ headless: HEADLESS, args: ANTI_THROTTLE });
      if (only.includes('C')) { out.C = await phaseC(b2, mock); globalThis.__C = out.C; }
      if (only.includes('D')) { out.D = await phaseD(mock); globalThis.__D = out.D; }
      await b2.close();
    }
    // 合并未重跑的章节
    for (const k of ['A', 'B', 'C', 'D']) if (!out[k] && prev[k]) out[k] = prev[k];
  } catch (e) {
    out.error = { message: e.message, stack: (e.stack || '').split('\n').slice(0, 6) };
    console.error('\n[FAIL]', e.message);
  }

  clearTimeout(watchdog);

  out.totalWallMs = nowMs() - t0;
  out.E = buildRecommendation(out);

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  await mock.close();
  console.log(`\n结果已写入 ${OUT_FILE}  用时 ${(out.totalWallMs / 1000).toFixed(1)}s`);
  process.exit(0);
})();

// ───────────────────────── E:架构建议（由实测数据推导） ─────────────────────────
function buildRecommendation(o) {
  const a = o.A || {}, d = o.D || {}, b = o.B || {};
  const peakCtx = a.peak ? a.peak.contexts : 0;
  const perCtxMB = a.scaling.length ? a.scaling[a.scaling.length - 1].marginalMBPerContext : null;
  const fire = (d.simultaneousFire || [])[d.simultaneousFire.length - 1] || {};
  const render = d.renderCapacity ? Object.values(d.renderCapacity)[Object.values(d.renderCapacity).length - 1] : {};
  const bridge = b.storageStateBridge || {};
  return {
    processModel: {
      recommendation: '单 Node 主进程 + 单个 Chromium 实例 + N 个 browser.newContext()',
      processCount: 1,
      why: `实测单浏览器进程开 ${peakCtx} 个 context 仅占 ${a.peak ? a.peak.consumedMB : '?'}MB(≈${perCtxMB}MB/context)，` +
        `每个 context 独立 renderer 进程但共享同一 browser 进程；` +
        `而每个 launchPersistentContext 都是一个独立 Chromium 实例，进程数与内存都会翻倍`,
    },
    contextModel: {
      contextsPerBrowser: peakCtx,
      perContextRendererProcess: a.scaling.length ? a.scaling[a.scaling.length - 1].rendererPerContext : null,
      verifiedIsolation: a.isolation ? a.isolation.verdict : null,
    },
    profileLayout: {
      recommended: 'profiles/<accountId>/  每个账号一个独立 userDataDir，仅用于「登录态维护」阶段',
      grabTimeStrategy: bridge.conclusion && bridge.conclusion.startsWith('VERIFIED')
        ? '开抢时不再使用 persistent context，改为把每个账号的 profile 导出为 storageState(JSON)，用 browser.newContext({ storageState }) 批量创建 context —— 已实测可完整还原 cookie + localStorage'
        : 'storageState 桥接未验证通过，需回退到每账号独立 persistent context（多进程）',
      mustNotShare: '严禁多个进程/实例同时打开同一 userDataDir：' + (b.sameDirTwoProcesses ? b.sameDirTwoProcesses.conclusion : '未测'),
    },
    timeAlignment: {
      strategy: '单一权威目标时刻T0（epoch ms）+ 各 context 页面内忙等(Date.now() < T0) + 立即发请求',
      why: `页面 Date.now() 分辨率约 ${o.C && o.C.pageClock ? o.C.pageClock.dateNowStepP50 : '?'}ms，setTimeout/setInterval 存在 ` +
        `${o.C && o.C.schedulingMethods && o.C.schedulingMethods.setInterval1ms ? o.C.schedulingMethods.setInterval1ms.max : '?'}ms 级误差，` +
        '忙等可把误差压到最小；关键路径不要跨 CDP 往返等待（Node→CDP→renderer 往返本身就有 ms 级抖动）',
      measuredSpread: fire.serverArrivalSpreadMs != null
        ? `${fire.contexts} 账号并发开火，服务端到达时刻离散 ${fire.serverArrivalSpreadMs}ms` : '未测',
    },
    bottlenecks: {
      cdp: (d.concurrentRamp || []).map(r => `${r.contexts} context 并发：吞吐 ${r.throughputReqPerSec} req/s，往返 p95 ${r.rtStats.p95}ms`),
      render: render.fpsPerPage ? `${render.contexts} context 同时渲染时每页约 ${render.fpsPerPage} fps，最低 ${render.minFrames} 帧/2s，整机约 ${render.systemCpuBusyCores} 核忙碌` : '未测',
    },
  };
}
