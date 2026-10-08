/**
 * tools/mobile/bundle-agent.mjs - 端侧 Agent 单文件免依赖打包器
 * =====================================================================
 * 解决痛点：
 *   AutoJs6 / AutoX 运行时在直接执行单独脚本时，jvm-npm 无法解析相对 require()，
 *   报错: Error: Can't resolve relative module ID "./bootstrap.js" outside of a module
 * 
 * 方案：
 *   将 bootstrap, transport, timesync, anchor-fire, monitor, damai 等模块
 *   静态内联融合为单文件 main.js，彻底移除一切 require() 调用。
 *   零外部依赖，任何目录、任何方式（UI点击/编辑器运行/缓存运行）均可秒级启动！
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const AGENT_DIR = path.join(ROOT, 'platforms', 'app', 'agent');

function cleanModule(code) {
  return code
    .replace(/^\s*var\s+\w+\s*=\s*require\([^)]+\);?\s*$/gm, '')
    .replace(/^\s*module\.exports\s*=\s*\w+;?\s*$/gm, '');
}

console.log('📦 正在融合端侧 Agent 所有模块为单文件架构...');

const bootstrapCode = cleanModule(fs.readFileSync(path.join(AGENT_DIR, 'bootstrap.js'), 'utf8'));
const timesyncCode = cleanModule(fs.readFileSync(path.join(AGENT_DIR, 'timesync.js'), 'utf8'));
const anchorFireCode = cleanModule(fs.readFileSync(path.join(AGENT_DIR, 'anchor-fire.js'), 'utf8'));
const transportCode = cleanModule(fs.readFileSync(path.join(AGENT_DIR, 'transport.js'), 'utf8'));
const monitorCode = cleanModule(fs.readFileSync(path.join(AGENT_DIR, 'adapters', 'monitor.js'), 'utf8'));
const damaiCode = cleanModule(fs.readFileSync(path.join(AGENT_DIR, 'adapters', 'damai.js'), 'utf8'));

// runner.js 主体调度逻辑
const rawMain = fs.readFileSync(path.join(AGENT_DIR, 'runner.js'), 'utf8');
const mainLogic = cleanModule(rawMain);

const header = `/**
 * =====================================================================
 * QG-Agent 移动端全功能免依赖抢购引擎 (AutoJs6 / AutoX 独立全功能单文件版)
 * 生成时间: ${new Date().toISOString()}
 * 零 require 依赖，兼容任何目录直接运行 (彻底根除 jvm-npm 相对路径抛错)
 * =====================================================================
 */

"auto";
`;

const bundledContent = [
  header,
  '// ==================== [1. Bootstrap 模块] ====================',
  bootstrapCode,
  '// ==================== [2. TimeSync 时钟对齐模块] ====================',
  timesyncCode,
  '// ==================== [3. AnchorFire 坐标锚定模块] ====================',
  anchorFireCode,
  '// ==================== [4. Transport 通信传输层] ====================',
  transportCode,
  '// ==================== [5. MonitorAdapter 监控模块] ====================',
  monitorCode,
  '// ==================== [6. DamaiAdapter 适配器] ====================',
  damaiCode,
  '// ==================== [7. Main 调度主逻辑] ====================',
  mainLogic
].join('\n\n');

const targetMain = path.join(AGENT_DIR, 'main.js');
const targetStandalone = path.join(AGENT_DIR, 'main.standalone.js');

fs.writeFileSync(targetMain, bundledContent, 'utf8');
fs.writeFileSync(targetStandalone, bundledContent, 'utf8');

console.log(`✅ 单文件引擎已成功生成至:`);
console.log(`   - ${targetMain}`);
console.log(`   - ${targetStandalone}`);
console.log(`   文件总大小: ${(bundledContent.length / 1024).toFixed(1)} KB`);
