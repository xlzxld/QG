/**
 * 抢购桥接服务（本地）
 * =====================================================================
 * 作用：让「独立抢购程序（油猴脚本）」与「配置文件 / 控制台」之间有一个
 *       稳定的通道。刻意做成极小的独立服务，不依赖旧系统（r8.0 那套）。
 *
 * 它做四件事：
 *   1. 读写配置文件   data/grab/<platform>.config.json
 *   2. 接收结果回传   data/grab/<platform>.results.jsonl（追加）
 *   3. 提供一个最小控制台页面：改参数 / 看结果
 *   4. 允许油猴脚本跨域读取（GM_xmlhttpRequest）
 *
 * 为什么需要它：
 *   浏览器里的油猴脚本不能直接读写本地磁盘文件，必须有一个本地 HTTP 端点。
 *   配置文件仍然是磁盘上的普通 JSON，人可以随时用记事本改。
 *
 * 启动：node core/grab-bridge.mjs
 * 默认端口 3100，只监听 127.0.0.1。
 * =====================================================================
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GRAB_DIR = path.join(ROOT, 'data', 'grab');
const PORT = Number(process.env.GRAB_BRIDGE_PORT || 3100);
const HOST = '127.0.0.1';

if (!fs.existsSync(GRAB_DIR)) fs.mkdirSync(GRAB_DIR, { recursive: true });

const PID_PATH = path.join(GRAB_DIR, 'bridge.pid');

/**
 * PID 文件：让「停止/重启服务」能精确找到本进程。
 *
 * 为什么不靠 netstat/taskkill 按端口找：
 *   1. 从 Node 里起外部进程在受限环境会直接失败（实测 spawnSync cmd.exe EBUSY），
 *      失败被吞掉就变成"停止失败却报成功"——最糟的情况（已经踩过）；
 *   2. PID 文件零依赖，process.kill 任何环境都能用。
 * netstat 那条路保留为兜底，专门对付"跑着的是没写 PID 文件的旧版服务"。
 */
function writePidFile() {
  try { fs.writeFileSync(PID_PATH, String(process.pid), 'utf8'); } catch { /* 写不了不影响服务本身 */ }
}
function removePidFile() {
  try {
    // 只删自己写的那个（防止把后来者的 PID 文件误删）
    if (fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_PATH);
  } catch { /* 忽略 */ }
}

const nowIso = () => new Date().toISOString();
const log = (...a) => {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w, '0');
  const us = Math.floor((process.hrtime()[1] % 1e6) / 1000);
  console.log(`[${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}${p(us, 3)}]`, ...a);
};

/* =====================================================================
 * 派发器（通用）：控制台发"派发/停止"指令，桥接按平台路由到平台自己的
 * 驱动脚本。平台怎么抢（专用窗口、真点击、槽位……）全在平台层脚本里，
 * 这里只认"平台名 → 驱动脚本 + 槽位文件"。新增平台注册一行即可。
 * ===================================================================== */
const MANIFEST_PATH = path.join(GRAB_DIR, 'manifest.json');

function loadManifest() {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    }
  } catch (e) {
    log(`⚠️ 读取 manifest.json 失败（${e.message}），回退到默认清单`);
  }
  return {
    version: '1.0.0',
    platforms: [
      {
        id: 'huawei',
        name: '华为商城',
        icon: '📱',
        badge: '官方版',
        desc: 'VMall 手机/平板/穿戴设备多槽位真点击秒杀',
        status: 'ready',
        entryUrl: '/console-huawei',
        driverScript: 'platforms/huawei/cdp-rush.mjs',
        slotsFile: 'data/grab/rush-slots.huawei.json',
      },
    ],
    tools: [
      { id: 'tasks', name: '任务排班', icon: '⏱️', entryUrl: '/tools/tasks' },
      { id: 'accounts', name: '槽位与账号', icon: '👤', entryUrl: '/tools/accounts' },
      { id: 'guide', name: '使用指引', icon: '📖', entryUrl: '/tools/guide' },
    ],
  };
}

function saveManifest(data) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

function getDrivers() {
  const mf = loadManifest();
  const map = {};
  for (const p of (mf.platforms || [])) {
    if (p.driverScript) {
      map[p.id] = {
        name: p.name,
        script: path.isAbsolute(p.driverScript) ? p.driverScript : path.join(ROOT, p.driverScript),
        slotsFile: p.slotsFile ? (path.isAbsolute(p.slotsFile) ? p.slotsFile : path.join(ROOT, p.slotsFile)) : null,
      };
    }
  }
  if (!map.huawei) {
    map.huawei = {
      name: '华为商城',
      script: path.join(ROOT, 'platforms', 'huawei', 'cdp-rush.mjs'),
      slotsFile: path.join(GRAB_DIR, 'rush-slots.huawei.json'),
    };
  }
  return map;
}

const DRIVERS = new Proxy({}, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined;
    return getDrivers()[prop];
  },
  has(target, prop) {
    return prop in getDrivers();
  },
});
const runningDrivers = new Map(); // platform -> { child, startedAt, log: [] }
const drvLastLog = new Map();     // platform -> 最近一次运行的日志（退出后仍可看）
const drvLastExit = new Map();    // platform -> { at, code }

function readSlots(platform) {
  const drv = DRIVERS[platform];
  if (!drv) return { slots: [] };
  try {
    return JSON.parse(fs.readFileSync(drv.slotsFile, 'utf8'));
  } catch {
    return { slots: [] };
  }
}

function writeSlots(platform, data) {
  const drv = DRIVERS[platform];
  if (!drv) throw new Error(`平台 ${platform} 没有注册驱动`);
  fs.writeFileSync(drv.slotsFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}

/* =====================================================================
 * 爬虫调度器
 * =====================================================================
 * 需求：每天自动跑一次，**时间随机**；同时支持手动触发。
 *
 * 设计：
 *   · 维护 data/grab/crawler-schedule.json，记录「今天是否已跑」「今天计划几点跑」
 *   · 每天首次检查时，在 [earliestHour, latestHour) 区间内随机选一个时刻
 *   · 每 CHECK_INTERVAL 检查一次，到点则触发；触发后当天不再自动触发
 *   · 若随机到的时刻已经过去（例如服务在中午才启动），则在
 *     「当前时间 ~ latestHour」之间重挑，避免启动瞬间就触发一次
 *   · 随机是为了避免固定时刻的规律性访问
 */
const SCHEDULE_PATH = path.join(GRAB_DIR, 'crawler-schedule.json');
const REGISTRY_PATH = path.join(GRAB_DIR, 'crawlers.json');
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟检查一次

/** 读爬虫注册表。新增平台只需改 data/grab/crawlers.json，不用动代码。 */
function loadRegistry() {
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return Array.isArray(r.crawlers) ? r.crawlers : [];
  } catch (e) {
    log(`⚠️ 爬虫注册表读取失败（${e.message}），回退到内置的华为爬虫`);
    return [
      {
        id: 1,
        name: '华为商城',
        platform: 'huawei',
        script: 'platforms/huawei/crawler-huawei.mjs',
        enabled: true,
        defaultArgs: [],
        schedule: true,
      },
    ];
  }
}

/** 按 id 或 platform 找爬虫 */
function findCrawler(key) {
  const list = loadRegistry();
  const s = String(key);
  return list.find((c) => String(c.id) === s) || list.find((c) => c.platform === s) || null;
}

/** 当前启用、且参与调度的爬虫 */
function scheduledCrawlers() {
  return loadRegistry().filter((c) => c.enabled !== false && c.schedule !== false);
}

/** 调度配置（可用环境变量覆盖） */
const SCHEDULE_CONF = {
  // 默认关闭自动调度：当前阶段一切数据都靠手动采集（启动器或控制台）。
  // 等抢购链路整体跑通后再把 CRAWLER_SCHEDULE 设为 on 打开。
  enabled: (process.env.CRAWLER_SCHEDULE || 'off') === 'on',
  platform: 'huawei',
  // 全天窗口：0 点 ~ 24 点之间随机挑一个时刻
  earliestHour: Number(process.env.CRAWLER_EARLIEST_HOUR ?? 0),
  latestHour: Number(process.env.CRAWLER_LATEST_HOUR ?? 24),
  timeoutMs: Number(process.env.CRAWLER_TIMEOUT_MS || 20 * 60 * 1000), // 单次最长 20 分钟
};

