/**
 * 启动器交互链路测试
 *
 * 用带延迟的方式向启动器进程逐行喂输入，模拟真人敲键盘的节奏，
 * 验证「选爬虫 → 选运行方式 → 执行」这条链路是否真的走得通。
 *
 * 目的：区分「管道时序问题」和「launcher 真的读不到输入」。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.log('用法: node scripts/test-launcher-interactive.mjs <输入1> <输入2> ...');
  process.exit(1);
}

console.log(`将依次输入: ${JSON.stringify(inputs)}（每行间隔 1.2 秒，模拟真人）\n`);
console.log('─'.repeat(70));

const child = spawn(process.execPath, ['scripts/grab-launcher.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (d) => {
  const s = d.toString();
  output += s;
  process.stdout.write(s);
});
child.stderr.on('data', (d) => {
  const s = d.toString();
  output += s;
  process.stderr.write(s);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const inp of inputs) {
    await sleep(1200);
    console.log(`\n>>> [测试] 输入: ${JSON.stringify(inp)}`);
    child.stdin.write(inp + '\n');
  }

  // 等它跑完（爬虫最长给 5 分钟）
  const done = await Promise.race([
    new Promise((r) => child.on('close', (code) => r({ closed: true, code }))),
    sleep(300000).then(() => ({ closed: false })),
  ]);

  console.log('\n' + '─'.repeat(70));
  if (done.closed) {
    console.log(`进程已退出，退出码 ${done.code}`);
  } else {
    console.log('超时未退出，强制结束');
    child.kill('SIGKILL');
  }

  // 关键断言
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
  const checks = [
    ['启动器标题正常', /一键启动器/.test(stripped)],
    ['爬虫清单已显示', /可用的爬虫/.test(stripped)],
    ['运行方式菜单已显示', /选择运行方式/.test(stripped)],
    ['没有解析类报错', !/不是内部或外部命令|is not recognized/.test(stripped)],
  ];
  if (inputs.length >= 3) {
    checks.push(['进入了采集流程', /正在启动|采集完成|采集失败/.test(stripped)]);
  }

  console.log('\n断言结果:');
  let fail = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
    if (!ok) fail++;
  }

  // 若最后停在提问上，说明输入没被消费
  const waitingAtEnd = /请输入编号并回车[^\n]*$/.test(stripped.trimEnd());
  if (waitingAtEnd) {
    console.log('  ⚠️ 输出末尾仍停在「请输入编号并回车」，说明还有输入没被消费');
  }

  process.exit(fail ? 1 : 0);
})();
