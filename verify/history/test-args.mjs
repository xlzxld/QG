// 纯解析测试：不启动浏览器，只验证 arg() 的取值优先级
const BOOL_FLAGS = new Set(['headed', 'verbose']);

function arg(name, fallback) {
  const withEq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq !== undefined) return withEq.slice(name.length + 3);

  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;

  if (BOOL_FLAGS.has(name)) return true;

  const next = process.argv[idx + 1];
  if (next !== undefined && !next.startsWith('--')) return next;

  return true;
}

const cases = [
  ['--rounds', '2', '--interval', '5', '--http-rounds', '1'],
  ['--rounds=3'],
  ['--headed', '--config', 'targets-smoke.json'],
  [],
  ['--http', 'false'],
];

let pass = 0;
let fail = 0;

for (const extra of cases) {
  process.argv = ['node', 'probe.mjs', ...extra];
  const got = {
    rounds: arg('rounds', 0),
    interval: arg('interval', 0),
    headed: arg('headed', false),
    config: arg('config', 'targets.json'),
    http: arg('http', null),
    httpRounds: arg('http-rounds', 1),
  };
  const expected = {
    '["--rounds","2","--interval","5","--http-rounds","1"]': { rounds: '2', interval: '5', headed: false, config: 'targets.json', http: null, httpRounds: '1' },
    '["--rounds=3"]': { rounds: '3', interval: 0, headed: false, config: 'targets.json', http: null, httpRounds: 1 },
    '["--headed","--config","targets-smoke.json"]': { rounds: 0, interval: 0, headed: true, config: 'targets-smoke.json', http: null, httpRounds: 1 },
    '[]': { rounds: 0, interval: 0, headed: false, config: 'targets.json', http: null, httpRounds: 1 },
    '["--http","false"]': { rounds: 0, interval: 0, headed: false, config: 'targets.json', http: 'false', httpRounds: 1 },
  }[JSON.stringify(extra)];

  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(extra)}`);
  if (!ok) {
    console.log(`      期望 ${JSON.stringify(expected)}`);
    console.log(`      实得 ${JSON.stringify(got)}`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