function loadSchedule() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveSchedule(s) {
  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

/** 本地日期字符串 YYYY-MM-DD */
function localDateKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 为今天挑一个随机时刻（若尚未挑过） */
function ensureTodayPlan(s) {
  const today = localDateKey();
  const { earliestHour, latestHour } = SCHEDULE_CONF;
  const windowSig = `${earliestHour}-${latestHour}`;

  // 已有计划且窗口没变 → 沿用
  if (s.planDate && s.plannedAt && s.windowSig === windowSig && s.lastAutoDate !== null) {
    // 当天已跑过就不再重挑
    if (s.lastAutoDate === today) return s;
    // 计划日期是今天或明天（跨天顺延）→ 沿用
    if (s.planDate === today || s.planDate > today) return s;
  }

  const now = new Date();

  // 先在整个窗口里随机挑
  let at = new Date(now);
  const span = Math.max(1, latestHour - earliestHour);
  at.setHours(earliestHour + Math.floor(Math.random() * span), Math.floor(Math.random() * 60), 0, 0);

  // 若挑到的时间已经过去（服务启动得晚），在当前时间与窗口末端之间重挑
  if (at.getTime() <= now.getTime()) {
    const remainMin = Math.floor(latestHour * 60 - (now.getHours() * 60 + now.getMinutes()));
    if (remainMin <= 5) {
      // 今天窗口已过，顺延到明天
      at = new Date(now);
      at.setDate(at.getDate() + 1);
      at.setHours(earliestHour + Math.floor(Math.random() * span), Math.floor(Math.random() * 60), 0, 0);
      s.planDate = localDateKey(at);
      s.plannedAt = at.toISOString();
      s.plannedLocal = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      s.windowSig = windowSig;
      saveSchedule(s);
      log(`爬虫计划已顺延到明天：${s.planDate} ${s.plannedLocal}`);
      return s;
    }
    at = new Date(now.getTime() + (5 + Math.floor(Math.random() * Math.max(1, remainMin - 5))) * 60 * 1000);
    at.setSeconds(0, 0);
    s.planDate = today;
  } else {
    s.planDate = today;
  }

  s.plannedAt = at.toISOString();
  s.plannedLocal = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  s.windowSig = windowSig;
  saveSchedule(s);
  log(
    `下次自动采集计划：${s.planDate} ${s.plannedLocal}` +
      `（随机安排，窗口 ${earliestHour}:00 ~ ${latestHour}:00）`,
  );
  return s;
}

let crawlerRunning = false;
let crawlerPid = null;
let crawlerStartedAt = null;
let lastCrawl = null;

/* =====================================================================
 * 运行状态自愈
 * =====================================================================
 * 踩过的坑：子进程若被外部终止（用户关窗口、服务重启带走、系统杀进程），
 * Node 侧的 'close' 事件**不一定**会触发，于是 crawlerRunning 永远停在 true，
 * 界面就一直显示"正在采集"，而实际早就没有进程了。
 *
 * 这里加一道活性校验：如果标记为运行中，但记录的 PID 已经不存在，
 * 就把状态复位并留下记录。
 */
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // 信号 0 = 只探测存在性，不真的发信号
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限（不该发生在同用户子进程上）
  }
}

function reconcileRunningState() {
  if (!crawlerRunning) return false;
  if (isPidAlive(crawlerPid)) return false;

  // 标记为运行中，但进程已不存在 → 复位
  log(`⚠️ 检测到爬虫进程（PID ${crawlerPid ?? '未知'}）已不存在，自动复位运行状态`);
  crawlerRunning = false;
  const prevPid = crawlerPid;
  crawlerPid = null;

  const s = loadSchedule();
  s.lastRunAt = s.lastRunAt || nowIso();
  s.lastRunExitCode = s.lastRunExitCode ?? -2;
  s.lastRunSummary = s.lastRunSummary || {
    ok: false,
    error: `爬虫进程（PID ${prevPid ?? '未知'}）中途消失，未收到退出事件`,
  };
  saveSchedule(s);
  return true;
}

/**
 * 运行爬虫（手动或自动都走这里）
 * @param trigger 'manual' | 'auto' | 'launcher'
 * @param crawler 注册表里的爬虫条目
 * @param extraArgs 追加参数
 */
function runCrawler(trigger, crawler, extraArgs = []) {
  return new Promise((resolve) => {
    // 先做一次活性校验，避免被"僵尸运行标记"永久挡住
    reconcileRunningState();

    if (crawlerRunning) {
      return resolve({
        ok: false,
        error: `已有一个爬虫实例在运行中${crawlerPid ? `（PID ${crawlerPid}）` : ''}`,
      });
    }
    if (!crawler) {
      return resolve({ ok: false, error: '未指定爬虫（检查 data/grab/crawlers.json）' });
    }

    const scriptPath = path.join(ROOT, crawler.script);
    if (!fs.existsSync(scriptPath)) {
      return resolve({ ok: false, error: `找不到爬虫脚本：${scriptPath}` });
    }

    const args = [scriptPath, ...(crawler.defaultArgs || []), ...extraArgs];

    crawlerRunning = true;
    crawlerStartedAt = nowIso();
    const startedAt = crawlerStartedAt;
    log(`▶ 启动爬虫 #${crawler.id} ${crawler.name}（触发方式：${trigger}）参数：${extraArgs.join(' ') || '(默认)'}`);

    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: ROOT,
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH:
            process.env.PLAYWRIGHT_BROWSERS_PATH ||
            path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // ★ Windows：bridge 自己可能是无控制台的 detached 进程，
        //   子进程不加这个标志就会弹出一个新的控制台黑窗口（用户可见）。
        windowsHide: true,
      });
      crawlerPid = child.pid ?? null;
    } catch (e) {
      crawlerRunning = false;
      crawlerPid = null;
      log(`✘ 爬虫启动失败（同步）：${e.message}`);
      return resolve({ ok: false, error: `spawn 失败: ${e.message}` });
    }

    let out = '';
    let err = '';
    const MAX_LOG = 40000;
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > MAX_LOG) out = out.slice(-MAX_LOG);
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > MAX_LOG) err = err.slice(-MAX_LOG);
    });

    const killer = setTimeout(() => {
      log(`⏱ 爬虫超时（${SCHEDULE_CONF.timeoutMs / 60000} 分钟），终止`);
      child.kill('SIGKILL');
    }, SCHEDULE_CONF.timeoutMs);

    const settle = (payload) => {
      clearTimeout(killer);
      crawlerRunning = false; // ★ 无论成功失败都必须复位，否则调度器永久卡死
      crawlerPid = null;
      crawlerStartedAt = null;
      resolve(payload);
    };

    child.on('close', (code) => {
      const m = out.match(/QP_CRAWL_RESULT (\{.*\})/);
      let summary = null;
      if (m) {
        try {
          summary = JSON.parse(m[1]);
        } catch {
          /* ignore */
        }
      }

      lastCrawl = {
        trigger,
        crawlerId: crawler.id,
        platform: crawler.platform,
        startedAt,
        finishedAt: nowIso(),
        exitCode: code,
        summary,
        stdoutTail: out.split('\n').slice(-40).join('\n'),
        stderrTail: err.split('\n').slice(-20).join('\n'),
      };

      const s = loadSchedule();
      s.lastRunAt = lastCrawl.finishedAt;
      s.lastRunTrigger = trigger;
      s.lastRunCrawlerId = crawler.id;
      s.lastRunExitCode = code;
      s.lastRunSummary = summary;

      // 按爬虫分别标记「今天已经跑过」。
      //
      // 两条规则：
      //   1. 手动跑过也算 —— 需求：手动启动过的爬虫当天不再自动启动
      //   2. 失败也算 —— 避免爬虫出问题时调度器一天重试几十次，把平台访问量放大
      //      （只记录"今天跑过"，不因失败而反复重试；要重试就手动再点一次）
      s.lastAutoByCrawler = s.lastAutoByCrawler || {};
      s.lastAutoByCrawler[crawler.id] = localDateKey();
      s.lastAutoDate = localDateKey(); // 兼容旧字段（控制台提示用）
      saveSchedule(s);

      log(
        code === 0
          ? `✔ 爬虫 #${crawler.id} 完成（${trigger}）：${summary ? JSON.stringify(summary.counts) : '无摘要'}`
          : `✘ 爬虫 #${crawler.id} 失败（${trigger}）退出码 ${code}`,
      );
      settle({
        ok: code === 0,
        crawlerId: crawler.id,
        platform: crawler.platform,
        exitCode: code,
        summary,
        stdoutTail: lastCrawl.stdoutTail,
        stderrTail: lastCrawl.stderrTail,
      });
    });

    child.on('error', (e) => {
      log(`✘ 爬虫启动失败（异步）：${e.message}`);
      const s = loadSchedule();
      s.lastRunAt = nowIso();
      s.lastRunTrigger = trigger;
      s.lastRunCrawlerId = crawler.id;
      s.lastRunExitCode = -1;
      s.lastRunSummary = { ok: false, error: `spawn 失败: ${e.message}` };
      saveSchedule(s);
      settle({
        ok: false,
        error: `spawn 失败: ${e.message}`,
        hint: '若为 EPERM，通常是运行环境的进程/管道限制，需要在允许创建子进程的环境下启动本服务',
      });
    });
  });
}

