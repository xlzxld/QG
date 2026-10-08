/**
 * 一次性调研脚本：批量核实 GitHub 仓库真实状态（星数 / 活跃度 / 许可证 / 是否归档）
 * 用途：为《移动端抢购控制台方案》选型提供「眼见为实」的证据，避免引用不存在或已死掉的项目。
 * 运行：node verify/tmp/fetch-oss-repos.mjs
 * 输出：verify/tmp/oss-repos.json + 终端表格
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPOS = [
  // —— 设备控制 / 投屏 ——
  'Genymobile/scrcpy',
  'barry-ran/QtScrcpy',
  'NetrisTV/ws-scrcpy',
  // —— 设备农场 / 群控 ——
  'DeviceFarmer/stf',
  'openatx/atxserver2',
  'SonicCloudOrg/sonic-server',
  'SonicCloudOrg/sonic-android-agent',
  // —— 设备端自动化 ——
  'openatx/uiautomator2',
  'openatx/atx-agent',
  'openatx/weditor',
  'AirtestProject/Airtest',
  'appium/appium',
  'mobile-dev-inc/maestro',
  'web-infra-dev/midscene',
  'X-PLUG/MobileAgent',
  // —— 脚本引擎（设备端常驻 Agent 候选）——
  'SuperMonster003/AutoJs6',
  'kkevsekk1/AutoX',
  // —— 权限 / 系统 ——
  'RikkaApps/Shizuku',
  'topjohnwu/Magisk',
  'termux/termux-app',
  // —— 模拟器 / 容器方案 ——
  'remote-android/redroid-doc',
  'budtmo/docker-android',
  // —— ADB 生态 ——
  'yume-chan/ya-webadb',
  'openstf/adbkit',
  'DeviceFarmer/adbkit',
  'openstf/minitouch',
  // —— 抢购业务参考项目 ——
  'tychxn/jd-assistant',
  'WECENG/ticket-purchase',
  'huanghyw/jd_seckill',
  'ztino/jd_seckill',
  'zhou-xiaojun/jd_mask',
  'caicai12/damai-ticket-assistant',
  'Pactum7/ticket-grabbing',
  'MonsterNone/auto-taobao.js',
  'yinwenqin/AutoJs_jingdong',
];

const RELEASE_CHECK = [
  'SuperMonster003/AutoJs6',
  'kkevsekk1/AutoX',
  'Genymobile/scrcpy',
  'RikkaApps/Shizuku',
  'barry-ran/QtScrcpy',
];

const UA = { 'User-Agent': 'wb-research-script', Accept: 'application/vnd.github+json' };

async function getJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const out = [];
for (const r of REPOS) {
  try {
    const d = await getJson(`https://api.github.com/repos/${r}`);
    out.push({
      repo: r,
      full: d.full_name,
      stars: d.stargazers_count,
      forks: d.forks_count,
      language: d.language,
      license: d.license ? d.license.spdx_id : null,
      pushedAt: d.pushed_at,
      archived: d.archived,
      openIssues: d.open_issues_count,
      desc: d.description,
      homepage: d.homepage || null,
    });
  } catch (e) {
    out.push({ repo: r, error: e.message });
  }
  await new Promise((rr) => setTimeout(rr, 200));
}

const releases = [];
for (const r of RELEASE_CHECK) {
  try {
    const d = await getJson(`https://api.github.com/repos/${r}/releases/latest`);
    releases.push({ repo: r, tag: d.tag_name, name: d.name, publishedAt: d.published_at });
  } catch (e) {
    releases.push({ repo: r, error: e.message });
  }
  await new Promise((rr) => setTimeout(rr, 200));
}

const payload = { fetchedAt: new Date().toISOString(), repos: out, latestReleases: releases };
fs.writeFileSync(path.join(__dirname, 'oss-repos.json'), JSON.stringify(payload, null, 2), 'utf8');

for (const x of out) {
  if (x.error) console.log(`✘ ${x.repo} → ${x.error}`);
  else
    console.log(
      `✔ ${x.full} | ★${x.stars} | ${x.license || '无许可证'} | ${x.language || '-'} | 最后推送 ${String(x.pushedAt).slice(0, 10)} | 归档=${x.archived}\n    ${x.desc || ''}`,
    );
}
console.log('\n—— 最新 releases ——');
for (const x of releases) {
  console.log(x.error ? `✘ ${x.repo} → ${x.error}` : `✔ ${x.repo} | ${x.tag} | ${x.name} | ${String(x.publishedAt).slice(0, 10)}`);
}
