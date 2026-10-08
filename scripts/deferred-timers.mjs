#!/usr/bin/env node
/**
 * 脱管定时器（2026-10-08 晨）：睡到指定时刻执行一次性任务后退出。
 * 由 schedule-purax-1000.mjs / 手动以 detached 方式拉起，不依赖 ZCode 会话。
 * 用法：node scripts/deferred-timers.mjs <HH:MM> <要跑的脚本相对路径> [输出日志路径]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [hhmm, script, logPath] = process.argv.slice(2);
if (!hhmm || !script) { console.error('用法: deferred-timers.mjs <HH:MM> <script> [log]'); process.exit(1); }
const [h, m] = hhmm.split(':').map(Number);
const target = new Date();
target.setHours(h, m, 0, 0);
const delay = target.getTime() - Date.now();
if (delay < -60 * 1000) { console.error(`目标时刻 ${hhmm} 已过，退出`); process.exit(0); }

setTimeout(() => {
  const out = [];
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => out.push(d));
  child.on('close', (code) => {
    const text = `[${new Date().toISOString()}] ${script} 退出码 ${code}\n` + Buffer.concat(out).toString();
    try { fs.appendFileSync(logPath || path.join(ROOT, 'data', 'grab', 'deferred-timers.log'), text + '\n'); } catch { /* 忽略 */ }
    // 预检类结果同时推到控制台「抢购结果」页，用户开着控制台就能看见
    if (/check-slot-logins/.test(script) && code !== 0) {
      fetch('http://127.0.0.1:3100/api/results/huawei', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          at: new Date().toISOString(), profileId: 'preflight',
          outcome: 'WAITING_HUMAN', resultCode: 'NEEDS_LOGIN',
          message: `${hhmm} 登录预检发现掉线（详见 ${logPath || 'data/grab/deferred-timers.log'}）——开售前请尽快去专用窗口重新登录`,
        }),
      }).catch(() => {});
    }
    process.exit(0);
  });
}, delay);
