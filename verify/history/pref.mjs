import { readFileSync } from 'node:fs';
const base = process.env.LOCALAPPDATA + '/Google/Chrome/User Data';
const j = JSON.parse(readFileSync(base + '/Default/Preferences', 'utf8'));
const tm = 'dhdgffkkebhmkfjojejmpbldmpobfkfo';
const ext = j.extensions?.settings?.[tm];
if (!ext) { console.log('油猴不在 Preferences 里（可能装在别的 profile）'); process.exit(0); }
console.log('state              :', ext.state);
console.log('disable_reasons    :', JSON.stringify(ext.disable_reasons));
console.log('from_webstore      :', ext.from_webstore);
// Chrome 把 userScripts 授权状态放在这里
console.log('granted_permissions:', JSON.stringify(ext.granted_permissions));
console.log('runtime_granted    :', JSON.stringify(ext.runtime_granted_permissions));
