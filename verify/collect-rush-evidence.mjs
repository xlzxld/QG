#!/usr/bin/env node
/**
 * 真场复盘报告收集器（2026-10-08）：把 evidence/rush-<时间>/ 里的黑匣子数据汇总成报告
 * =====================================================================
 * 读什么：每个槽位的 events.jsonl（时间线）、netlog.jsonl（请求/响应）、
 *        bodies.jsonl（关键响应体原文——拒单理由在这）、截图清单；
 *        外加桥接的驱动日志尾巴和最近回传结果。
 * 出什么：<rush目录>/复盘报告.md + 控制台摘要（时间线、下单相关请求+响应体、
 *        各阶段耗时、保活记录、失败原因线索）。
 * 用法：node verify/collect-rush-evidence.mjs [--dir=<evidence/rush-xxx>]
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVROOT = path.join(ROOT, 'data', 'grab', 'evidence');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.match(/^--([^=]+)(?:=(.*))?$/)).filter(Boolean).map((m) => [m[1], m[2] ?? true]));

let dir = args.dir ? path.resolve(ROOT, args.dir) : null;
if (!dir) {
  const cands = fs.readdirSync(EVROOT).filter((d) => d.startsWith('rush-')).sort();
  if (!cands.length) { console.error('没有 rush-* 取证目录'); process.exit(1); }
  dir = path.join(EVROOT, cands[cands.length - 1]);
}
console.log('取证目录：', dir);

const readJsonl = (f) => {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
};
const fmt = (d) => {
  if (d == null) return '';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(dt.getMilliseconds()).padStart(3, '0');
};

const lines = [];
const P = (s = '') => { lines.push(s); console.log(s); };

P(`# 真场复盘报告（${path.basename(dir)}）`);
P('');
let anyOrderTraffic = false;

for (const slot of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort()) {
  const sd = path.join(dir, slot);
  const events = readJsonl(path.join(sd, 'events.jsonl'));
  const net = readJsonl(path.join(sd, 'netlog.jsonl'));
  const bodies = readJsonl(path.join(sd, 'bodies.jsonl'));
  const shots = fs.readdirSync(sd).filter((f) => f.endsWith('.jpg'));
  P(`## 槽位 ${slot}`);
  P(`- 事件 ${events.length} 条 · API 请求/响应 ${net.length} 条 · 关键响应体 ${bodies.length} 份 · 截图 ${shots.length} 张`);
  if (!events.length) { P('- （无事件——槽位可能被闸门拦下或没跑）'); continue; }

  // 时间线（关键事件）
  const KEY = /^(SLOT_START|CLOCK_T0|WARMUP|PREOPEN|HOT_ENTER|UNLOCK_SEEN|INTERNAL_FIRED|BUY_SEEN|BUY_RESULT|CONFIRM_TAB|SUBMIT_VIA|SUBMIT_REJECTED|SUBMIT_OUTCOME|OOS_TO_MONITOR|GIVE_UP|SCAN_BUY_SEEN|SCAN_FAIL)/;
  P('');
  P('| 时刻 | 距T0 | 事件 | 详情 |');
  P('|---|---|---|---|');
  for (const e of events.filter((e) => KEY.test(e.event))) {
    P(`| ${fmt(e.at)} | ${e.tRelT0 != null ? (e.tRelT0 >= 0 ? '+' : '') + e.tRelT0 + 'ms' : '—'} | ${e.event} | ${String(e.detail || '').slice(0, 120).replace(/\|/g, '/')} |`);
  }

  // 下单相关网络（buy.vmall.com / order）
  const orderNet = net.filter((n) => /buy\.vmall\.com|order|submit/i.test(n.u || ''));
  if (orderNet.length) {
    anyOrderTraffic = true;
    P('');
    P('### 下单相关请求');
    for (const n of orderNet.slice(-30)) {
      P(`- ${fmt(n.at)} ${n.req ? `${n.m || '?'} →` : `← ${n.st}`} ${(n.u || '').slice(0, 110)}${n.post ? `  body=${String(n.post).slice(0, 80)}` : ''}`);
    }
  }
  // 关键响应体（拒单理由）
  if (bodies.length) {
    P('');
    P('### 关键响应体（截选）');
    for (const b of bodies.slice(-12)) {
      P(`- ${fmt(b.at)} [${b.st || '?'}] ${(b.u || '').slice(0, 90)}：${String(b.b || '').slice(0, 220).replace(/\s+/g, ' ')}`);
    }
  }
  // 保活/登录线索（驱动 sessionPing 写进 events.jsonl 的 SESSION_PING 事件）
  const pings = events.filter((e) => e.event === 'SESSION_PING' || /保活/.test(String(e.detail)));
  if (pings.length) {
    P('');
    P('### 会话保活记录');
    for (const p of pings.slice(-20)) P(`- ${fmt(p.at)} ${p.detail || p.event}`);
  }
  P('');
  P(`### 其他线索：截图 ${shots.join('、') || '无'}；文本留档 ${fs.readdirSync(sd).filter((f) => f.endsWith('.txt')).join('、') || '无'}`);
  P('');
}

// 驱动日志尾巴 + 最近结果
try {
  const st = await (await fetch('http://127.0.0.1:3100/api/dispatch/status?platform=huawei')).json();
  P('## 驱动日志（最后 20 行）');
  P('```');
  (st.log || []).slice(-20).forEach((l) => P(l));
  P('```');
} catch { P('（桥接未响应，跳过驱动日志）'); }
try {
  const r = await (await fetch('http://127.0.0.1:3100/api/results/huawei?limit=6')).json();
  P('');
  P('## 最近回传结果');
  for (const x of (r.results || []).slice(-6)) {
    P(`- ${fmt(x.receivedAt || x.at)} ${x.outcome} ${x.resultCode || ''} ${String(x.message || '').slice(0, 100)}`);
  }
} catch { /* 忽略 */ }

const outFile = path.join(dir, '复盘报告.md');
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(`\n报告已写：${outFile}${anyOrderTraffic ? '' : '（注意：没抓到下单相关网络流量）'}`);
await new Promise((r) => setTimeout(r, 400));
process.exit(0);