/** 调度循环：对所有参与调度的爬虫，各自每天触发一次 */
async function scheduleTick() {
  if (!SCHEDULE_CONF.enabled) return;
  if (crawlerRunning) return;

  const list = scheduledCrawlers();
  if (!list.length) return;

  const s0 = ensureTodayPlan(loadSchedule());
  const planned = s0.plannedAt ? new Date(s0.plannedAt) : null;
  if (!planned || Number.isNaN(planned.getTime())) return;

  // 未到计划时刻，或计划日期不是今天（跨天顺延的计划不误触发）
  if (Date.now() < planned.getTime() || s0.planDate !== localDateKey()) return;

  const today = localDateKey();
  const s = loadSchedule();
  s.lastAutoByCrawler = s.lastAutoByCrawler || {};

  for (const c of list) {
    if (s.lastAutoByCrawler[c.id] === today) {
      log(`爬虫 #${c.id} ${c.name} 今天已自动跑过，跳过`);
      continue;
    }
    if (crawlerRunning) break;
    log(`⏰ 到达计划时刻 ${s0.plannedLocal}，自动执行爬虫 #${c.id} ${c.name}`);
    await runCrawler('auto', c);
    // 重新读，runCrawler 内部写过盘
    const s2 = loadSchedule();
    s2.lastAutoByCrawler = s2.lastAutoByCrawler || {};
    Object.assign(s, s2);
  }
}

if (SCHEDULE_CONF.enabled) {
  const s0 = ensureTodayPlan(loadSchedule());
  const list = scheduledCrawlers();
  const today = localDateKey();
  const done = list.filter((c) => (s0.lastAutoByCrawler || {})[c.id] === today);
  if (done.length && done.length === list.length) {
    log(`今日 ${done.length} 个爬虫均已自动跑过，不再触发`);
  } else if (list.length) {
    log(`参与每日调度的爬虫：${list.map((c) => `#${c.id} ${c.name}`).join('、')}`);
  } else {
    log('⚠️ 注册表里没有启用调度的爬虫（检查 data/grab/crawlers.json 的 schedule 字段）');
  }
  setInterval(() => {
    scheduleTick().catch((e) => log(`调度检查出错：${e.message}`));
  }, CHECK_INTERVAL_MS);
}


/* =====================================================================
 * 改版体检（每日自动 + 手动触发）
 * =====================================================================
 * 抢购脚本押注在 vmall 的页面结构/接口形状/内部函数上，华为一改版就静默
 * 失效。checkup-vmall.mjs 逐项对照真实环境验证这些押注，DRIFT 即给出
 * "改哪里"提示。体检是只读探测（打开/复用槽位窗口看页面、打官方免鉴权
 * 接口），不点击不下单，每天自动跑一次比"开抢日才发现改版"强得多。
 * 报告落盘 data/grab/checkup-report.json（最新）+ checkup-history.jsonl（历史）。
 */
const CHECKUP_DRIVERS = {
  huawei: path.join(ROOT, 'platforms', 'huawei', 'checkup-vmall.mjs'),
};
const CHECKUP_SCHEDULE_PATH = path.join(GRAB_DIR, 'checkup-schedule.json');
const CHECKUP_REPORT_PATH = path.join(GRAB_DIR, 'checkup-report.json');
const CHECKUP_CONF = {
  // 默认开启：体检不开网络风暴、不碰交易，成本远低于改版静默失效的代价
  enabled: (process.env.CHECKUP_SCHEDULE || 'on') === 'on',
  earliestHour: Number(process.env.CHECKUP_EARLIEST_HOUR ?? 8),
  latestHour: Number(process.env.CHECKUP_LATEST_HOUR ?? 22),
  timeoutMs: Number(process.env.CHECKUP_TIMEOUT_MS || 3 * 60 * 1000),
};
let checkupRunning = false;
let checkupPid = null;
let checkupStartedAt = null;
let checkupLastLog = [];

function loadCheckupSchedule() {
  try { return JSON.parse(fs.readFileSync(CHECKUP_SCHEDULE_PATH, 'utf8')); } catch { return {}; }
}
function saveCheckupSchedule(s) {
  fs.writeFileSync(CHECKUP_SCHEDULE_PATH, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

/** 为今天挑一个随机体检时刻（窗口 8~22 点；到点没跑顺延重挑） */
function ensureCheckupPlan(s) {
  const today = localDateKey();
  if (s.planDate === today && s.plannedAt) return s;
  const now = new Date();
  const span = Math.max(1, CHECKUP_CONF.latestHour - CHECKUP_CONF.earliestHour);
  const at = new Date(now);
  at.setHours(CHECKUP_CONF.earliestHour + Math.floor(Math.random() * span), Math.floor(Math.random() * 60), 0, 0);
  if (at.getTime() <= now.getTime()) {
    // 今天窗口已过/已过时刻：明天再跑
    at.setDate(at.getDate() + 1);
    s.planDate = localDateKey(at);
  } else {
    s.planDate = today;
  }
  s.plannedAt = at.toISOString();
  s.plannedLocal = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  saveCheckupSchedule(s);
  log(`下次自动体检计划：${s.planDate} ${s.plannedLocal}`);
  return s;
}

/** 跑一次体检（手动/自动都走这里）。结果读 checkup-report.json（脚本自己落盘）。 */
function runCheckup(trigger, platform = 'huawei') {
  return new Promise((resolve) => {
    if (checkupRunning) return resolve({ ok: false, error: `体检已在运行中（PID ${checkupPid}）` });
    const script = CHECKUP_DRIVERS[platform];
    if (!script || !fs.existsSync(script)) return resolve({ ok: false, error: `平台 ${platform} 没有体检脚本` });

    checkupRunning = true;
    checkupStartedAt = nowIso();
    checkupLastLog = [];
    const push = (line) => {
      checkupLastLog.push(line);
      if (checkupLastLog.length > 120) checkupLastLog.splice(0, checkupLastLog.length - 120);
    };
    log(`▶ 启动改版体检（${trigger}）`);
    let child;
    try {
      child = spawn(process.execPath, [script], {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, // ★ 不弹黑窗口（同爬虫 spawn）
      });
      checkupPid = child.pid ?? null;
    } catch (e) {
      checkupRunning = false; checkupPid = null;
      return resolve({ ok: false, error: `spawn 失败: ${e.message}` });
    }
    const killer = setTimeout(() => {
      log(`⏱ 体检超时（${CHECKUP_CONF.timeoutMs / 1000}s），终止`);
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }, CHECKUP_CONF.timeoutMs);
    const settle = (payload) => {
      clearTimeout(killer);
      checkupRunning = false;
      checkupPid = null;
      checkupStartedAt = null;
      resolve(payload);
    };
    child.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(push));
    child.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => push(`[stderr] ${l}`)));
    child.on('error', (e) => settle({ ok: false, error: `启动失败: ${e.message}` }));
    child.on('close', (code) => {
      let report = null;
      try { report = JSON.parse(fs.readFileSync(CHECKUP_REPORT_PATH, 'utf8')); } catch { /* 报告缺失 */ }
      const s = loadCheckupSchedule();
      s.lastRunAt = nowIso();
      s.lastRunTrigger = trigger;
      s.lastRunExitCode = code;
      s.lastSummary = report ? report.summary : null;
      saveCheckupSchedule(s);
      log(code === 0
        ? `✔ 体检完成：PASS ${report?.summary?.pass ?? '?'} / DRIFT ${report?.summary?.drift ?? '?'} / SKIP ${report?.summary?.skip ?? '?'} / FAIL ${report?.summary?.fail ?? '?'}`
        : `✘ 体检退出码 ${code}（存在 DRIFT/FAIL，看 checkup-report.json 的 fix 提示）`);
      settle({ ok: code === 0, exitCode: code, summary: report ? report.summary : null, report });
    });
  });
}

