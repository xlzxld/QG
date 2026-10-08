/**
 * 验证 @match 规则能否匹配真实商品页 URL。
 *
 * 截图里油猴提示「URL 不匹配」是最大嫌疑，
 * 所以按 Chrome Match Pattern 规范（简化版）逐条比对。
 *
 * Chrome 规则要点：
 *   - scheme 支持 * / http / https
 *   - host 支持 * 与 *.后缀 形式
 *   - path 必须以 / 开头，其中的 * 可匹配任意字符（含 /）
 *   - 查询串与 hash 不参与匹配判断
 */
const pats = [
  'https://item.vmall.com/product/comdetail/*',
  'https://www.vmall.com/product/*',
  'https://m.vmall.com/product/comdetail/*',
];

const urls = [
  'https://item.vmall.com/product/comdetail/index.html?prdId=10086384648661&sbomCode=2601010640927&cid=391446',
  'https://item.vmall.com/product/comdetail/index.html',
  'https://item.vmall.com/product/10086384648661.html',
  'https://www.vmall.com/product/10086384648661.html',
  'https://m.vmall.com/product/comdetail/index.html?prdId=1',
];

function matchPattern(pattern, url) {
  const m = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/);
  if (!m) return { ok: false, why: '规则本身格式非法' };
  const [, scheme, host, path] = m;

  const u = new URL(url);

  // scheme
  if (scheme !== '*' && scheme !== u.protocol.replace(':', '')) {
    return { ok: false, why: `scheme 不符（规则 ${scheme}，实际 ${u.protocol}）` };
  }

  // host
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const suffix = host.slice(1); // ".vmall.com"
      if (!u.hostname.endsWith(suffix)) {
        return { ok: false, why: `host 不符（需以 ${suffix} 结尾，实际 ${u.hostname}）` };
      }
    } else if (host !== u.hostname) {
      return { ok: false, why: `host 不符（规则 ${host}，实际 ${u.hostname}）` };
    }
  }

  // path：把 * 转成 .*
  const pathRe = new RegExp('^' + path.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  if (!pathRe.test(u.pathname)) {
    return { ok: false, why: `path 不符（规则 ${path}，实际 ${u.pathname}）` };
  }

  return { ok: true, why: '匹配' };
}

console.log('=== 逐条规则 × 逐个 URL ===\n');
for (const u of urls) {
  console.log('URL:', u.length > 74 ? u.slice(0, 74) + '…' : u);
  let any = false;
  for (const p of pats) {
    const r = matchPattern(p, u);
    if (r.ok) any = true;
    console.log(`   ${r.ok ? '✓' : '✗'} ${p}`);
    if (!r.ok) console.log(`       └ ${r.why}`);
  }
  console.log(`   ⇒ 最终：${any ? '会被脚本命中 ✓' : '没有任何规则命中 ✗'}\n`);
}
