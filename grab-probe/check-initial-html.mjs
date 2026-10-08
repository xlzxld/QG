// 一次性核查：比较"渲染后的可见文本"与"初始 HTML 原始字节"里库存信号的出现情况
// 目的：判断华为商城究竟是把库存信息放在服务端 HTML 里，还是靠 JS 注入
const urls = [
  ['Mate80', 'https://www.vmall.com/product/10086133363559.html'],
  ['麦芒9(旧)', 'https://www.vmall.com/product/10086741488253.html'],
];

const SIGNALS = [
  ['加入购物车', 'in_stock'],
  ['立即购买', 'in_stock'],
  ['售罄', 'out_of_stock'],
  ['已下架', 'out_of_stock'],
  ['暂时缺货', 'out_of_stock'],
  ['到货通知', 'out_of_stock'],
  ['订金', 'preorder'],
  ['接受预购', 'preorder'],
  ['即将开售', 'preorder'],
];

for (const [name, url] of urls) {
  console.log(`\n${'='.repeat(70)}\n${name}  ${url}\n${'='.repeat(70)}`);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
  } catch (e) {
    console.log(`抓取失败: ${e.message}`);
    continue;
  }
  const html = await res.text();
  console.log(`HTTP ${res.status}   初始 HTML 字符数: ${html.length}`);
  console.log(`最终 URL: ${res.url}`);

  let anyHit = false;
  for (const [word, kind] of SIGNALS) {
    const n = html.split(word).length - 1;
    if (n > 0) {
      anyHit = true;
      console.log(`  命中 [${kind}] "${word}" × ${n}`);
    }
  }
  if (!anyHit) console.log('  ✗ 初始 HTML 中不含任何库存信号词 —— 说明库存状态由 JS 注入');

  // 看页面是否内嵌了商品数据的 JSON（不含私有接口，只查初始 HTML 自身的内容）
  const hasJsonState = /window\.__[A-Z_]*INITIAL[A-Z_]*STATE|window\.__NUXT__|__NEXT_DATA__|prdId/i.test(html);
  console.log(`  初始 HTML 内嵌状态对象迹象: ${hasJsonState ? '有' : '无'}`);
}
