/**
 * 轮询发现延迟实测（本地 mock 页面，不访问任何外部站点）
 * =====================================================================
 * 目的：验证改成自适应间隔后，「按钮变为可点 → 脚本发现并点击」实际要多久。
 *
 * 做法：起一个本地页面，按钮在 T 时刻从 disabled 变成可点，
 *       跑脚本的真实检测逻辑（从 huawei.user.js 抽出来的），
 *       对比 3000ms 与 150ms 两种间隔的实际发现延迟。
 *
 * 用法：node grab-probe/probe-hot-poll.mjs
 * =====================================================================
 */

import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const src = readFileSync(join(ROOT, 'grab/huawei.user.js'), 'utf8');

/** 抽取定义（function 声明 或 const 箭头函数） */
function grabDef(name) {
  let i = src.indexOf(`function ${name}(`);
  if (i >= 0) {
    let depth = 0;
    let started = false;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') { depth++; started = true; }
      else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
    }
    throw new Error(`${name} 不配平`);
  }
  i = src.indexOf(`const ${name} =`);
  if (i >= 0) {
    const end = src.indexOf(';', i);
    if (end > 0) return src.slice(i, end + 1);
  }
  throw new Error(`找不到 ${name}`);
}

const bundle = ['clean', 'textOf', 'isActionable', 'visibleText', 'findBuyButton', 'readStockState', 'jitter']
  .map(grabDef)
  .join('\n\n');

/* ── 本地 mock 服务 ── */
const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>mock 商品页</title></head>
<body>
  <div id="prd-detail">
    <h1>Mock 商品</h1>
    <div id="price">¥10999</div>
    <div id="status">即将开始</div>
    <div id="btnwrap"></div>
  </div>
  <script>
    // 按钮在页面加载后 2 秒才出现并变为可点（模拟开售瞬间）
    window.__btnReadyAt = null;
    setTimeout(() => {
      const d = document.createElement('div');
      d.textContent = '立即购买';
      d.id = 'buy-btn';
      d.style.cssText = 'width:120px;height:40px;display:block';
      document.getElementById('btnwrap').appendChild(d);
      document.getElementById('status').textContent = '现货';
      window.__btnReadyAt = Date.now();
    }, 2000);
  </script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const URL = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch({ headless: true });

/** 在给定间隔下跑一次「等按钮可点 → 发现」的完整过程 */
async function measure(pollMs, label) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  const r = await page.evaluate(
    ([pollMs, bundleSrc]) => {
      // eslint-disable-next-line no-new-func
      const setup = new Function(
        bundleSrc +
          `
        return { readStockState, findBuyButton, textOf, visibleText };
      `,
      );
      const fns = setup();

      return new Promise((resolve) => {
        const pollTimes = [];
        const startedAt = performance.now();
        let firstHitAt = null;
        let clicks = 0;
        let rounds = 0;

        const tick = () => {
          const t0 = performance.now();
          const st = fns.readStockState();
          rounds++;
          pollTimes.push(performance.now() - t0);

          if (st.state === 'IN_STOCK') {
            if (firstHitAt === null) {
              firstHitAt = performance.now();
              const btn = fns.findBuyButton().actionable;
              if (btn) {
                btn.click(); // mock 页面上点一下无害，只是记录
                clicks++;
              }
            }
            resolve({
              firstHitAt,
              startedAt,
              rounds,
              clicks,
              avgPollCostMs: pollTimes.reduce((a, b) => a + b, 0) / pollTimes.length,
              btnReadyAt: window.__btnReadyAt,
            });
            return;
          }
          // 跑到 4 秒还没命中就判失败
          if (performance.now() - startedAt > 4000) {
            resolve({ timeout: true, rounds, firstHitAt });
            return;
          }
          setTimeout(tick, pollMs);
        };
        tick();
      });
    },
    [pollMs, bundle],
  );

  await ctx.close();

  if (r.timeout) {
    return { label, pollMs, 结果: '超时未发现' };
  }

  // 发现延迟 = 第一次命中时刻 - 按钮真正可点的时刻（都在页面内计时，同源可比）
  const latency = r.btnReadyAt ? Math.round(r.firstHitAt - r.btnReadyAt + r.startedAt - r.startedAt) : null;
  // 注意：btnReadyAt 是 page 的 Date.now()，firstHitAt 是 performance.now()，两者基准不同
  // 改用可靠算法：按钮出现时刻也换算成 performance.now() 基准
  return {
    label,
    pollMs,
    '轮询轮次': r.rounds,
    '单轮检测耗时ms': +r.avgPollCostMs.toFixed(2),
    '实际点击次数': r.clicks,
    _raw: { firstHitAt: Math.round(r.firstHitAt), btnReadyAt: r.btnReadyAt, startedAt: Math.round(r.startedAt) },
  };
}

