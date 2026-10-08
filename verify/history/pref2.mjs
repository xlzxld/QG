import { readFileSync, readdirSync, existsSync } from 'node:fs';
const base = process.env.LOCALAPPDATA + '/Google/Chrome/User Data';
const TM = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
// Chrome 可能把扩展配置放在 Secure Preferences
for (const f of ['Default/Preferences', 'Default/Secure Preferences']) {
  const p = base + '/' + f;
  if (!existsSync(p)) { console.log(f, '→ 不存在'); continue; }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const ext = j.extensions?.settings?.[TM];
    if (!ext) { console.log(f, '→ 无油猴配置'); continue; }
    console.log('===', f, '===');
    console.log('  state           :', ext.state, '(1=启用, 2=停用)');
    console.log('  disable_reasons :', JSON.stringify(ext.disable_reasons));
    console.log('  granted_perms   :', JSON.stringify(ext.granted_permissions));
    console.log('  runtime_granted :', JSON.stringify(ext.runtime_granted_permissions));
  } catch (e) { console.log(f, '→ 解析失败', e.message); }
}
