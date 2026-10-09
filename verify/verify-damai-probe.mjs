/**
 * 大麦探针 v2 · 离线验证（2026-10-09）
 * =====================================================================
 * 验证对象：platforms/damai/probe-damai.mjs
 *
 * ① parseDetailPayload —— 用真实接口响应样本（verify/fixtures/damai-detail-sample.json）
 *    验证：巡演三站（贵阳/厦门/成都）、日期场次、名称派生、状态字段
 * ② mergeIntoCatalog —— 合成数据验证合并语义：
 *    a. 首采：当前站全量 + 同巡演其它站自动入概要（fullData=false）
 *    b. 补采概要站：升级为全量；已全量的站不被降级
 *    c. 重复采集：按 itemId 去重，不产生重复条目
 *    d. 同巡演所有条目的 stations 清单同步
 * ③ deriveTourName / deriveStationName 边界
 *
 * 用法：node verify/verify-damai-probe.mjs [--live]
 *   --live 追加一次真实采集冒烟（需要网络，约 10 秒）
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDetailPayload,
  mergeIntoCatalog,
  deriveTourName,
  deriveStationName,
  probeItem,
} from '../platforms/damai/probe-damai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failed = 0;
function ok(cond, msg) { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++; }

/* ==================== ① parseDetailPayload（fixture） ==================== */
console.log('=== ① parseDetailPayload（真实响应样本） ===');
const fixturePath = path.join(ROOT, 'verify', 'fixtures', 'damai-detail-sample.json');
if (!fs.existsSync(fixturePath)) {
  console.log('⚠️ 缺少 fixture，跳过（verify/fixtures/damai-detail-sample.json）');
} else {
  const payload = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const item = parseDetailPayload(payload);

  ok(item.itemId === '1085142029424', `itemId 正确: ${item.itemId}`);
  ok(item.stationName === '贵阳站', `站名派生: ${item.stationName}`);
  ok(item.tourName === '薛之谦“万兽之王”巡回演唱会', `巡演名派生: ${item.tourName}`);
  ok(item.tourId === '5850', `tourId: ${item.tourId}`);
  ok(item.stations.length === 3, `巡演共 3 站`);
  const names = item.stations.map((s) => s.stationName).join(',');
  ok(names === '贵阳站,厦门站,成都站', `站点列表: ${names}`);
  const cd = item.stations.find((s) => s.stationName === '成都站');
  ok(cd && cd.saleStatus === '缺货', `成都站状态: ${cd && cd.saleStatus}`);
  ok(item.stations.find((s) => s.current && s.itemId === '1085142029424'), '当前站标记 current');
  ok(item.sessions.length === 4, `日期场次 4 个: ${item.sessions.map((s) => s.name).join(' / ')}`);
  ok(item.saleStatus === '预约', `当前站销售状态: ${item.saleStatus}`);
  ok(item.priceRange === '317-1717', `价格范围: ${item.priceRange}`);
  ok(item.purchaseLimit === '4', `限购: ${item.purchaseLimit}`);
  ok(item.saleTimeHints.some((h) => h.includes('10月9日 17:17')), `开售提示含今晚 17:17: ${item.saleTimeHints.join('; ')}`);
  ok(item.fullData === true, 'fixture 解析结果为全量数据');
}

/* ==================== ② mergeIntoCatalog（合成数据） ==================== */
console.log('\n=== ② mergeIntoCatalog（合并语义） ===');

// 构造一个"贵阳站全量 + 厦门/成都概要"的探针结果
function makeProbeResult({ current = 'gy', sessions = 4 } = {}) {
  const stations = [
    { stationName: '贵阳站', itemId: 'gy', saleStatus: '预约', showTime: '10.17-10.25', tourId: 'T1', current: current === 'gy' },
    { stationName: '厦门站', itemId: 'xm', saleStatus: '预约', showTime: '10.31-11.08', tourId: 'T1', current: current === 'xm' },
    { stationName: '成都站', itemId: 'cd', saleStatus: '缺货', showTime: '10.10-10.11', tourId: 'T1', current: current === 'cd' },
  ];
  const cur = stations.find((s) => s.current);
  return {
    id: `st-${cur.itemId}`, itemId: cur.itemId, projectId: 'P1', tourId: 'T1',
    tourName: '薛之谦“万兽之王”巡回演唱会', stationName: cur.stationName,
    name: `薛之谦“万兽之王”巡回演唱会- ${cur.stationName}`,
    city: '测试市', venue: '测试体育馆', venueAddr: '测试路1号',
    showTime: '2026.10.17-10.25', stationShowTime: cur.showTime,
    saleStatus: cur.saleStatus, status: cur.saleStatus,
    priceRange: '317-1717', purchaseLimit: '4', duration: '', saleTimeHints: [],
    fullData: true, source: 'test', updatedAt: new Date().toISOString(),
    sessions: Array.from({ length: sessions }, (_, i) => ({ id: 'p' + (i + 1), name: `场次${i + 1}`, inStock: true })),
    priceTiers: [], stations,
  };
}

