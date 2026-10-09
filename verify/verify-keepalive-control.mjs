#!/usr/bin/env node
/**
 * 保活守护「控制通道」自测（2026-10-09）
 * =====================================================================
 * 测什么（对应 2026-10-09“点了停止还在续命”修复）：
 *   T1 守护启动后：控制端口应答 + PID 文件已写
 *   T2 重复启动第二个守护：它要自己退出，并在日志写明「已在运行」（单例=端口独占，原子）
 *   T3 一次性测试轮（--once）：不碰 PID 文件、日志带【测试轮】标记、跑完自动退
 *   T4 「立即测一轮」→ 守护加跑一轮，日志带【手动测试】标记
 *   T5 控制端口停止：守护退出、端口不再应答、自己清掉 PID 文件
 *   T6 兜底通道：没有控制端口时，按 PID 文件 process.kill 能杀掉（旧版/降级模式的最后保命绳）
 *   T7 PID 文件被误删时：控制端口仍能证明守护活着（状态不再单靠文件）
 * 怎么做到零副作用：KEEPALIVE_DIR 把日志/PID/槽位文件重定向到 verify/tmp/ka-selftest，
 * 槽位文件只放一个死端口（9），不会碰任何真实 Chrome 窗口、不会发任何真实请求。
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'verify', 'tmp', 'ka-selftest');
const PORT = 3197;
const DAEMON = path.join(ROOT, 'core', 'keepalive-daemon.mjs');
const PID_FILE = path.join(TMP, 'keepalive.pid');
const LOG_FILE = path.join(TMP, 'keepalive.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

const readingLog = () => { try { return fs.readFileSync(LOG_FILE, 'utf8'); } catch { return ''; } };
const readPid = () => { try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || null; } catch { return null; } };
const ping = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/ping`, { signal: AbortSignal.timeout(600) });
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch { return null; }
};
const spawnDaemon = (args = []) =>
  spawn(process.execPath, [DAEMON, ...args], {
    env: { ...process.env, KEEPALIVE_DIR: TMP, KEEPALIVE_CTL_PORT: String(PORT) },
    detached: true, stdio: 'ignore', windowsHide: true,
  });
const waitExit = async (child, ms) => {
  if (child.exitCode !== null && child.exitCode !== undefined) return child.exitCode;
  return await new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); resolve(code); } });
  });
};
const waitFor = async (fn, ms, step = 200) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};
const killQuiet = (pid) => { try { process.kill(pid); } catch { /* 已死 */ } };

const children = [];
process.on('exit', () => { for (const c of children) killQuiet(c.pid); });

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  // 假槽位表：只有一个死端口（连不上→飞快记一行“检查异常”），绝不碰真窗口
  fs.writeFileSync(path.join(TMP, 'rush-slots.huawei.json'), JSON.stringify({ slots: [{ port: 9 }] }));

  console.log(`— 临时环境：${path.relative(ROOT, TMP)}（真环境不受影响）\n`);

  /* T1 启动守护 A */
  const A = spawnDaemon(); children.push(A);
  const aPing = await waitFor(ping, 8000);
  ok('T1 守护A启动，控制端口自报身份', aPing && aPing.pid === A.pid, `pid=${A.pid}`);
  await waitFor(() => readPid(), 5000);
  ok('T1b PID 文件已写且是 A 的号', readPid() === A.pid, `文件里=${readPid()}`);

  /* T2 重复启动 B → 必须自己退出 */
  const B = spawnDaemon(); children.push(B);
  const bExit = await waitExit(B, 10000);
  ok('T2 重复启动的守护B自行退出（单例生效）', bExit !== null, `退出码=${bExit}`);
  ok('T2b 日志写明「已在运行」', /已在运行/.test(readingLog()));
  ok('T2c 守护A仍然活着（B 没有顶掉它）', (await ping()) !== null);
  ok('T2d PID 文件仍是 A 的号', readPid() === A.pid);

  /* T3 一次性测试轮 */
  const T = spawnDaemon(['--once']); children.push(T);
  const tExit = await waitExit(T, 15000);
  ok('T3 测试轮跑完自动退出', tExit === 0, `退出码=${tExit}`);
  ok('T3b 测试轮没动 PID 文件（仍指向 A）', readPid() === A.pid);
  ok('T3c 测试轮日志带【测试轮】标记', /【测试轮】端口 9/.test(readingLog()));

  /* T4 「立即测一轮」→ 守护加跑一轮 */
  let r4 = null;
  try {
    r4 = await fetch(`http://127.0.0.1:${PORT}/round`, { method: 'POST', signal: AbortSignal.timeout(1500) }).then((r) => r.json());
  } catch { /* 下面断言 */ }
  ok('T4 /round 有回执', !!(r4 && r4.ok), r4 ? r4.note : '(无响应)');
  await waitFor(() => /【手动测试】端口 9/.test(readingLog()), 6000);
  ok('T4b 日志出现【手动测试】标记', /【手动测试】端口 9/.test(readingLog()));

  /* T5 控制端口停止 */
  const r5 = await fetch(`http://127.0.0.1:${PORT}/stop`, { method: 'POST' }).then((r) => r.ok).catch(() => false);
  const aExit = await waitExit(A, 6000);
  ok('T5 /stop 后守护A退出', aExit === 0, `退出码=${aExit}；回执ok=${r5}`);
  ok('T5b 停止后控制端口不再应答', (await ping()) === null);
  ok('T5c 守护自己清掉了 PID 文件', !fs.existsSync(PID_FILE));

  /* T7 先把“文件被误删”场景测了（用新守护 D 复用后面 T6） */
  const D = spawnDaemon(); children.push(D);
  await waitFor(() => readPid() === D.pid, 8000);
  ok('T7 守护D就绪', readPid() === D.pid && (await ping()) !== null);
  fs.unlinkSync(PID_FILE); // 模拟文件被误删
  ok('T7b PID 文件被删后，控制端口仍证明守护活着', (await ping()) !== null);

  /* T6 兜底通道：按文件杀（模拟旧版/降级模式）。先把文件补回来 */
  fs.writeFileSync(PID_FILE, String(D.pid));
  let dead = false;
  try { process.kill(D.pid); } catch { dead = true; }
  await sleep(700);
  try { process.kill(D.pid, 0); } catch { dead = true; }
  ok('T6 兜底通道：process.kill(PID文件) 能杀掉守护', dead);
  try { fs.unlinkSync(PID_FILE); } catch { /* 忽略 */ }

  /* 汇总 */
  for (const c of children) killQuiet(c.pid);
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${'='.repeat(56)}\n结果：${results.length - fails.length}/${results.length} 通过${fails.length ? '　❌ ' + fails.map((f) => f.name).join('；') : '　全部通过 🎉'}`);
  process.exit(fails.length ? 1 : 0);
})();
