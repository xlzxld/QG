/**
 * 验证「红叉 + 面板完全不出现」的最可能成因。
 *
 * 上一轮确认：metadata 合法、语法通过、GM_* 声明齐全、脚本体本身零报错。
 * 那红叉就不是脚本逻辑的问题，而是运行时环境。
 *
 * 头号嫌疑：GM_xmlhttpRequest 从 https 页面请求 http://127.0.0.1:3100
 *  —— 油猴若未正确放行，或被页面 CSP / 混合内容策略拦截，
 *     onerror 可能不触发，而是直接同步抛异常，
 *     于是 loadConfig 的 try/catch 抓到「桥接不可达」，
 *     再退到 GM_getValue 缓存；缓存为空 → 抛「没有可用配置」→ 面板应出现。
 *     但若抛点在 ensurePanel 之前，面板就永远不出现。
 *
 * 本脚本检查调用顺序：面板创建 vs 首次可能抛出的调用。
 */
import { readFileSync } from 'node:fs';

const full = readFileSync('C:/Users/5600/Documents/deepseek-harness/default-workspace/grab/huawei.user.js', 'utf8');
const lines = full.split('\n');

const lineOf = (needle) => {
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : -1;
};

console.log('=== 关键调用的行号顺序 ===');
const marks = [
  ['面板 DOM 创建 document.body.appendChild', 'document.body.appendChild(panelEl)'],
  ['log() 定义', 'function log(msg, level)'],
  ['ensurePanel() 定义', 'function ensurePanel()'],
  ['main() 定义', 'async function main()'],
  ['main() 内首次 log', "log('脚本已注入，正在载入配置…')"],
  ['ensurePanel() 首次调用', 'ensurePanel();'],
  ['loadConfig() 调用', 'config = await loadConfig();'],
  ['GM_xmlhttpRequest 调用', 'GM_xmlhttpRequest({'],
  ['main() 实际执行', 'main().catch'],
];
for (const [label, needle] of marks) {
  console.log(String(lineOf(needle)).padStart(5), label);
}

console.log('');
console.log('=== main() 开头 8 行（确认面板是否先于一切创建）===');
const m = lineOf('async function main()');
for (let i = m; i < m + 8; i++) console.log(String(i).padStart(5), '|', lines[i - 1]);

console.log('');
console.log('=== 顶层 IIFE 尾部（catch 兜底）===');
const c = lineOf('main().catch');
for (let i = c; i < c + 10; i++) console.log(String(i).padStart(5), '|', lines[i - 1] || '');

console.log('');
console.log('=== 关键结论 ===');
const panelCreatedFirst = lineOf('document.body.appendChild(panelEl)') < lineOf('config = await loadConfig();');
console.log('面板创建早于配置加载:', panelCreatedFirst ? '是 → 面板本应出现' : '否 → 面板可能来不及出现');
console.log('');
console.log('若你看不到面板，且油猴图标是红叉，最可能是：');
console.log('  1) 脚本在 metadata 校验阶段就没被加载（@match 没匹配到你实际打开的地址）');
console.log('  2) 油猴报的是「脚本内部有错误」，错误发生在 IIFE 执行早期');
console.log('  3) 混合内容：https 页面 → http://127.0.0.1 被浏览器直接拦掉');
