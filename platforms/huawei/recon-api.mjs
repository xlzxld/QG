/**
 * 接口侦察（只读）
 *
 * 目的：在真正接线之前，先看清楚页面上到底有哪些数据响应、返回什么结构。
 *       不猜、不逆向，只观察页面自己发的请求。
 *
 * 做法：
 *   页面自己正常发请求（我们只是滚动、点分类，跟人一样）
 *   → 挂钩 window.fetch / XMLHttpRequest 看响应
 *   → 打印 URL 与顶层字段结构
 *
 * ⚠ 本脚本不发送任何自己构造的请求，不修改参数，不逆向签名。
 *   它只在页面上下文里旁听页面自己的通信。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'recon');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const SITES = [
  { name: 'vmall-home', url: 'https://www.vmall.com/' },
  { name: 'vmall-search', url: 'https://search.vmall.com/search?keyword=Mate%2090' },
  { name: 'vmall-product', url: 'https://www.vmall.com/product/10086133363559.html' },
];

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});

const summary = [];

for (const site of SITES) {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`${site.name}  ${site.url}`);
  console.log('='.repeat(74));

  const page = await ctx.newPage();
  const captured = [];

  // 在页面上下文里挂钩，只观察、不干预
  await page.addInitScript(() => {
    window.__qpCaptured = [];

    const looksLikeData = (ct) =>
      /json|javascript|text\/plain/i.test(ct || '');

    // ---- fetch ----
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const res = await origFetch.apply(this, args);
      try {
        const ct = res.headers.get('content-type') || '';
        if (looksLikeData(ct) && reqUrl) {
          const clone = res.clone();
          clone
            .text()
            .then((txt) => {
              if (!txt) return;
              let parsed = null;
              try {
                parsed = JSON.parse(txt);
              } catch {
                /* 不是 JSON，跳过 */
              }
              window.__qpCaptured.push({
                via: 'fetch',
                url: reqUrl,
                status: res.status,
                contentType: ct,
                bytes: txt.length,
                isJson: !!parsed,
                topKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 30) : null,
                preview: txt.slice(0, 4000),
              });
            })
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return res;
    };

    // ---- XMLHttpRequest ----
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__qpUrl = url;
      this.__qpMethod = method;
      return OrigOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', function () {
        try {
          const ct = this.getResponseHeader && this.getResponseHeader('content-type');
          if (!looksLikeData(ct)) return;
          const txt = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
          if (!txt) return;
          let parsed = null;
          try {
            parsed = JSON.parse(txt);
          } catch {
            /* not json */
          }
          window.__qpCaptured.push({
            via: 'xhr',
            url: this.__qpUrl,
            status: this.status,
            contentType: ct,
            bytes: txt.length,
            isJson: !!parsed,
            topKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 30) : null,
            preview: txt.slice(0, 4000),
          });
        } catch {
          /* ignore */
        }
      });
      return OrigSend.apply(this, args);
    };
  });

  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`导航失败: ${e.message.split('\n')[0]}`);
  }
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // 像人一样滚动一下，触发懒加载
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 2600));
  await page.waitForTimeout(1500);

  // 如果是搜索页，试着在搜索框里敲一次（这也是页面自己发请求）
  if (site.name.includes('search')) {
    try {
      const input = await page.$('input[type="text"], input[type="search"], input[placeholder*="搜索"]');
      if (input) {
        await input.click();
        await input.type('Pura', { delay: 120 });
        await page.waitForTimeout(2500);
        console.log('  已在搜索框输入「Pura」，观察页面自己的请求');
      }
    } catch {
      /* ignore */
    }
  }

  await page.waitForTimeout(2000);

  const got = await page.evaluate(() => window.__qpCaptured || []);
  console.log(`捕获到 ${got.length} 条数据响应`);

  // 按"是否像商品数据"打分
  const scored = got.map((g) => {
    const u = String(g.url).toLowerCase();
    let score = 0;
    if (g.isJson) score += 2;
    if (/product|detail|sku|item|goods|search|list|category|query/.test(u)) score += 4;
    if (/\.(png|jpg|jpeg|gif|css|woff|svg|ico)/.test(u)) score -= 10;
    if (/collect|report|log|track|monitor|beacon|sentry|analytics/.test(u)) score -= 6;
    if (g.topKeys && g.topKeys.some((k) => /data|result|list|product|item/i.test(k))) score += 3;
    return { ...g, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const interesting = scored.filter((s) => s.score > 0);
  console.log(`其中可能相关的: ${interesting.length} 条\n`);

  for (const it of interesting.slice(0, 15)) {
    const shortUrl = it.url.length > 110 ? it.url.slice(0, 110) + '…' : it.url;
    console.log(`  [${it.score}] ${it.via} ${it.status} ${it.bytes}B  ${shortUrl}`);
    if (it.topKeys) console.log(`       顶层字段: ${it.topKeys.join(', ')}`);
  }

  // 落盘全部原始捕获，供细看
  const outFile = path.join(OUT_DIR, `${site.name}-captured.json`);
  fs.writeFileSync(outFile, JSON.stringify(scored, null, 2), 'utf8');
  console.log(`\n  全部捕获已写入 ${path.relative(process.cwd(), outFile)}`);

  summary.push({ site: site.name, total: got.length, interesting: interesting.length, file: outFile });

  await page.close();
}

console.log(`\n${'='.repeat(74)}`);
console.log('汇总');
console.log('='.repeat(74));
for (const s of summary) {
  console.log(`  ${s.site.padEnd(16)} 捕获 ${String(s.total).padStart(4)} 条，相关 ${String(s.interesting).padStart(3)} 条`);
}

await ctx.close();
await browser.close();