if (CHECKUP_CONF.enabled) {
  ensureCheckupPlan(loadCheckupSchedule());
  setInterval(() => {
    try {
      if (checkupRunning) return;
      const s = ensureCheckupPlan(loadCheckupSchedule());
      if (!s.plannedAt || s.planDate !== localDateKey()) return;
      if (Date.now() < new Date(s.plannedAt).getTime()) return;
      if (s.lastAutoDate === localDateKey()) return;
      log(`⏰ 到达计划时刻 ${s.plannedLocal}，自动体检`);
      s.lastAutoDate = localDateKey();
      saveCheckupSchedule(s);
      runCheckup('auto').catch((e) => log(`自动体检出错：${e.message}`));
    } catch (e) {
      log(`体检调度出错：${e.message}`);
    }
  }, CHECK_INTERVAL_MS);
}


/** 只允许字母数字下划线短横线，防止路径穿越 */
function safePlatform(p) {
  return typeof p === 'string' && /^[a-z0-9_-]{1,32}$/i.test(p) ? p.toLowerCase() : null;
}

const configPath = (platform) => path.join(GRAB_DIR, `${platform}.config.json`);
const resultsPath = (platform) => path.join(GRAB_DIR, `${platform}.results.jsonl`);

function readConfig(platform) {
  const p = configPath(platform);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON: ${p} — ${e.message}`);
  }
}

function writeConfig(platform, obj) {
  const p = configPath(platform);
  // 保留 _说明 之类的注释字段：以磁盘上现有内容为底，用新值覆盖
  let base = {};
  if (fs.existsSync(p)) {
    try {
      base = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      base = {};
    }
  }
  const merged = deepMerge(base, obj);
  fs.writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function appendResult(platform, record) {
  fs.appendFileSync(resultsPath(platform), JSON.stringify(record) + '\n', 'utf8');
}

function readResults(platform, limit = 50) {
  const p = resultsPath(platform);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { _parseError: true, raw: l.slice(0, 200) };
    }
  });
}

function listPlatforms() {
  return fs
    .readdirSync(GRAB_DIR)
    .filter((f) => f.endsWith('.config.json'))
    .map((f) => f.replace('.config.json', ''));
}

/* ============================ HTTP ============================ */

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const seg = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    // GET / 或 /workbench → 工作台外壳页面
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/workbench' || url.pathname === '/workbench.html')) {
      let html;
      try {
        html = readWorkbenchHtml();
      } catch (e) {
        return send(res, 500, `工作台页面读取失败：${WORKBENCH_PATH} — ${e.message}`, 'text/plain; charset=utf-8');
      }
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    // GET /console-huawei 或 /grab-console.html → 华为商城独立控制台（可独立访问，也可供 iframe 嵌入）
    if (req.method === 'GET' && (url.pathname === '/console-huawei' || url.pathname === '/grab-console.html')) {
      let html;
      try {
        html = readConsoleHtml();
      } catch (e) {
        return send(res, 500, `控制台页面读取失败：${CONSOLE_PATH} — ${e.message}`, 'text/plain; charset=utf-8');
      }
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    // GET /console-showstart → 秀动专属页
    if (req.method === 'GET' && url.pathname === '/console-showstart') {
      try {
        return send(res, 200, readHtmlCached(SHOWSTART_PATH, '秀动专属页'), 'text/html; charset=utf-8');
      } catch (e) {
        return send(res, 500, `秀动页面读取失败：${e.message}`, 'text/plain; charset=utf-8');
      }
    }

    // GET /console-apple → 苹果专属页
    if (req.method === 'GET' && url.pathname === '/console-apple') {
      try {
        return send(res, 200, readHtmlCached(APPLE_PATH, '苹果专属页'), 'text/html; charset=utf-8');
      } catch (e) {
        return send(res, 500, `苹果页面读取失败：${e.message}`, 'text/plain; charset=utf-8');
      }
    }

    // GET /tools/tasks → 任务排班页
    if (req.method === 'GET' && url.pathname === '/tools/tasks') {
      try {
        return send(res, 200, readHtmlCached(TASKS_PATH, '任务排班页'), 'text/html; charset=utf-8');
      } catch (e) {
        return send(res, 500, `任务排班页读取失败：${e.message}`, 'text/plain; charset=utf-8');
      }
    }

    // GET /tools/accounts → 槽位账号页
    if (req.method === 'GET' && url.pathname === '/tools/accounts') {
      try {
        return send(res, 200, readHtmlCached(ACCOUNTS_PATH, '槽位账号页'), 'text/html; charset=utf-8');
      } catch (e) {
        return send(res, 500, `槽位账号页读取失败：${e.message}`, 'text/plain; charset=utf-8');
      }
    }

    // GET /tools/guide → 使用指引页
    if (req.method === 'GET' && url.pathname === '/tools/guide') {
      try {
        return send(res, 200, readHtmlCached(GUIDE_PATH, '使用指引页'), 'text/html; charset=utf-8');
      } catch (e) {
        return send(res, 500, `使用指引页读取失败：${e.message}`, 'text/plain; charset=utf-8');
      }
    }

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, at: nowIso(), platforms: listPlatforms(), grabDir: GRAB_DIR });
    }

    // POST /api/shutdown   优雅停止（给启动器的「停止/重启服务」用）
    // 为什么要有：桥接进程常驻后台，改完 grab-bridge.mjs 必须重启才生效，
    // 而手动找进程 PID 对用户太麻烦。这里先应答再退出，避免响应发不出去。
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      log('收到停止请求，桥接服务即将退出（本次改动要重启后才生效）');
      send(res, 200, { ok: true, message: '桥接服务正在退出' });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    // GET /api/config/:platform
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'config' && seg[2]) {
      const platform = safePlatform(seg[2]);
      if (!platform) return send(res, 400, { error: '非法 platform 名' });
      const cfg = readConfig(platform);
      if (!cfg) return send(res, 404, { error: `未找到配置: ${configPath(platform)}` });
      log(`读取配置 ${platform}`);
      return send(res, 200, cfg);
    }

    // POST /api/config/:platform   （局部合并写入）
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'config' && seg[2] && seg[3] !== 'sku-select') {
      const platform = safePlatform(seg[2]);
      if (!platform) return send(res, 400, { error: '非法 platform 名' });
      const patch = await readBody(req);
      const merged = writeConfig(platform, patch);
      log(`写入配置 ${platform}`);
      return send(res, 200, { ok: true, config: merged });
    }

    // POST /api/results/:platform  → 结果回传
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'results' && seg[2]) {
      const platform = safePlatform(seg[2]);
      if (!platform) return send(res, 400, { error: '非法 platform 名' });
      const body = await readBody(req);
      const record = {
        receivedAt: nowIso(),
        platform,
        ...body,
      };
      appendResult(platform, record);

      // 关键字段单独打日志，便于盯屏
      const outcome = record.outcome || '(未提供 outcome)';
      const orderNo = record.platformOrderNo || record.orderNo || '(无订单号)';
      log(`结果回传 ${platform}  outcome=${outcome}  平台订单号=${orderNo}`);
      return send(res, 200, { ok: true, receivedAt: record.receivedAt });
    }

    // GET /api/results/:platform?limit=50
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'results' && seg[2]) {
      const platform = safePlatform(seg[2]);
      if (!platform) return send(res, 400, { error: '非法 platform 名' });
      const limit = Math.min(Number(url.searchParams.get('limit') || 50) || 50, 500);
      return send(res, 200, { platform, results: readResults(platform, limit) });
    }

    /* ---------------- 登录保活守护：状态/启停/测试 ----------------
     * 2026-10-09 重构：状态/停止不再只认 PID 文件——
     * ① 守护自己有控制端口（:3101，GET /ping 自报），状态以它为准，PID 文件只作兜底；
     * ② 「停止」= 端口叫停 + PID 文件兜底 + 测试轮（一次性进程）一并停 + 停完复核；
     * ③ 「立即测一轮」在守护活着时改为让守护加跑一轮（不再另起并行进程、日志不打架）。
     * 背景：旧版「停止」管不到测试轮，停完它还在写「已续命」；PID 文件丢失时守护会“看不见、停不掉”。
     */
    const KA_PID = path.join(GRAB_DIR, 'keepalive.pid');
    const KA_TEST_PID = path.join(GRAB_DIR, 'keepalive-test.pid'); // 测试轮（一次性进程）的 PID
    const KA_LOG = path.join(GRAB_DIR, 'keepalive.log');
    const KA_CTL = `http://127.0.0.1:${Number(process.env.KEEPALIVE_CTL_PORT || 3101)}`;
    const kaPid = (f) => { try { const pid = Number(fs.readFileSync(f, 'utf8').trim()); if (!pid) return null; process.kill(pid, 0); return pid; } catch { return null; } };
    const kaAlive = () => kaPid(KA_PID);
    const kaTestAlive = () => kaPid(KA_TEST_PID);
    const kaProbeCtl = async () => { try { const r = await fetch(KA_CTL + '/ping', { signal: AbortSignal.timeout(900) }); const j = await r.json(); return j && j.ok ? j : null; } catch { return null; } };
    const kaFileLog = (msg) => { try { fs.appendFileSync(KA_LOG, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] 【控制台】${msg}\n`); } catch { /* 忽略 */ } };
    if (req.method === 'GET' && url.pathname === '/api/keepalive/status') {
      const viaCtl = await kaProbeCtl();
      const filePid = kaAlive();
      const testPid = kaTestAlive();
      const pid = (viaCtl && viaCtl.pid) || filePid || null;
      let tail = [];
      try { tail = fs.readFileSync(KA_LOG, 'utf8').split(String.fromCharCode(10)).filter(Boolean).slice(-8); } catch { /* 无日志 */ }
      return send(res, 200, {
        running: !!pid, pid,
        via: viaCtl ? 'control-port' : (filePid ? 'pid-file' : null),
        testRunning: !!testPid, testPid: testPid || null,
        lastRoundAt: (viaCtl && viaCtl.lastRoundAt) || null,
        nextRoundAt: (viaCtl && viaCtl.nextRoundAt) || null,
        log: tail,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/keepalive/start') {
      const viaCtl = await kaProbeCtl();
      const pid = (viaCtl && viaCtl.pid) || kaAlive();
      if (pid) return send(res, 200, { ok: true, note: '已在运行（pid ' + pid + '）' });
      try { const c = spawn(process.execPath, [path.join(__dirname, 'keepalive-daemon.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); } catch (e) { return send(res, 500, { error: e.message }); }
      log('保活守护已手动启动'); kaFileLog('点了「启动」');
      return send(res, 200, { ok: true, note: '保活守护已启动（2 秒后自动刷新看状态）' });
    }
    if (req.method === 'POST' && url.pathname === '/api/keepalive/stop') {
      const parts = [];
      // ① 优先走控制端口：让守护自己体面退出
      let stoppedDaemon = false;
      try { const r = await fetch(KA_CTL + '/stop', { method: 'POST', signal: AbortSignal.timeout(1200) }); if (r.ok) { stoppedDaemon = true; parts.push('守护进程'); } } catch { /* 走兜底 */ }
      // ② 兜底：PID 文件里还有活着的就杀掉（旧版守护 / 降级模式）
      if (!stoppedDaemon) {
        const p = kaAlive();
        if (p) { try { process.kill(p); stoppedDaemon = true; parts.push('守护进程'); } catch (e) { parts.push('守护进程（停不掉：' + e.message + '）'); } }
      }
      // ③ 测试轮一并停——它是一次性进程，以前不受「停止」管辖（就是“停了还在续命”的来源）
      const tp = kaTestAlive();
      if (tp) { try { process.kill(tp); parts.push('测试轮'); } catch { /* 忽略 */ } }
      // ④ 复核 + 清理残留 PID 文件
      await new Promise((r) => setTimeout(r, 250));
      const stillCtl = await kaProbeCtl();
      if (!kaAlive()) { try { fs.unlinkSync(KA_PID); } catch { /* 忽略 */ } }
      if (!kaTestAlive()) { try { fs.unlinkSync(KA_TEST_PID); } catch { /* 忽略 */ } }
      const note = parts.length
        ? `已停止：${parts.join('、')}${stillCtl ? '；⚠️ 复核时仍有守护在应答，请再点一次停止' : ''}`
        : (stillCtl ? '⚠️ 有守护在应答但不在册（异常），请再点一次或重启服务' : '本来就没有续命进程在跑');
      log('保活停止操作：' + note); kaFileLog('点了「停止」：' + note);
      return send(res, 200, { ok: true, note });
    }
    if (req.method === 'POST' && url.pathname === '/api/keepalive/test') {
      // ① 守护活着 → 让它自己加跑一轮（不另起进程，日志里带【手动测试】标记）
      const viaCtl = await kaProbeCtl();
      if (viaCtl) {
        const j = await fetch(KA_CTL + '/round', { method: 'POST', signal: AbortSignal.timeout(1200) }).then((x) => x.json()).catch(() => null);
        if (j && j.ok) { kaFileLog('点了「立即测一轮」'); return send(res, 200, { ok: true, note: j.note || '已加跑一轮测试，看下方日志' }); }
      }
      // ② 守护不在 → 发起一次性测试轮（PID 记到 keepalive-test.pid，刚发起就被叫停也有得杀）
      const running = kaTestAlive();
      if (running) return send(res, 200, { ok: true, note: '测试轮已经在跑（pid ' + running + '），稍等看日志' });
      try {
        const c = spawn(process.execPath, [path.join(__dirname, 'keepalive-daemon.mjs'), '--once'], { detached: true, stdio: 'ignore', windowsHide: true });
        c.unref();
        try { fs.writeFileSync(KA_TEST_PID, String(c.pid)); } catch { /* 忽略 */ }
        c.on('exit', () => { try { if (fs.readFileSync(KA_TEST_PID, 'utf8').trim() === String(c.pid)) fs.unlinkSync(KA_TEST_PID); } catch { /* 忽略 */ } });
      } catch (e) { return send(res, 500, { error: e.message }); }
      kaFileLog('点了「立即测一轮」（一次性进程）');
      return send(res, 200, { ok: true, note: '测试轮已发起（一次性进程，跑完自动退），2 秒后刷新看日志' });
    }

    // GET /api/platforms
    if (req.method === 'GET' && url.pathname === '/api/platforms') {
      return send(res, 200, { platforms: listPlatforms() });
    }

    // GET /api/manifest  → 读取应用清单
    if (req.method === 'GET' && url.pathname === '/api/manifest') {
      return send(res, 200, loadManifest());
    }

    // POST /api/manifest → 登记新平台或保存清单
    if (req.method === 'POST' && url.pathname === '/api/manifest') {
      const body = await readBody(req);
      const current = loadManifest();
      if (body.action === 'add_platform' && body.platform) {
        const p = body.platform;
        if (!p.id || !p.name) return send(res, 400, { error: '缺少 id 或 name' });
        const exists = (current.platforms || []).some((x) => x.id === p.id);
        if (exists) return send(res, 400, { error: `平台 ID ${p.id} 已存在` });
        current.platforms.push({
          id: p.id,
          name: p.name,
          icon: p.icon || '📦',
          badge: p.badge || '新增',
          desc: p.desc || '',
          status: 'added',
          entryUrl: p.entryUrl || `/console-${p.id}`,
          driverScript: p.driverScript || `platforms/${p.id}/${p.id}-rush.mjs`,
          slotsFile: p.slotsFile || `data/grab/rush-slots.${p.id}.json`,
          configFile: p.configFile || `data/grab/${p.id}.config.json`,
        });
        saveManifest(current);
        log(`已登记新平台：${p.name} (${p.id})`);
        return send(res, 200, { ok: true, manifest: current });
      }
      if (body.manifest) {
        saveManifest(body.manifest);
        return send(res, 200, { ok: true, manifest: body.manifest });
      }
      return send(res, 400, { error: '未知的 manifest 操作' });
    }

    /* ---------------- 爬虫：注册表 / 状态 / 触发 / 结果 ---------------- */

    // GET /api/crawler/list     爬虫注册表（启动器与控制台共用）
    if (req.method === 'GET' && url.pathname === '/api/crawler/list') {
      const list = loadRegistry().filter((c) => c.enabled !== false);
      return send(res, 200, {
        crawlers: list.map((c) => ({
          id: c.id,
          name: c.name,
          platform: c.platform,
          script: c.script,
          desc: c.desc || '',
          schedule: c.schedule !== false,
          presetArgs: c.presetArgs || [],
        })),
      });
    }

    // GET /api/crawler/menu     给 launch.bat 用的纯文本菜单
    //
    // 输出格式（启动器直接 type 出来显示，不解析）：
    //   HEADER <文本>
    //   ITEM   <编号>|<名称>|<说明>
    //   ...
    //   END
    if (req.method === 'GET' && url.pathname === '/api/crawler/menu') {
      const list = loadRegistry().filter((c) => c.enabled !== false);
      const lines = [];
      lines.push('HEADER 可用的爬虫');
      if (!list.length) {
        lines.push('ITEM   0|（注册表里没有启用的爬虫）|检查 data/grab/crawlers.json');
      }
      for (const c of list) {
        const tag = c.schedule !== false ? '每日自动' : '仅手动';
        lines.push(`ITEM   ${c.id}|${c.name}|${tag}${c.desc ? ' · ' + c.desc : ''}`);
      }
      lines.push('END');
      return send(res, 200, lines.join('\r\n') + '\r\n', 'text/plain; charset=utf-8');
    }

    // GET /api/crawler/presets/:id   某个爬虫的快捷预设（给启动器做二级菜单）
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'crawler' && seg[2] === 'presets' && seg[3]) {
      const c = findCrawler(seg[3]);
      if (!c) return send(res, 404, { error: `未找到爬虫 ${seg[3]}` });
      const presets = c.presetArgs || [{ key: '1', label: '默认运行', args: [] }];
      const lines = [`HEADER ${c.name} · 选择运行方式`];
      for (const pr of presets) lines.push(`ITEM   ${pr.key}|${pr.label}|`);
      lines.push('END');
      return send(res, 200, lines.join('\r\n') + '\r\n', 'text/plain; charset=utf-8');
    }

    // GET /api/crawler/status
    if (req.method === 'GET' && url.pathname === '/api/crawler/status') {
      reconcileRunningState(); // 每次查询都顺带纠正僵尸运行标记
      const s = loadSchedule();
      const runningSec = crawlerRunning && crawlerStartedAt
        ? Math.round((Date.now() - new Date(crawlerStartedAt).getTime()) / 1000)
        : null;
      return send(res, 200, {
        scheduleEnabled: SCHEDULE_CONF.enabled,
        window: { earliestHour: SCHEDULE_CONF.earliestHour, latestHour: SCHEDULE_CONF.latestHour },
        running: crawlerRunning,
        runningPid: crawlerPid,
        runningSec,
        runningStartedAt: crawlerStartedAt,
        today: localDateKey(),
        plannedLocal: s.plannedLocal || null,
        plannedAt: s.plannedAt || null,
        planDate: s.planDate || null,
        ranToday: s.lastAutoDate === localDateKey(),
        lastAutoByCrawler: s.lastAutoByCrawler || {},
        lastRunAt: s.lastRunAt || null,
        lastRunTrigger: s.lastRunTrigger || null,
        lastRunCrawlerId: s.lastRunCrawlerId ?? null,
        lastRunExitCode: s.lastRunExitCode ?? null,
        lastRunSummary: s.lastRunSummary || null,
        lastCrawlTail: lastCrawl ? lastCrawl.stdoutTail : null,
        crawlers: loadRegistry().filter((c) => c.enabled !== false).map((c) => ({
          id: c.id,
          name: c.name,
          platform: c.platform,
          schedule: c.schedule !== false,
        })),
      });
    }

    // POST /api/crawler/run     立即跑一次
    //   body: { id?: number|string, platform?: string, ...flags }
    if (req.method === 'POST' && url.pathname === '/api/crawler/run') {
      const body = (await readBody(req).catch(() => ({}))) || {};

      // 不指定就取第一个启用的爬虫
      let crawler = null;
      if (body.id != null) crawler = findCrawler(body.id);
      else if (body.platform) crawler = findCrawler(body.platform);
      else crawler = loadRegistry().filter((c) => c.enabled !== false)[0] || null;

      if (!crawler) {
        return send(res, 404, { error: '未找到指定爬虫，请检查 data/grab/crawlers.json' });
      }

      // ── 白名单硬闸门（2026-10-07）：only 必须精确命中「商品列表」里的商品 ──
      // 控制台下拉栏的 value 与爬虫「爬虫视角 id」同一算法，精确匹配必然命中；
      // 命不中只可能是：商品已被删除、页面没刷新还带着旧选项、或手拼了一个不存在的 id。
      // 这时候绝不能放行——爬到爬虫里的「子串兜底」会静默撞上别的商品
      // （实测："HUAWEI Mate 90" 是 "HUAWEI Mate 90 Pro" 的子串，选前者会去采后者）。
      // 匹配失败 = 拒绝，不兜底（与派发接口的槽位闸门同一哲学）。
      if (body.only) {
        const key = String(body.only).trim();
        const cfg = readConfig(crawler.platform) || {};
        const list = Array.isArray(cfg.products) ? cfg.products : [];
        const pidOfUrl = (u) => (String(u || '').match(/prdId=(\d{6,})/) || [])[1] || null;
        const hit = list.find((p) => (p && (String(p.id || '').trim() === key || (pidOfUrl(p.url) != null && pidOfUrl(p.url) === key))));
        if (!hit) {
          return send(res, 400, {
            error: `「${key}」不在商品列表里（可能刚被删除）。已拒绝采集——请到「商品与 SKU」页确认，或刷新控制台页面。`,
          });
        }
        if (hit.enabled === false) {
          return send(res, 400, {
            error: `「${key}」已停用（该商品是 disabled），不采集。要采先到「商品与 SKU」页启用它。`,
          });
        }
      }

      // 预设参数
      let extra = [];
      if (body.presetKey) {
        const pr = (crawler.presetArgs || []).find((x) => String(x.key) === String(body.presetKey));
        if (pr) extra.push(...(pr.args || []));
      }
      if (body.headed) extra.push('--headed');
      if (body.only) extra.push(`--only=${String(body.only)}`);

      const result = await runCrawler('manual', crawler, extra);
      return send(res, result.ok ? 200 : 500, result);
    }

    // GET /api/crawler/catalog?platform=huawei
    if (req.method === 'GET' && url.pathname === '/api/crawler/catalog') {
      const platform = safePlatform(url.searchParams.get('platform') || 'huawei');
      if (!platform) return send(res, 400, { error: '非法 platform 名' });
      const p = path.join(GRAB_DIR, `${platform}.catalog.json`);
      if (!fs.existsSync(p)) return send(res, 404, { error: '尚未采集过，请先点「采集一次」' });
      try {
        return send(res, 200, JSON.parse(fs.readFileSync(p, 'utf8')));
      } catch (e) {
        return send(res, 500, { error: `目录文件解析失败: ${e.message}` });
      }
    }

    /* ---------------- SKU 选择：面板勾选后写回配置 ---------------- */

    // POST /api/config/:platform/products
    //   body: { products: [...] }
    //   作用：整份替换 products 数组（添加 / 删除 / 改条件都走这里）
    //
    // 为什么不用 POST /api/config 的局部合并：products 是数组，
    // deepMerge 遇到数组直接整体替换，虽然结果对，
    // 但顶层若出现 products 以外的同名字段会被顺手合并进去，留脏数据。
    // 显式接口语义清楚：只有这里能改 products。
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'config' && seg[2] && seg[3] === 'products') {
      const platform = safePlatform(seg[2]);
      if (!platform) return send(res, 400, { error: '非法 platform 名' });
      const body = await readBody(req);
      if (!Array.isArray(body.products)) return send(res, 400, { error: 'body.products 必须是数组' });

      const cfg = readConfig(platform) || {};
      cfg.products = body.products;
      fs.writeFileSync(configPath(platform), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      log(`写入配置 ${platform}（products 共 ${body.products.length} 项）`);
      return send(res, 200, { ok: true, config: cfg });
    }

// POST /api/config/:platform/sku-select
    //   body: { productUrl: string, skuIds: string[] }
    //   作用：把面板上勾选的 SKU 编号写回该商品的 skuIds
    //
    // ⚠ 这里不能用普通 POST /api/config 的局部合并：products 是**数组**，
    //   deepMerge 遇到数组会整个替换 —— 只传一个商品就会把其它商品抹掉。
    //   而且顶层若没有这个 key，合并还会把它写到顶层去，商品本身没变。
    //   所以这一路必须「读整份 → 改一项 → 整份写回」。
    //
    // 字段名用通用的 skuIds（不是华为的 sbomCodes）—— 加别的平台时不用换名字。
    // 兼容：请求里给 sbomCodes 也认；写入时统一成 skuIds，顺手清掉旧的 sbomCodes。
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'config' && seg[3] === 'sku-select') {
      const platform = safePlatform(seg[2]);
      if (!platform) return send(res, 400, { error: '非法 platform 名' });
      const body = await readBody(req);

      const cfg = readConfig(platform);
      if (!cfg) return send(res, 404, { error: `未找到配置: ${configPath(platform)}` });
      if (!Array.isArray(cfg.products)) return send(res, 400, { error: '配置里没有 products 数组' });

      const raw = Array.isArray(body.skuIds) ? body.skuIds : Array.isArray(body.sbomCodes) ? body.sbomCodes : [];
      const codes = raw.map(String).filter(Boolean);
      const idx = cfg.products.findIndex((p) => p && p.url === body.productUrl);
      if (idx < 0) return send(res, 404, { error: '配置里找不到这个 URL 对应的商品' });

      // 整份写回：只替换目标商品的 skuIds，其余原样保留
      const products = cfg.products.map((p, i) => {
        if (i !== idx) return p;
        const next = { ...p, skuIds: codes };
        delete next.sbomCodes; // 迁移：不再保留旧字段名，避免两个字段并存
        return next;
      });
      cfg.products = products;
      fs.writeFileSync(configPath(platform), JSON.stringify(cfg, null, 2) + '\n', 'utf8');

      log(`SKU 选择已保存：${products[idx].id || '(未命名)'} → ${codes.length ? codes.join(',') : '（全部）'}`);
      return send(res, 200, { ok: true, productIndex: idx, productId: products[idx].id, skuIds: codes, config: cfg });
    }

    // GET /api/crawler/sku-options?platform=huawei&url=...
    //   给面板用：把某商品的全部 SKU 整理成"规格维度 + 可勾选行"的形状
    if (req.method === 'GET' && url.pathname === '/api/crawler/sku-options') {
      const platform = safePlatform(url.searchParams.get('platform') || 'huawei');
      if (!platform) return send(res, 400, { error: '非法 platform 名' });
      const p = path.join(GRAB_DIR, `${platform}.catalog.json`);
      if (!fs.existsSync(p)) return send(res, 404, { error: '尚未采集过，请先点「采集一次」' });

      let cat;
      try {
        cat = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        return send(res, 500, { error: `目录解析失败: ${e.message}` });
      }

      const wantUrl = url.searchParams.get('url');
      const prod =
        (wantUrl ? (cat.products || []).find((x) => x.url === wantUrl) : null) ||
        (cat.products || [])[0];
      if (!prod) return send(res, 404, { error: 'catalog 里没有这个商品' });

      return send(res, 200, {
        generatedAt: cat.generatedAt,
        product: {
          prdId: prod.prdId,
          url: prod.url,
          name: prod.name,
          briefName: prod.briefName,
          brandName: prod.brandName,
          limitedQuantity: prod.limitedQuantity,
          specDimensions: prod.specDimensions || [],
          serverNow: prod.serverNow || null,
          nextSale: prod.nextSale || null,
        },
        skus: (prod.skus || []).map((s) => ({
          // ★ 统一字段（跨平台）：控制台只认这组
          skuId: s.skuId ?? s.sbomCode ?? null,
          label: s.label,
          attrs: s.attrs || {},
          price: s.price,
          statusText: s.statusText ?? s.buyableText ?? null,
          buyable: s.buyable ?? s.buyableNow ?? null,
          sessionState: s.sessionState ?? null,
          saleStartAt: s.saleStartAt ?? s.rushBuy?.startTime ?? null,
          saleStartsInMs: s.rushBuy?.startsInMs ?? null,
          limitPerUser: s.limitPerUser ?? s.rushBuy?.limitNum ?? s.limitedQuantity ?? null,
          stockQty: s.stockQty ?? s.inventoryQty ?? null,
          stockCapped: s.stockCapped ?? s.inventoryCapped ?? false,
          // 平台原始字段（排查用）
          platformRaw: {
            sbomCode: s.sbomCode,
            buttonMode: s.buttonMode,
            isRushBuySku: s.isRushBuySku,
          },
        })),
        selected: prod.configuredSkuIds || prod.configuredSbomCodes || [],
      });
    }

    /* ---------------- 派发器（通用，按平台路由） ----------------
     * 控制台只发通用指令；每个平台"怎么抢"（专用窗口、真点击、槽位……）
     * 全都在平台自己的驱动脚本里。新增平台 = 在 DRIVERS 注册一行。
     */

    // GET /api/dispatch/status?platform=x
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'dispatch' && seg[2] === 'status') {
      const platform = safePlatform(url.searchParams.get('platform') || 'huawei');
      const drv = DRIVERS[platform];
      if (!drv) return send(res, 404, { error: `平台 ${platform} 没有注册驱动` });
      const run = runningDrivers.get(platform) || null;
      return send(res, 200, {
        platform,
        driverName: drv.name,
        running: !!run,
        startedAt: run?.startedAt || null,
        lastExit: drvLastExit.get(platform) || null,
        log: run ? run.log.slice(-30) : drvLastLog.get(platform)?.slice(-30) || [],
        slots: readSlots(platform),
      });
    }

    // POST /api/dispatch/launch  {platform}   派发：启动平台驱动（打开全部槽位窗口）
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'dispatch' && seg[2] === 'launch') {
      const body = await readBody(req);
      const platform = safePlatform(body.platform || 'huawei');
      const drv = DRIVERS[platform];
      if (!drv) return send(res, 400, { error: `平台 ${platform} 没有注册驱动` });
      if (runningDrivers.has(platform)) {
      return send(res, 409, { error: `平台 ${platform} 的驱动已在运行（${runningDrivers.get(platform).startedAt}）` });
      }
      // 派发前置闸门：槽位的 prdId/sbomCode 必须落在商品列表（huawei.config.json
      // 的 products[]）里、且规格已勾选，否则驱动只会开窗又白跑一场。
      // 这里先把不合格的槽位算出来告诉用户，驱动那边还有第二道同样的闸。
      if (drv.slotsFile) {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(GRAB_DIR, `${platform}.config.json`), 'utf8'));
          const sf = JSON.parse(fs.readFileSync(drv.slotsFile, 'utf8'));
          const pidOf = (p) => String(p.prdId ?? (p.url || '').match(/prdId=(\d+)/)?.[1] ?? '');
          const list = Array.isArray(cfg.products) ? cfg.products : [];
          const blocked = [];
          for (const s of (sf.slots || [])) {
            if (!s || !s.id || !s.prdId || !s.sbomCode || !s.port) continue;
            const p = list.find((x) => pidOf(x) === String(s.prdId));
            if (!p) { blocked.push(`${s.id}：商品 prdId=${s.prdId} 不在商品列表`); continue; }
            if (p.enabled === false) { blocked.push(`${s.id}：商品「${p.id || s.prdId}」已停用`); continue; }
            const want = Array.isArray(p.skuIds) ? p.skuIds.map(String).filter(Boolean) : [];
            if (want.length && !want.includes(String(s.sbomCode))) blocked.push(`${s.id}：规格 ${s.sbomCode} 未在商品列表里勾选`);
          }
          if (blocked.length) {
            return send(res, 400, {
              error: `这些槽位不在商品列表里，不会被操作：${blocked.join('；')}。请先在「商品与 SKU」页补上，或删掉对应槽位。`,
              blocked,
            });
          }
        } catch (e) {
          return send(res, 400, { error: `商品列表校验失败，已阻止派发：${e.message}` });
        }
      }
      const child = spawn(process.execPath, [drv.script], {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true, // ★ 不弹黑窗口（同爬虫 spawn）
      });
      const entry = { child, startedAt: nowIso(), log: [] };
      runningDrivers.set(platform, entry);
      const push = (line) => {
        entry.log.push(line);
        if (entry.log.length > 200) entry.log.splice(0, entry.log.length - 200);
        drvLastLog.set(platform, entry.log);
      };
      push(`[桥接] 已派发 ${drv.name} 驱动（pid ${child.pid}）`);
      child.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(push));
      child.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => push(`[stderr] ${l}`)));
      child.on('exit', (code) => {
        push(`[桥接] 驱动退出，code=${code}`);
        drvLastExit.set(platform, { at: nowIso(), code });
        if (runningDrivers.get(platform) === entry) runningDrivers.delete(platform);
      });
      log(`派发 ${platform} 驱动（pid ${child.pid}）`);
      return send(res, 200, { ok: true, pid: child.pid, startedAt: entry.startedAt });
    }

    // POST /api/dispatch/stop  {platform}   停驱动（已开的窗口保留，不抢交易）
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'dispatch' && seg[2] === 'stop') {
      const body = await readBody(req);
      const platform = safePlatform(body.platform || 'huawei');
      const run = runningDrivers.get(platform);
      if (!run) return send(res, 200, { ok: true, note: '驱动本就没在跑' });
      run.child.kill();
      runningDrivers.delete(platform);
      log(`已停止 ${platform} 驱动`);
      return send(res, 200, { ok: true });
    }

    // GET /api/dispatch/slots?platform=x   读槽位配置
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'dispatch' && seg[2] === 'slots') {
      const platform = safePlatform(url.searchParams.get('platform') || 'huawei');
      if (!DRIVERS[platform]) return send(res, 404, { error: `平台 ${platform} 没有注册驱动` });
      return send(res, 200, readSlots(platform));
    }

    // POST /api/dispatch/slots  {platform, slots:[...]}   写槽位配置
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'dispatch' && seg[2] === 'slots') {
      const body = await readBody(req);
      const platform = safePlatform(body.platform || 'huawei');
      if (!DRIVERS[platform]) return send(res, 400, { error: `平台 ${platform} 没有注册驱动` });
      const slots = Array.isArray(body.slots) ? body.slots : [];
      for (const s of slots) {
        if (!s.id || !s.prdId || !s.sbomCode) {
          return send(res, 400, { error: '槽位缺少 id / prdId / sbomCode' });
        }
        s.port = Number(s.port) || 0;
      }
      const ports = slots.map((s) => s.port);
      if (new Set(ports).size !== ports.length) {
        return send(res, 400, { error: '各槽位的 port 不能重复' });
      }
      const ids = slots.map((s) => s.id);
      if (new Set(ids).size !== ids.length) {
        return send(res, 400, { error: '槽位 id 不能重复' });
      }
      // ── 换绑即重置（2026-10-07）──
      // 槽位更换商品/规格后，跟着旧绑定走的派生状态必须清掉，否则：
      //   · 体检报告还挂着旧商品的绿灯（误导"这个槽位已体检过"）；
      //   · 控制台「最近结果」显示旧商品的结果（由控制台按绑定过滤）。
      // 这里只作废「当前有效」的体检报告（checkup-report.json）——完整历史在
      // checkup-history.jsonl 里，不丢证据。窗口里的旧页面不用管：驱动起飞时
      // 本来就强制归位到绑定页并清掉残标签（cdp-rush.mjs 的 onRightSku 检查）。
      // 注意：同样覆盖「删了又加回来（同 id、新绑定）」——报告只要配不上当前
      // 绑定就作废。没有报告文件 = 没什么可作废，静默跳过。
      const prevSlots = readSlots(platform).slots || [];
      const rebinds = [];
      const invalidateReportIfStale = (s) => {
        try {
          const rep = JSON.parse(fs.readFileSync(CHECKUP_REPORT_PATH, 'utf8'));
          if (String(rep.slot) !== String(s.id)) return false;
          if (String(rep.prdId) === String(s.prdId) && String(rep.sbomCode) === String(s.sbomCode)) return false;
          fs.unlinkSync(CHECKUP_REPORT_PATH);
          return true;
        } catch { return false; } // 文件不存在/解析失败 = 无可作废
      };
      for (const s of slots) {
        const was = prevSlots.find((x) => x && String(x.id) === String(s.id));
        const changed = !!was && (String(was.prdId) !== String(s.prdId) || String(was.sbomCode) !== String(s.sbomCode));
        const invalidated = invalidateReportIfStale(s);
        if (changed || invalidated) {
          rebinds.push({
            id: s.id,
            from: was ? { prdId: String(was.prdId), sbomCode: String(was.sbomCode) } : null,
            to: { prdId: String(s.prdId), sbomCode: String(s.sbomCode) },
            invalidated: invalidated ? ['checkupReport'] : [],
          });
        }
      }
      const data = writeSlots(platform, { ...readSlots(platform), slots });
      log(`写入槽位 ${platform}（${slots.length} 个）${rebinds.length ? `，换绑重置：${rebinds.map((r) => r.id + (r.invalidated.length ? '（体检报告已作废）' : '')).join('、')}` : ''}`);
      return send(res, 200, { ok: true, slots: data.slots, rebinds });
    }

    /* ---------------- 改版体检 ---------------- */

    // GET /api/checkup/:platform/status   体检状态 + 最新报告
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'checkup' && seg[3] === 'status') {
      const platform = safePlatform(seg[2] || 'huawei');
      if (!platform || !CHECKUP_DRIVERS[platform]) return send(res, 404, { error: `平台 ${platform} 没有体检` });
      const s = loadCheckupSchedule();
      let report = null;
      try { report = JSON.parse(fs.readFileSync(CHECKUP_REPORT_PATH, 'utf8')); } catch { /* 从未跑过 */ }
      return send(res, 200, {
        platform,
        running: checkupRunning,
        startedAt: checkupStartedAt,
        scheduleEnabled: CHECKUP_CONF.enabled,
        plannedLocal: s.plannedLocal || null,
        planDate: s.planDate || null,
        lastAutoDate: s.lastAutoDate || null,
        lastRunAt: s.lastRunAt || null,
        lastRunTrigger: s.lastRunTrigger || null,
        lastRunExitCode: s.lastRunExitCode ?? null,
        lastSummary: s.lastSummary || null,
        log: checkupLastLog.slice(-40),
        report,
      });
    }

    // POST /api/checkup/:platform/run   立即体检一次
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'checkup' && seg[3] === 'run') {
      const body = await readBody(req);
      const platform = safePlatform(body.platform || seg[2] || 'huawei');
      if (!platform || !CHECKUP_DRIVERS[platform]) return send(res, 400, { error: `平台 ${platform} 没有体检` });
      runCheckup('manual', platform).catch((e) => log(`手动体检出错：${e.message}`));
      // 体检要 20~60s，立即应答，控制台轮询 status 看进展
      return send(res, 200, { ok: true, started: true, note: '体检已启动，轮询 /api/checkup/' + platform + '/status 看结果' });
    }

    return send(res, 404, { error: 'not found', path: url.pathname });
  } catch (e) {
    log(`错误: ${e.message}`);
    return send(res, 500, { error: e.message });
  }
});

/* 独立保活守护：桥接启动时自动拉起（驱动停了也续命；PID 文件防重复） */
try {
  const ka = spawn(process.execPath, [path.join(__dirname, 'keepalive-daemon.mjs')], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  ka.unref();
} catch (e) { log('保活守护拉起失败：' + e.message); }

server.listen(PORT, HOST, () => {
  // 写 PID 文件：让「停止/重启服务」能精确找到本进程（零依赖，process.kill 即可）
  writePidFile();
  console.log('='.repeat(62));
  console.log('  抢购桥接服务已启动');
  console.log(`  PID    : ${process.pid}`);
  console.log(`  控制台 : http://${HOST}:${PORT}/`);
  console.log(`  配置目录: ${GRAB_DIR}`);
  console.log(`  健康检查: http://${HOST}:${PORT}/health`);
  console.log('='.repeat(62));
  const ps = listPlatforms();
  console.log(ps.length ? `已有配置: ${ps.join(', ')}` : '尚未发现配置文件');
});

/** 退出时清掉 PID 文件（否则下次"停止服务"会拿旧 PID 去杀别人） */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(sig, () => { removePidFile(); process.exit(0); }); } catch { /* 平台不支持该信号 */ }
}
process.on('exit', removePidFile);

