/**
 * 验证混合内容假设：https 页面 → http://127.0.0.1:3100
 *
 * 背景：油猴的 GM_xmlhttpRequest 在 Chrome 上走扩展通道，
 * 通常能绕过页面的 CSP 与混合内容限制 —— 但**前提是 @connect 声明正确**。
 * 本脚本 @connect 写的是 127.0.0.1 和 localhost，看起来没问题。
 *
 * 但真正的问题可能在这里：
 *   桥接服务是否监听在 127.0.0.1（而非 0.0.0.0 / ::1）？
 *   Chrome 对 loopback 的 PNA/CORS 策略在 2024 后收紧了，
 *   从 https 源访问 http://127.0.0.1 会被当作「私有网络访问」拦截。
 *
 * 本脚本直接测：桥接的 CORS 响应头 + 是否能被 https 源 fetch 到。
 */
const BRIDGE = 'http://127.0.0.1:3100';

console.log('=== 1. 桥接是否可达 ===');
try {
  const r = await fetch(`${BRIDGE}/health`);
  console.log('  /health →', r.status);
  console.log('  CORS-Allow-Origin:', r.headers.get('access-control-allow-origin') || '(无 ← 关键)');
} catch (e) {
  console.log('  ✗ 不可达:', e.message);
}

console.log('');
console.log('=== 2. OPTIONS 预检（浏览器跨域前会先发这个）===');
try {
  const r = await fetch(`${BRIDGE}/api/config/huawei`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://item.vmall.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  console.log('  预检状态:', r.status);
  const h = (n) => r.headers.get(n) || '(无)';
  console.log('  Allow-Origin :', h('access-control-allow-origin'));
  console.log('  Allow-Methods:', h('access-control-allow-methods'));
  console.log('  Allow-Headers:', h('access-control-allow-headers'));
} catch (e) {
  console.log('  ✗ 预检失败:', e.message);
}

console.log('');
console.log('=== 3. 桥接监听在哪个地址 ===');
const net = await import('node:net');
const os = await import('node:os');

async function tryHost(host) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: 3100 }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(2500, () => { s.destroy(); resolve(false); });
  });
}

for (const h of ['127.0.0.1', 'localhost', '::1']) {
  console.log(`  ${h.padEnd(12)} →`, (await tryHost(h)) ? '可连' : '不通');
}
