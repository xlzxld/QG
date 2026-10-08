#!/usr/bin/env node
/**
 * 控制台「抢购行为」设置区冒烟验证（2026-10-08）
 * =====================================================================
 * 只读！打开控制台页面、读取各字段的加载值，不点任何保存按钮、不写配置。
 * 判据：面板各字段显示值 == 配置文件的对应值（即 renderSettings 与配置接线正确），
 *      且页面加载无 JS 异常。
 * 用途：改控制台设置区 / 配置文件字段后的回归检查。
 * 用法：node verify/verify-console-settings.mjs
 * =====================================================================
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CDP } from '../core/cdp-core.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BG = 'http://127.0.0.1:3100';
const PORT = 9679;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-console-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

try {
  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
      target = list[0] || null;
    } catch { /* 还没起来 */ }
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('Chrome 调试端口未就绪');

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
  });

  // 拿线上真实配置做期望值（与 renderSettings 同一套取值逻辑）
  const cfg = await (await fetch(`${BG}/api/config/huawei`)).json();
  const expect = {
    mode: cfg.mode || 'rush',
    early: String(cfg.earlyEnterSec ?? 90),
    poll: String(cfg.limits?.pollIntervalMs ?? 3000),
    pollHot: String(cfg.limits?.pollIntervalHotMs ?? 150),
    hotWindow: String(cfg.limits?.hotWindowMs ?? 10000),
    giveUp: String(cfg.limits?.giveUpAfterMs ?? 1800000),
    internalFire: String(cfg.limits?.internalFireMs ?? 50),
    fuse: String(cfg.limits?.fuseRefreshDelayMs ?? 1000),
    buyRetry: String(cfg.limits?.cdpBuyRetry ?? 3),
    lead: String(cfg.intercept?.leadMs ?? 300),
    trigInternal: cfg.triggerMode === 'internal',
    internalSubmit: cfg.internalSubmit !== false,
    intercept: !!(cfg.intercept && cfg.intercept.enabled),
    monitorOn: cfg.monitor?.enabled === true,
    monDense: String(cfg.monitor?.skuScanSecs ?? 10),
    monPoll: String(cfg.monitor?.pollSecs ?? 60),
    monMax: String(Math.round((cfg.monitor?.maxMs ?? 7200000) / 60000)),
  };

  await cdp.send('Page.navigate', { url: `${BG}/console-huawei` });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300);
    try {
      ready = await cdp.eval(`(() => { const el = document.getElementById('setInternalFire'); return !!(el && el.value !== ''); })()`);
    } catch { /* 加载中 */ }
  }
  if (!ready) console.log('⚠ 等 18 秒仍未读到字段值（配置可能没加载出来）');

  const snap = await cdp.eval(`(() => {
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : '(缺元素)'; };
    const c = (id) => { const el = document.getElementById(id); return el ? el.checked : '(缺元素)'; };
    return JSON.stringify({
      mode: v('setMode'), early: v('setEarly'), poll: v('setPoll'), pollHot: v('setPollHot'),
      hotWindow: v('setHotWindow'), giveUp: v('setGiveUp'),
      internalFire: v('setInternalFire'), fuse: v('setFuse'), buyRetry: v('setBuyRetry'), lead: v('setLead'),
      trigInternal: c('setTrigInternal'), internalSubmit: c('setInternalSubmit'),
      intercept: c('setIntercept'), monitorOn: c('setMonitorOn'),
      monDense: v('setMonDense'), monPoll: v('setMonPoll'), monMax: v('setMonMax'),
    });
  })()`);

  const got = JSON.parse(snap || '{}');
  let fail = 0;
  for (const [k, want] of Object.entries(expect)) {
    const ok = String(got[k]) === String(want);
    if (!ok) fail++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${k.padEnd(16)} 期望=${want}  实际=${got[k]}`);
  }
  if (pageErrors.length) {
    fail++;
    console.log('\n页面 JS 异常：');
    for (const e of pageErrors.slice(0, 5)) console.log('  ' + String(e).split('\n')[0]);
  } else {
    console.log('\n页面加载无 JS 异常');
  }
  console.log(fail ? `\n结果：${fail} 项不合格` : '\n结果：全部通过（只读检查，未写任何配置）');
  process.exitCode = fail ? 1 : 0;
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(600);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 临时目录 */ }
}
