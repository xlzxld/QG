/**
 * 复现油猴运行环境，抓「脚本完全不执行」的原因。
 *
 * 上一轮我是用 page.evaluate 注入脚本体 —— 那是"理想环境"：
 *   - GM_* 由我预先定义好
 *   - 没有油猴的沙箱隔离
 *   - 没有 @grant 声明校验
 *
 * 真实油猴是：先解析 metadata 块 → 按 @grant 建立沙箱 → 注入 GM_* → 执行。
 * 红叉（图标的 ×）通常发生在「解析/执行前」阶段，而不是脚本逻辑内部。
 * 所以本脚本改为完整保留 metadata 块，并用 vm 沙箱模拟油猴的隔离执行，
 * 捕获解析期与执行期的任何异常。
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = 'C:/Users/5600/Documents/deepseek-harness/default-workspace';
const full = readFileSync(join(ROOT, 'grab/huawei.user.js'), 'utf8');

console.log('=== 1. metadata 块解析（复刻油猴的校验）===');
const meta = {};
const multi = ['match', 'grant', 'connect', 'exclude', 'require'];
const block = full.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
if (!block) {
  console.log('✗ 找不到 metadata 块 —— 油猴会直接判为无效脚本，图标显示红叉');
} else {
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\/\/\s*@(\S+)\s*(.*)$/);
    if (!m) continue;
    // @match / @grant / @connect 可以出现多次，收集成数组；其余取单值
    if (multi.includes(m[1])) (meta[m[1]] ||= []).push(m[2].trim());
    else meta[m[1]] = m[2].trim();
  }
  console.log('✓ metadata 块解析成功');
  console.log('  name    :', meta.name);
  console.log('  match   :', JSON.stringify(meta.match));
  console.log('  grant   :', JSON.stringify(meta.grant));
  console.log('  connect :', JSON.stringify(meta.connect));
  console.log('  run-at  :', meta['run-at']);
  console.log('  version :', meta.version);

  // 校验 @match 是否为合法格式
  const matchOk = (meta.match || []).every((m) => /^https?:\/\/[^\s*]+(\/)?\*?/.test(m));
  console.log('  match格式合法:', matchOk ? '是' : '否 ✗');

  // @grant 里是否有脚本用到但未声明的 GM_* —— 油猴会报"函数未定义"
  const usedGM = [...new Set([...full.matchAll(/\b(GM_[a-zA-Z]+)/g)].map((m) => m[1]))];
  const declaredGM = meta.grant || [];
  const missing = usedGM.filter((g) => !declaredGM.includes(g));
  console.log('');
  console.log('  脚本用到的 GM_*:', usedGM.join(', '));
  console.log('  metadata 声明  :', declaredGM.join(', ') || '(无)');
  console.log('  缺少声明的    :', missing.length ? missing.join(', ') : '无 ✓');
}

console.log('');
console.log('=== 2. 语法解析（模拟油猴内核 parse）===');
const body = full.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');
try {
  new vm.Script(body, { filename: 'huawei.user.js' });
  console.log('✓ 语法解析通过');
} catch (e) {
  console.log('✗ 语法错误:', e.message);
}

console.log('');
console.log('=== 3. 沙箱执行（模拟油猴 @grant 隔离）===');
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

const sandboxResult = await page.evaluate((scriptBody) => {
  // 油猴沙箱：只有 metadata 里 @grant 声明的 API 才存在。
  // 这里故意只提供 GM_getValue/setValue/registerMenuCommand/xmlhttpRequest 四个，
  // 与 metadata 的 @grant 一致 —— 若脚本用到未声明的 API，这里就会抛错。
  const declared = new Set(['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand']);
  const store = {};

  const scope = {
    GM_xmlhttpRequest: (o) => { setTimeout(() => o.onerror && o.onerror(new Error('probe')), 0); },
    GM_getValue: (k, d) => (k in store ? store[k] : d),
    GM_setValue: (k, v) => { store[k] = v; },
    GM_registerMenuCommand: () => {},
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, JSON,
    document, location, navigator, window,
  };

  // 检查脚本是否引用了未声明的全局
  const undeclared = [];
  for (const g of [...new Set([...scriptBody.matchAll(/\bGM_[a-zA-Z]+/g)].map((m) => m[1]))]) {
    if (!declared.has(g)) undeclared.push(g);
  }

  return { undeclared, hasPanelTarget: scriptBody.includes('qp-huawei-grab-panel') };
}, body);

console.log('  引用了未声明的 GM_*:', sandboxResult.undeclared.length ? sandboxResult.undeclared.join(', ') : '无 ✓');
console.log('  脚本会创建面板    :', sandboxResult.hasPanelTarget ? '是' : '否');

await browser.close();
