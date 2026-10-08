/**
 * 拦截器安装层（把 rules.mjs 的纯规则接到 CDP Fetch 域上）
 * =====================================================================
 * installInterception(cdp, cfg, log, hooks)：
 *   · 按 cfg.intercept 配置 Fetch.enable（Response 阶段，只列目标 URL）；
 *   · Fetch.requestPaused 事件里按规则改写/留证/放行；
 *   · 任何错误一律原样放行——绝不能因为拦截把页面弄卡或弄坏。
 *
 * 供两处使用：
 *   · cdp-rush.mjs（抢购驱动，改写生效）；
 *   · checkup-vmall.mjs（体检，observe 模式：只统计匹配，不改写）。
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATTERNS, MATCH, rewriteRushInfo } from './rules.mjs';

const GRAB_DIR = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'data', 'grab');
const SAMPLE_DIR = path.join(GRAB_DIR, 'evidence', 'queue-samples');

/** 组装本次要启用的 CDP URL 模式（配置 patterns 显式给出时优先，selftest 用） */
export function resolvePatterns(cfg) {
  const ic = (cfg && cfg.intercept) || {};
  if (!ic.enabled) return [];
  if (Array.isArray(ic.patterns) && ic.patterns.length) return ic.patterns.slice();
  const out = [];
  if (ic.rules?.rushInfo !== false) out.push(PATTERNS.rushInfo);
  if (ic.rules?.queueCapture !== false) out.push(...PATTERNS.queue);
  return out;
}

/**
 * 安装拦截。返回统计对象 { patterns, rewritten, passthrough, failures, samples }
 * 或 null（未启用/没有可用模式）。
 */
export async function installInterception(cdp, cfg, log, hooks = {}) {
  const ic = (cfg && cfg.intercept) || {};
  const patterns = resolvePatterns(cfg);
  if (!patterns.length) return null;

  const stat = { patterns, rewritten: 0, passthrough: 0, failures: 0, samples: [] };
  await cdp.send('Fetch.enable', {
    patterns: patterns.map((p) => ({ urlPattern: p, requestStage: 'Response' })),
  });
  log(`拦截已启用（${patterns.length} 条模式，leadMs=${ic.leadMs ?? 300}）`);

  cdp.on('Fetch.requestPaused', (p) => { handlePaused(p).catch(() => {}); });
  return stat;

  async function handlePaused(p) {
    const url = (p.request && p.request.url) || '';
    try {
      // R1：抢购信息提前解锁
      if (ic.rules?.rushInfo !== false && MATCH.rushInfo.test(url)) {
        const raw = await readBody(p);
        if (raw != null) {
          const out = hooks.observe ? null : rewriteRushInfo(raw, { leadMs: ic.leadMs ?? 300 });
          if (out != null) {
            await fulfillText(cdp, p, out, 'application/json; charset=utf-8');
            stat.rewritten++;
            if (stat.rewritten === 1) log(`R1 首次改写 queryRushbuyInfo（startTime 提前 ${ic.leadMs ?? 300}ms）`);
            hooks.onRewrite?.(url, stat.rewritten);
            return;
          }
        }
      }
      // R2：排队页/排队脚本落盘留证（原样放行）
      if (ic.rules?.queueCapture !== false && MATCH.queue.test(url) && stat.samples.length < 3) {
        const raw = await readBody(p);
        if (raw != null) {
          const saved = saveSample(url, p, raw);
          if (saved) {
            stat.samples.push(saved);
            log(`R2 排队页样本已留证：${saved.dir}`);
            hooks.onSample?.(saved);
          }
        }
      }
    } catch (e) {
      stat.failures++;
      log(`拦截处理出错（${e.message}），原样放行`, 'warn');
    }
    await pass(p);
    stat.passthrough++;
  }

  async function readBody(p) {
    if (p.responseStatusCode == null) return null; // 非响应阶段（不该发生，防御）
    const r = await cdp.send('Fetch.getResponseBody', { requestId: p.requestId });
    // ★ 字段名是 base64Encoded（不是 base64）——2026-10-07 自测踩坑
    return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
  }

  async function pass(p) {
    try {
      if (p.responseStatusCode == null) await cdp.send('Fetch.continueRequest', { requestId: p.requestId });
      else await cdp.send('Fetch.continueResponse', { requestId: p.requestId });
    } catch {
      // 会话可能已被导航打断：请求随旧会话一起消失，无需补救
    }
  }
}

async function fulfillText(cdp, p, text, contentType) {
  await cdp.send('Fetch.fulfillRequest', {
    requestId: p.requestId,
    responseCode: p.responseStatusCode || 200,
    responseHeaders: [
      { name: 'Content-Type', value: contentType },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    body: Buffer.from(text, 'utf8').toString('base64'),
  });
}

/** 排队页样本落盘（每会话最多 3 份，正文超过 1MB 截断） */
function saveSample(url, p, body) {
  try {
    if (!fs.existsSync(SAMPLE_DIR)) fs.mkdirSync(SAMPLE_DIR, { recursive: true });
    const dir = path.join(SAMPLE_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      capturedAt: new Date().toISOString(),
      url,
      status: p.responseStatusCode,
      responseHeaders: p.responseHeaders || null,
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'body.txt'), body.length > 1e6 ? body.slice(0, 1e6) + '\n<!--截断-->' : body, 'utf8');
    return { dir, url };
  } catch { return null; }
}
