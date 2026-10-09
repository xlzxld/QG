/**
 * core/run-drill.mjs - PC端命令行一键执行脚本
 * =====================================================================
 * 功能：直接读取 damai.config.json 参数，一键向连接的手机派发安全演练任务
 * =====================================================================
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'damai.config.json');

async function main() {
  console.log('============================================================');
  console.log('🚀 QG 大麦抢购与全流程安全演练 - PC端一键击发工具');
  console.log('============================================================');

  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {}
  }

  const targetName = config.project?.name || '大麦演练项目';
  const session = config.selection?.sessionTarget || '';
  const price = config.selection?.priceTierTarget || '';
  const viewer = config.identity?.primaryAttendee || '';
  const count = config.selection?.ticketCount || 1;
  if (process.argv.includes('--rush')) {
    console.log('⚠️ 「定时抢票(--rush)」已下线 (2026-10-09 大麦抢购重写): 正式抢购请在控制台 (:3120) 使用「🔗 链接抢购」卡片 —— 粘贴链接 + 填开抢时间 → 布防。');
    console.log('   本命令行工具现在只保留「安全演练」用途。');
    process.exit(1);
  }
  const mode = 'test';

  console.log(`📋 当前演练配置参数:`);
  console.log(`   - 目标演出: ${targetName}`);
  console.log(`   - 目标场次: ${session || '(自适应首个有票)'}`);
  console.log(`   - 目标票档: ${price || '(自适应在售票档)'}`);
  console.log(`   - 实名观演人: ${viewer} (严格锁定)`);
  console.log(`   - 购票张数: ${count} 张`);
  console.log(`   - 执行模式: 🟢 安全演练 (停在提单前)`);
  console.log('------------------------------------------------------------');

  const task = {
    taskId: `drill-${Date.now()}`,
    platform: 'damai',
    mode,
    target: {
      name: targetName,
      itemId: config.project?.projectId ? String(config.project.projectId) : '',
      session,
      priceText: price,
      viewer,
      viewers: [viewer],
      count
    },
    timing: {
      fireAtEpochMs: 0,
      leadMs: 40
    }
  };

  const payload = JSON.stringify({ task });
  const req = http.request({
    hostname: '127.0.0.1',
    port: 3120,
    path: '/api/tasks/dispatch',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, res => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => {
      try {
        const ret = JSON.parse(raw);
        if (ret.status === 'dispatched') {
          console.log(`✅ 演练任务已成功下发至设备 [${ret.deviceId}]！`);
          console.log(`👀 请查看手机屏幕，AutoJs6 将自动平滑切入大麦并执行全流程装配...`);
          console.log(`🌐 也可以在浏览器中访问控制台查看实时投屏: http://localhost:3120`);
        } else {
          console.error(`❌ 下发返回:`, ret);
        }
      } catch (e) {
        console.error('响应解析失败:', raw);
      }
    });
  });

  req.on('error', err => {
    console.error(`❌ 无法连接设备中枢 (:3120): ${err.message}`);
    console.error(`   请先确保设备中枢已运行: node core/device-hub.mjs`);
  });

  req.write(payload);
  req.end();
}

main();