// a. 首采
let cat = { items: [] };
let touched = mergeIntoCatalog(cat, makeProbeResult({ current: 'gy' }));
ok(cat.items.length === 3, `首采后条目数 3（当前站+2概要）: ${cat.items.length}`);
ok(cat.items.find((x) => x.itemId === 'gy')?.fullData === true, '当前站(gy) 全量');
ok(cat.items.find((x) => x.itemId === 'xm')?.fullData === false, '概要站(xm) 非全量');
ok(cat.items.find((x) => x.itemId === 'cd')?.fullData === false, '概要站(cd) 非全量');
ok(touched.length === 3, `touched 清单 3 项`);

// b. 补采概要站 xm → 升级全量；gy 保持全量
touched = mergeIntoCatalog(cat, makeProbeResult({ current: 'xm' }));
ok(cat.items.length === 3, `补采后不新增条目: ${cat.items.length}`);
ok(cat.items.find((x) => x.itemId === 'xm')?.fullData === true, 'xm 补采后升级为全量');
ok(cat.items.find((x) => x.itemId === 'xm')?.sessions?.length === 4, 'xm 场次已写入');
ok(cat.items.find((x) => x.itemId === 'gy')?.fullData === true, 'gy 不被降级（仍全量）');
ok(cat.items.find((x) => x.itemId === 'gy')?.sessions?.length === 4, 'gy 场次保留');
ok(cat.items.find((x) => x.itemId === 'cd')?.saleStatus === '缺货', 'cd 状态保持缺货');

// c. 重复采集 gy：去重
touched = mergeIntoCatalog(cat, makeProbeResult({ current: 'gy' }));
ok(cat.items.length === 3, `重复采集不产生重复条目: ${cat.items.length}`);
ok(cat.items.find((x) => x.itemId === 'gy')?.saleStatus === '预约', 'gy 状态刷新正确');

// d. stations 清单同步（同巡演所有条目共享最新分布）
const allSynced = cat.items.filter((x) => x.tourId === 'T1').every((x) => x.stations?.length === 3);
ok(allSynced, '同巡演条目的 stations 清单全部同步为 3 站');

// e. 旧格式数据兼容：带 tourId 的旧条目名称不被清空
const legacy = { items: [{ id: 'st-old', itemId: 'xm', tourId: 'T1', tourName: '旧巡演名', stationName: '厦门站', name: '旧名', fullData: true, saleStatus: '在售' }] };
mergeIntoCatalog(legacy, makeProbeResult({ current: 'gy' }));
ok(legacy.items.find((x) => x.itemId === 'xm')?.name === '旧名', 'old 条目 name 未被覆盖（fullData 保护）');

/* ==================== ③ 名称派生边界 ==================== */
console.log('\n=== ③ deriveTourName / deriveStationName ===');
ok(deriveStationName('贵阳·薛之谦“万兽之王”巡回演唱会- 贵阳站', '贵阳市') === '贵阳站', '站名：后缀形式');
ok(deriveStationName('某演出【上海站】', '上海市') === '上海站', '站名：无后缀时用城市兜底');
ok(deriveTourName('贵阳·薛之谦“万兽之王”巡回演唱会- 贵阳站', '贵阳站') === '薛之谦“万兽之王”巡回演唱会', '巡演名：去前缀城市+后缀站');
ok(deriveTourName('【贵阳】薛之谦“万兽之王”巡回演唱会- 贵阳站', '贵阳站') === '薛之谦“万兽之王”巡回演唱会', '巡演名：去【】前缀');
ok(deriveTourName('2026年世界举重锦标赛', '') === '2026年世界举重锦标赛', '巡演名：无站名时原样保留');

/* ==================== ④ 真实采集冒烟（--live） ==================== */
if (process.argv.includes('--live')) {
  console.log('\n=== ④ 真实采集冒烟（联网） ===');
  try {
    const item = await probeItem('1085142029424');
    ok(item.itemId === '1085142029424' && item.stations.length >= 1, `采集成功: ${item.stationName} / ${item.stations.length} 站 / ${item.sessions.length} 场次`);
  } catch (e) {
    ok(false, `采集失败: ${e.message}`);
  }
}

console.log(failed === 0 ? '\n🎉 全部通过' : `\n⚠️ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
