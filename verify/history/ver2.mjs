import { readFileSync, existsSync, readdirSync } from 'node:fs';
const base = process.env.LOCALAPPDATA + '/Google/Chrome/User Data';
// 扩展目录里常有版本线索；另找 Chrome 的 Last Version 文件
const cands = [
  base + '/Last Version',
  base + '/Last Version (Local State)',
];
for (const p of cands) if (existsSync(p)) console.log(p, '=>', readFileSync(p, 'utf8').trim());

// 扩展版本号（Chrome 主版本可通过扩展兼容性反推不可行，改看 manifest 里的 minimum_chrome_version）
const tm = base + '/Extensions/dhdgffkkebhmkfjojejmpbldmpobfkfo';
if (existsSync(tm)) {
  for (const v of readdirSync(tm)) {
    try {
      const m = JSON.parse(readFileSync(`${tm}/${v}/manifest.json`, 'utf8'));
      console.log('油猴', m.version, '| minimum_chrome_version:', m.minimum_chrome_version || '(未声明)');
    } catch {}
  }
}
