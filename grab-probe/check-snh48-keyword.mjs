/**
 * 只读验证：SNH48 官方商城页面（未登录状态）里是否本来就含"黑名单"三个字。
 *
 * 目的：判断 SNH48Adapter 把账号标记为 BLOCKED 是真实风控，还是关键词误判。
 * 只读页面渲染出来的可见文字，不登录、不提交任何东西。
 */
import { chromium } from 'playwright';

const TARGETS = [
  ['票务中心', 'https://shop.48.cn/tickets/Play'],
  ['首页', 'https://shop.48.cn/'],
];

// SNH48Adapter 里使用的三个判定关键词
const ADAPTER_KEYWORDS = ['黑名单', '限制购票', '访问受限'];

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});

for (const [name, url] of TARGETS) {
  const page = await ctx.newPage();
  console.log(`\n${'='.repeat(70)}\n${name}  ${url}\n${'='.repeat(70)}`);
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const info = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      return { text, len: text.trim().length, title: document.title };
    });

    console.log(`HTTP ${resp ? resp.status() : '-'}   标题: ${info.title}`);
    console.log(`最终 URL: ${page.url()}`);
    console.log(`可见文字长度: ${info.len} 字`);
    console.log('');

    console.log('【SNH48Adapter 的判定关键词命中情况】');
    let anyHit = false;
    for (const kw of ADAPTER_KEYWORDS) {
      const n = info.text.split(kw).length - 1;
      if (n > 0) anyHit = true;
      console.log(`   "${kw}" × ${n}  ${n > 0 ? '← 命中，Adapter 会判定账号被封' : ''}`);
    }
    console.log(
      `\n   → Adapter 结论: ${anyHit ? '❌ 会误判为 RISK_BLOCKED / BLOCKED' : '✅ 不会误判'}`,
    );

    // 找出命中词出现的上下文
    if (anyHit) {
      console.log('\n【命中处的上下文（各 60 字）】');
      for (const kw of ADAPTER_KEYWORDS) {
        let idx = info.text.indexOf(kw);
        let shown = 0;
        while (idx !== -1 && shown < 5) {
          const start = Math.max(0, idx - 30);
          const ctxText = info.text.slice(start, idx + 30).replace(/\s+/g, ' ');
          console.log(`   …${ctxText}…`);
          idx = info.text.indexOf(kw, idx + 1);
          shown++;
        }
      }
      // 是否是页脚链接
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a'))
          .map((a) => ({ text: (a.innerText || '').trim(), href: a.href }))
          .filter((l) => l.text.includes('黑名单') || l.href.includes('/News/Item/59')),
      );
      if (links.length) {
        console.log('\n【含"黑名单"的链接（说明是导航/条款入口，不是封禁通知）】');
        for (const l of links) console.log(`   「${l.text}」 → ${l.href}`);
      }
    }
  } catch (e) {
    console.log(`抓取失败: ${e.message.split('\n')[0]}`);
  }
  await page.close();
}

await ctx.close();
await browser.close();