/* 更准的测法：在页面内统一用 performance.now() 记录按钮出现时刻 */
async function measurePrecise(pollMs, label) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();

  // 先注入记录器（页面脚本会用 performance.now 记录按钮出现时刻）
  await page.addInitScript(() => {
    window.__markReady = null;
    const origSetTimeout = window.setTimeout;
    window.__origSetTimeout = origSetTimeout;
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);

  // 让页面自己用 performance.now 记下按钮出现的精确时刻
  await page.evaluate(() => {
    const target = document.getElementById('btnwrap');
    const obs = new MutationObserver(() => {
      if (document.getElementById('buy-btn') && window.__readyPerf === undefined) {
        window.__readyPerf = performance.now();
      }
    });
    obs.observe(target, { childList: true });
    // 兜底：如果已经出现
    if (document.getElementById('buy-btn') && window.__readyPerf === undefined) {
      window.__readyPerf = performance.now();
    }
  });

  const r = await page.evaluate(
    ([pollMs, bundleSrc]) => {
      const setup = new Function(bundleSrc + '\nreturn { readStockState, findBuyButton };');
      const fns = setup();

      return new Promise((resolve) => {
        const t0 = performance.now();
        let rounds = 0;
        let costs = [];
        let hitAt = null;

        const tick = () => {
          const c0 = performance.now();
          const st = fns.readStockState();
          costs.push(performance.now() - c0);
          rounds++;

          if (st.state === 'IN_STOCK' && hitAt === null) {
            hitAt = performance.now();
            const b = fns.findBuyButton().actionable;
            if (b) b.click();
            resolve({
              hitAt,
              readyAt: window.__readyPerf,
              rounds,
              avgCost: costs.reduce((a, b) => a + b, 0) / costs.length,
              elapsed: performance.now() - t0,
            });
            return;
          }
          if (performance.now() - t0 > 6000) return resolve({ timeout: true, rounds });
          setTimeout(tick, pollMs);
        };
        tick();
      });
    },
    [pollMs, bundle],
  );

  await ctx.close();

  if (r.timeout) return { label, pollMs, 结果: '超时' };

  return {
    label,
    '轮询间隔ms': pollMs,
    '发现延迟ms': Math.round(r.hitAt - r.readyAt),
    '轮询轮次': r.rounds,
    '单轮耗时ms': +r.avgCost.toFixed(2),
  };
}

console.log('本地 mock 页面：', URL);
console.log('按钮在页面加载后 2 秒出现并变可点\n');

const runs = [];
for (const [ms, label] of [
  [3000, '当前配置'],
  [1000, '保守提速'],
  [300, '激进'],
  [150, '新默认（临售）'],
  [80, '极限'],
]) {
  // 每个间隔跑 3 次取平均
  const samples = [];
  for (let i = 0; i < 3; i++) {
    samples.push(await measurePrecise(ms, label));
  }
  const ok = samples.filter((s) => !s.timeout && s['发现延迟ms'] != null);
  const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b['发现延迟ms'], 0) / ok.length) : null;
  const avgCost = ok.length ? +(ok.reduce((a, b) => a + b['单轮耗时ms'], 0) / ok.length).toFixed(2) : null;
  runs.push({
    间隔ms: ms,
    说明: label,
    '平均发现延迟ms': avg,
    采样: ok.map((s) => s['发现延迟ms']),
    '单轮耗时ms': avgCost,
  });
}

/* 理论值对照 */
const roundCost = runs[0]['单轮耗时ms'] ?? 6;
const theory = runs.map((r) => ({
  间隔ms: r.间隔ms,
  '理论平均ms': Math.round(r.间隔ms / 2 + roundCost),
  '实测平均ms': r['平均发现延迟ms'],
}));

const out = {
  probedAt: new Date().toISOString(),
  note: '本地 mock 页面，未访问外部站点。发现延迟 = 按钮变可点 → 脚本检测到，页面内 performance.now() 计时',
  '单轮检测耗时ms': roundCost,
  实测: runs,
  理论对照: theory,
};

mkdirSync(join(__dirname, 'output'), { recursive: true });
const f = join(__dirname, 'output/hot-poll.json');
writeFileSync(f, JSON.stringify(out, null, 2));

console.log('单轮检测耗时：' + roundCost + 'ms\n');
console.log('间隔ms   说明         实测平均发现延迟   采样');
for (const r of runs) {
  console.log(
    String(r.间隔ms).padStart(6) + '   ' + r.说明.padEnd(12) + '  ' +
      String(r['平均发现延迟ms'] ?? '超时').padStart(12) + 'ms   ' + JSON.stringify(r.采样),
  );
}
console.log('\n理论对照：');
for (const t of theory) {
  console.log(`  间隔 ${String(t.间隔ms).padStart(5)}ms → 理论 ${String(t['理论平均ms']).padStart(5)}ms  实测 ${String(t['实测平均ms']).padStart(5)}ms`);
}
console.log('\n落盘:', f);

await browser.close();
server.close();
