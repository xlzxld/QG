/**
 * 真实环境验证：三层风控判定对 SNH48 官网页脚「黑名单」链接不再误判。
 *
 * 这是本次修复的最终验收 —— 必须用**真实页面**验证，不能只用测试 fixture。
 * 对照数据（修复前，2026-10-06 实测）：
 *   票务中心 https://shop.48.cn/tickets/Play  可见文字 1299 字，命中「黑名单」×1（页脚链接）
 *   首页     https://shop.48.cn/              可见文字 3351 字，命中「黑名单」×1（页脚链接）
 *   旧逻辑 → 判定 RISK_BLOCKED → 账号被写成 BLOCKED（必然触发的误判）
 *
 * 只读页面渲染结果，不登录、不提交任何东西。
 */
import { chromium } from 'playwright';

const TARGETS = [
  ['票务中心', 'https://shop.48.cn/tickets/Play'],
  ['商城首页', 'https://shop.48.cn/'],
];

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});

let allPass = true;

for (const [name, url] of TARGETS) {
  const page = await ctx.newPage();
  console.log(`\n${'='.repeat(72)}\n${name}  ${url}\n${'='.repeat(72)}`);
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const info = await page.evaluate(() => ({
      text: document.body ? document.body.innerText : '',
      title: document.title,
    }));
    const text = info.text;
    const len = text.trim().length;
    const httpStatus = resp ? resp.status() : null;

    console.log(`HTTP ${httpStatus}   标题: ${info.title}`);
    console.log(`最终 URL: ${page.url()}`);
    console.log(`可见文字: ${len} 字`);
    console.log(`含「黑名单」: ${text.split('黑名单').length - 1} 次（页脚条款链接，修复前会触发误判）`);

    // ── 复刻三层判定的判定过程 ──────────────────────────────
    const containerHits = await page.evaluate(() => {
      const selector = [
        '[class*="alert"]', '[class*="error"]', '[class*="warn"]', '[class*="risk"]',
        '[class*="forbid"]', '[class*="banned"]', '[class*="locked"]',
        '[role="alert"]', '[aria-live]', '.tips', '.notice', '.message',
      ].join(',');
      const keywords = ['黑名单', '限制购票', '禁止购票', '访问受限', '已被限制', '账号异常', '禁止下单'];
      const hits = [];
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') continue;
        const html = el;
        const t = (html.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 120) continue;
        if (html.querySelector('a')) continue;
        for (const kw of keywords) if (t.includes(kw)) hits.push({ kw, text: t.slice(0, 80) });
      }
      return hits;
    });

    const noticePageHit =
      containerHits.length === 0 && len <= 400
        ? ['黑名单', '限制购票', '禁止购票', '访问受限', '操作过于频繁', '请求过于频繁', '系统繁忙', '拒绝访问', 'Access Denied'].find((p) =>
            text.replace(/\s+/g, ' ').includes(p),
          )
        : undefined;

    const wouldDetect = containerHits.length > 0 || Boolean(noticePageHit);

    console.log('');
    console.log('【三层判定结果】');
    console.log(`  L1 HTTP 状态码      : ${httpStatus} → ${httpStatus === 200 ? '正常' : '需关注'}`);
    console.log(`  L3 告警容器内命中   : ${containerHits.length} 处${containerHits.length ? ' → ' + JSON.stringify(containerHits) : '（页脚链接已被排除）'}`);
    console.log(`  L3-b 整页告警页判定 : ${noticePageHit ? `命中「${noticePageHit}」` : `未触发（页面 ${len} 字 > 400 字阈值）`}`);
    console.log('');
    console.log(`  ➜ 是否判定为封禁: ${wouldDetect ? '❌ 是（仍有误判！）' : '✅ 否（误判已修复）'}`);

    if (wouldDetect) allPass = false;
  } catch (e) {
    console.log(`抓取失败: ${e.message.split('\n')[0]}`);
    allPass = false;
  }
  await page.close();
}

await ctx.close();
await browser.close();

console.log(`\n${'='.repeat(72)}`);
console.log(allPass ? '✅ 真实页面验证通过：页脚「黑名单」链接不再导致账号被封禁判定' : '❌ 仍有误判，需要继续修复');
console.log('='.repeat(72));