/* ============================ 控制台页面 ============================ */

/* ============================ 控制台页面 ============================
 * 控制台是独立文件 web/platforms/grab-console.html。
 * 拆出来单独放：那个文件有 900 多行，塞在 .mjs 的模板字符串里既难读又难改。
 *
 * 按 mtime 判断要不要重新读 —— 手动改完 HTML 刷新浏览器就能看到，
 * 不用重启服务。这是踩过的坑：原来是无条件缓存，改了页面却没变化，
 * 白排查半天。
 */
const CONSOLE_PATH = path.join(ROOT, 'web', 'platforms', 'grab-console.html');
const WORKBENCH_PATH = path.join(ROOT, 'web', 'workbench.html');
const SHOWSTART_PATH = path.join(ROOT, 'web', 'platforms', 'console-showstart.html');
const APPLE_PATH = path.join(ROOT, 'web', 'platforms', 'console-apple.html');
const TASKS_PATH = path.join(ROOT, 'web', 'tools', 'tool-tasks.html');
const ACCOUNTS_PATH = path.join(ROOT, 'web', 'tools', 'tool-accounts.html');
const GUIDE_PATH = path.join(ROOT, 'web', 'tools', 'tool-guide.html');

const fileCaches = new Map();

function readHtmlCached(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  const st = fs.statSync(filePath);
  const cached = fileCaches.get(filePath);
  if (!cached || cached.mtimeMs !== st.mtimeMs) {
    const html = fs.readFileSync(filePath, 'utf8');
    fileCaches.set(filePath, { mtimeMs: st.mtimeMs, html });
    if (label) log(`${label}已加载（${(st.size / 1024).toFixed(1)} KB）`);
    return html;
  }
  return cached.html;
}

function readConsoleHtml() {
  return readHtmlCached(CONSOLE_PATH, '华为控制台');
}

function readWorkbenchHtml() {
  return readHtmlCached(WORKBENCH_PATH, '工作台外壳');
}
