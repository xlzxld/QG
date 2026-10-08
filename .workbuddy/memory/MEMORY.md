# 项目长期记忆 · 稀缺名额与稀缺商品抢购平台

## 用户定的硬规则（必须遵守）

### 1. 商品列表是唯一的操作白名单（2026-10-07）

**不在商品列表里的商品，脚本一律不操作**——不开窗口、不加载页面、不点击、
不插页面元素、不发请求（读控制台列表那次只读请求除外）、不写缓存、不体检。
用户手动打开的别的商品页同样完全不动。

- 「商品列表」= 控制台「商品与 SKU」页那份，落盘 `data/grab/<平台>.config.json` 的 `products[]`
- **列表从控制台读**（`GET <桥接>/api/config/<平台>`），不拿本地缓存当权威
- 判定按 prdId，不按标题关键字
- `skuIds` 留空 = 全部规格；非空 = 只认勾选过的
- 闸门位置：桥接派发接口 / `cdp-rush.mjs` 起飞预检+runSlot 开头 / `checkup-vmall.mjs` C0 /
  油猴三层（启动闸 + 配置复核 + SPA 切页哨兵）

### 2. 登录态看浏览器凭据，不看页面文案（2026-10-07）

**判据：`sid` / `hwid_cas_sid` @ `.id1.cloud.huawei.com`**（华为账号 SSO 会话 Cookie）。
未登录完全不存在，已登录两者都在（len=84）。实现：`cdp-core.mjs` 的 `readLoginState()`，
驱动 + 体检共用；油猴脚本用 `GM_cookie`。

页面文案两个方向都会误判（页头水合期短暂显示"请登录"；真未登录时又可能不显示）。
辅助信号只认"登录已过期/请重新登录"这类明确措辞（60 秒保鲜期），
**不收 `200916` / "用户未登录"**（匿名小请求在已登录页面上也返回它）。

### 3. 换绑即重置（2026-10-07）

**槽位换商品/规格 = 一个事件，必须触发重置**；不采用"运行后锁死只能删"：
槽位 id 绑着登录资产（`chrome-profile-rush/<id>` 登录态），锁死=每场删建=重登；
「生成槽位」复用老槽位是主设计。真正的防误改 = 换绑确认弹窗。

- 服务端：`POST /api/dispatch/slots` 对比旧→新绑定（**含同 id 删了又加回**）→ 作废配不上的
  `checkup-report.json`（检查历史在 `checkup-history.jsonl`，不丢）+ 响应带 `rebinds` 清单
- 控制台：保存/派发前弹换绑确认（列 从→到 + `[此槽位有运行历史]`）；保存后 toast 重置提示；
  「最近结果」对不上当前绑定的旧结果不显示（显示 —）
- 窗口旧页面不用清：驱动起飞本来就会导航归位 + 清残标签（`cdp-rush.mjs` onRightSku）
- ⚠️ **换绑自测必须零副作用**（只弹确认框再取消）。不要在生产槽位上做"临时换绑"——
  控制台轮询会把 1 秒的瞬时值缓存，之后一次保存就写进正式配置（2026-10-07：34026→34031→34026）

## 项目结构（2026-10-08 深度重组 · 已入 git）

- 布局：`core/`（桥接/启动器/保活/定时器/CDP 底座）｜`platforms/huawei/`（驱动/采集/体检/api/油猴/intercept/recon/实验脚本）；
  `platforms/showstart/`、`apple/` 占位｜`web/`（workbench + platforms 控制台 + tools 工具页）｜`tools/` 运维小工具
  ｜`verify/`（活跃工具在根、history 冻结、tmp）｜`docs/`｜`data/grab/`｜`tests/`｜归档不入库
- git：远程 `https://github.com/xlzxld/QG.git`（代理 127.0.0.1:7897）；**仓库内 core.autocrlf=false**；
  锚点：tag `baseline-pre-restructure` / 重组 `ebe8e4a` / 回归修复 `693ed86` / 移动端大更新 `6590126`
- URL 约定：`/` = 工作台外壳；控制台 = `/console-huawei` 等专属页（**验证脚本打开页面别再用 `/`**）；
  移动端中枢 = `http://localhost:3120`（`启动-手机中枢.bat`）
- 挪文件规则：同深度不动、深度 +1 的引用补一层（本次 112 项重命名即按此推）
- ★ 2026-10-09 拉入移动端大更新（`6590126`，58 文件 +10625）：新增 `platforms/app/agent/`（AutoJs6 手机
  Agent）、`core/device-hub.mjs`（设备中枢 :3120，一键连接/ADB 注入兜底/游标事件流）、`web/hub-console.html`、
  `platforms/damai/`（观演人档案 + 演出探针）、`tools/mobile/`（bundle-agent / prepare-device）、
  `core/run-drill.mjs` + `一键演练.command`；华为槽位重绑三账号 acc1/acc2/acc3（端口 9401-9403）；
  npm scripts 改版（hub / drill / agent:build / device:prepare / huawei:slots-check）；
  旧依赖清退（hono/pg/zod/tsx 系列），新增 china-division；文档旧稿入 `docs/archive/`
- 本机槽位登录档案 `data/grab/chrome-profile-rush/` 目前只有 `acc1`/`acc2`（无 acc3）——
  本机跑三槽位前先 `npm run huawei:slots-check` 补登录

## 技术约定

- **vmall 是 Next.js 单页应用**：站内跳转不重载文档 → 老脚本判定结果会一直沿用。
  守卫必须监听 `pushState/replaceState/popstate` + 轮询兜底；比对"页面身份"用
  启动时的 prdId 基准，不能只问"当前是否在允许集合内"。
- **下单动作必须通过页面自身代码发起**（可信点击 / 内部函数），不构造、不重放请求。
  读判断用的只读接口（校时、队列信息、列表）不算越界。
- **油猴脚本 `$` 是 getElementById 包装，传纯 id**（写 `$('#x')` 会让整段脚本静默死掉）。
- 抢购配置：`dryRun` 默认必须谨慎；改完检查 `data/grab/rush-slots.huawei.json` 的槽位。
- 桥接服务（`core/grab-bridge.mjs`）改动后**必须重启**才生效——它不会热加载。
  （重启姿势：**让用户点「重启服务.bat」**——沙箱起的进程活不过命令边界/会话结束；
  会话内救急可用「后台任务」方式撑住，收尾仍要用户侧接管。2026-10-07 再证。）
- **spawn 子进程一律带 `windowsHide: true`**（2026-10-07，实测取证）：用户环境的 bridge
  是无控制台 detached 进程，不给子进程加这个标志时会弹 Windows Terminal 黑窗
  （实测抓到 `CASCADIA_HOSTING_WINDOW_CLASS`，随采集进程出现/消失）。已改 4 处：
  grab-bridge.mjs ×3（爬虫/体检/派发）+ grab-launcher.mjs ×1（启动 bridge）。
- **`--only` 匹配 = 精确优先、子串兜底**（`pickByOnly`，2026-10-07）：商品名互为子串时会误伤
  （"HUAWEI Mate 90" ⊂ "HUAWEI Mate 90 Pro"，实测一次采了 2 个）。控制台下拉栏 value 必须用
  「爬虫视角 id」（`id || URL里prdId || product_N`）与该语义对齐；显示名优先用 CATALOG 的 name。
  ★ 2026-10-07 再修：桥接 `/api/crawler/run` 对 `only` 做**精确硬闸门**（命不中/已停用 → 400 拒采，
  不给子串兜底机会——"已删商品"曾子串撞上同名兄弟然后静默采错目标）；子串兜底只留给命令行直跑，
  且命中时打显眼日志（crawler-huawei.mjs）。**控制台任何写商品列表的入口后必须 `renderOnlyPicker()`**
  （当年漏在删除流程，已补齐 4 处：删除/商品设置/添加/原始JSON——下拉栏残留=能选中=能操作，属白名单泄漏）。
- **控制台采集范围 = 下拉栏**（`renderOnlyPicker()`，grab-console.html）：loadConfig /
  refreshCatalog 时刷新并保留选中值。验证脚本 `verify/history/verify-only-picker.mjs`。
- **服务常驻与"窗口弹不弹"类验证必须借用户环境**（2026-10-07 实证）：助手沙箱里我启动的进程
  活不过命令结束、沙箱进程树 spawn 的子进程不弹窗口（无法复现对照组）、schtasks/wmic 在黑名单。
  → 这类验证的姿势：用户点 bat / 点按钮，我在旁采样（`verify/sample_windows.py`）。
- **常规控制台操作用户自己点界面即可**（加删商品/勾规格/填开售时间/采集/派发），别揽成必经
  助手的事；助手的价值在代码行为层——用户报"配置类"需求时先分辨：界面能做的引导他自己点，
  界面解决不了的（如 2026-10-07 现货挂 saleAt 会提前出手 → 必须加 T0 出手闸门）才动代码。
- **挪动含 let/const 使用的代码块时，声明必须一起挪到首个使用之前**（2026-10-08 血案）：
  19:50 把预开块上移修 placement，`let preOpenedConfirm` 声明留在下方热循环区 → 定时场景
  （提前 >65s 派发）走到预开块即 TDZ ReferenceError，整槽崩溃（已修：声明上移 576 行）。
  此类问题用 **tsc 静态扫**：`tsc --noEmit --allowJs --checkJs --target ES2022 --module ES2022
  --moduleResolution bundler --skipLibCheck <文件>` 后 grep `TS2448|TS2454`。
- **内部通道耗时基准**：`verify/bench-internal-chain.mjs`（真实 Chrome + 生产同款 CDP 链，
  可重跑，自动清理）。2026-10-08 实测：内部购买全链 p50 4.6ms / 内部提交 0.5ms /
  trustedClick 47ms / 提交兜底链（含 300ms 硬睡）~352ms。内部通道达标 0.1s，兜底链超标（未修）。
- **控制台「抢购行为」面板 = 可调参数的唯一入口**（2026-10-08 全量化，5 组 17 项、全大白话标注）：
  新增 `limits.internalFireMs`（内部喊话节奏，默认 50，替代写死的 300）；开关拨动即存、数字走
  「保存设置」；保存是桥接 deepMerge 局部 patch（不丢字段）；页面按 mtime 热重载（改完刷新浏览器）。
  加字段三步：HTML 元素 + renderSettings 读取 + 保存 patch（开关用 bindInstantSwitch），缺一不可（2026-10-08 晚按三步补回 setBuyRetry/setMonMax，门户改版曾弄丢）；
  回归：`verify/verify-console-settings.mjs`（只读冒烟：面板值==配置值 + 零 JS 异常；打开 URL 用 /console-huawei）。
- **预开确认页路径的提交闸门**（2026-10-08 已修）：改用 `preOpenSubmitLeadMs`（默认 0 = 对准 T0）
  ——不再沿用 T0-500ms 的点击提前量（审计 P1-2：太早发会被服务器"未开始"拒收且失败不补发）。
  · 新观察点：**B 快切路径**命中开出的确认页会立即提交（无 T0 锚定）——待真场次看服务器接受性。
- **驱动不热加载槽位**（2026-10-08）：cdp-rush 启动时只读一次 rush-slots——改过槽位必须
  "停驱动 → 重新派发"，否则旧绑定继续跑。改槽位的脚本一律 stop → sleep → launch 两步齐做
  （schedule-purax-1000 先有此模式；rush-experiment-3plans 2026-10-08 已补齐）。
- **控制台平台特化审计**（2026-10-08）：grab-console.html 仍与华为深度绑定——①硬编码文案
  （title/h1「华为抢购控制台」、怎么用页、文件清单、warmup placeholder）；②槽位层字段仍叫
  sbomCode（统一字段只覆盖 catalog，未覆盖 slots）；③「抢购设置」页 = 华为驱动参数镜像 UI
  （intercept/internalFire/warmup/scanMode 等 17 项），换平台即无对应物；体检页+保活卡为
  华为专属；④桥接 DRIVERS/CHECKUP_DRIVERS 代码写死（与《加新平台.md》「桥接不用改」不符）。
  已通用：PLATFORM 参数化、platformMeta 文案位、catalog 统一字段渲染、结果页。
  改造方向（已沟通待拍板）：P1 文案归一+字段统一；P2 设置面板改为「平台自带设置清单」驱动渲染；
  P3 能力开关 + 桥接注册数据化。目标：加平台=三件套+一份平台描述，控制台零改动。
  建议拿第二个平台当试金石、实战后实施。
  ★ 2026-10-08 下午已落地门户架构（workbench + 专属页）；P1-P3 留到写第二个平台时再定。

## 测试约定

- ⚠️ **本机（Windows）跑 `npm test` 的坑**（2026-10-09 实证）：项目目录树被标了
  "Low Mandatory Level" 标签 + 会话 SID（从 default-workspace 层级起才有，上级目录没有），
  导致**工作区内的可执行文件**（如 `node_modules/@esbuild/win32-x64/esbuild.exe`）运行时读文件
  一律被拒（`winapi error #5`，vitest 启动即挂）。**绕行（零改项目）**：把 esbuild 复制到工作区外再指路——
  `cp node_modules/@esbuild/win32-x64/esbuild.exe /tmp/esb-test/esbuild.exe`，然后
  `ESBUILD_BINARY_PATH=/tmp/esb-test/esbuild.exe npm test` → 34/34 全绿。
  已二分验证：同二进制在 /tmp 可用、在工作区内（含改名副本）不可用；与 esbuild 本身无关。
- 闸门/判据类改动，必须跑对应实测脚本（真实 Chrome 无头）：
  `verify-list-gate.mjs`（列表闸门）/ `verify-spa-gate.mjs`（SPA 切页）/
  `verify-login-detect.mjs`（登录判据三场景）/ `verify-login-cdp.mjs`（CDP 侧判据）/
  `verify/verify-picker-refresh.mjs`（删商品后采集下拉栏即时刷新，净零可重复跑；
  采集闸门拒绝+对照组用 curl 复核）
- **测试垫片必须真实现**：`GM_xmlhttpRequest` 要真回调、桥接请求要 `page.route` 代理
  （真实 GM_xmlhttpRequest 绕过 CORS，页面 fetch 不绕）。否则测出来的是垫片的毛病。
- 测"闸门有没有拦住"必须**同时验证对照组**（该放行的要放行），
  否则"一律不动作"也会显示通过。
- **槽位/换绑类改动用零副作用方式自测**：弹窗验证 = 制造 diff → 弹确认框 → **取消**（等于零写入，
  以桥接日志为准核对）；换绑保存链路用 API + 文件核对验证，别在控制台点保存（会真写）。
  控制台页面代码整体包在 `__runConsole()` 里，不是全局 —— 想在无头浏览器里内省 JS 变量不可行，
  用 DOM 交互测（点按钮/派发 change 事件）。
- **提交捷径"还能不能走通"验证**：`verify/verify-submit-entry.mjs`（真机：开确认页草稿 →
  测按钮挂载 → 生产同款查找逻辑只查不调 → 自动关页；失败输出页面状态+截图）。
  2026-10-08 实测：入口可达（向上 8 层 handleOrderSubmit）；确认页「提交订单」挂载冷 ~5.8s /
  热 ~0.5s → 驱动提交等待预算 30s。**"提交疑似失效/总走兜底"类问题：先跑它，再翻日志**
  （驱动日志可用 `GET /api/dispatch/status` 拉最近 200 行，含上次运行）。
- **内部通道/降级链路改动回归**：跑 `verify/bench-internal-chain.mjs` 对照 0.1s 预算
  （逐操作实测），并用 tsc --checkJs 扫 TS2448/TS2454 防 TDZ；审计结论在
  《华为抢购脚本审计_内部通道降级与耗时_2026-10-08.md》。
- **三方案实验脚本（`platforms/huawei/rush-experiment-3plans.mjs`）逻辑回归**：
  `verify/verify-3plans-pick.mjs`（合成数据、零副作用、可重复：待抢购过滤/现货与僵尸排除/
  随机挑 3/收集时刻推导/重跑保护，11 项断言）。

## 移动端执行面（2026-10-09 大麦全链路已落地；下方 2026-10-08 设计稿为架构参照）

- ★ 2026-10-09 已落地：手机 Agent 源码 `platforms/app/agent/`（改完必须 `npm run agent:build` 打包
  为单文件 main.js，再经控制台「更新手机脚本」推送）；中枢 `core/device-hub.mjs` v9 + 新控制台
  `web/hub-console.html`（一键连接设备/安全演练/游标日志）；观演人档案经手机「我的」自动探测同步
  落 `data/grab/account.profile.json`；省市区数据 `regions.json` 随一键连接推送。
  **注意：观演人档案/大麦配置含实名信息 → 2026-10-09 已移出仓库+加忽略（本地保留）；公开历史
  仍含旧数据（彻底清除需重写历史，待定）。新增配置类文件含个人信息时一律先问「要不要入库」。**
- App 端（淘宝/京东/大麦）抢购 = 「安卓真机 + `adb reverse tcp:3100 tcp:3100` + HTTP 长轮询 +
  端侧薄击发（AutoX.js v7，现址 aiselp/AutoX；旧址 kkevsekk1 已 404）」；正式场只用真机，
  模拟器仅开发/彩排；**击发不依赖 PC**（任务单先落盘手机，本地单调钟死等）。
- 硬门槛：标定 8 项（intent 组件名/存储权限/锁屏/省电/深链/无障碍覆盖率/对时源/提前量）全过
  才允许自动击发；对时以平台服务器为权威（min-RTT 采样）；结果 outbox + taskId 幂等；
  白名单快照冻结进任务单；深链落页需"页面身份校验"。
- 终版全文（六方对比 + 冻结版 + 审查）：`docs/APP端抢购终极技术方案_WorkBuddy终版_2026-10-08.md`；
  各家方案存 `docs/1/`（共 6 份：Antigravity、ZCode-GLM、整合稿、前稿等）。
- 关键事实（2026-10-08 源码级核实）：AutoX 延续仓 = aiselp/AutoX（kkevsekk1 原仓已删的 fork，★1.9k、v7.2.4）；
  启动组件 `org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity`（-d file:// 直跑脚本）；
  无障碍组件 `com.stardust.autojs.core.accessibility.AccessibilityService`（adb settings put secure 自愈）。
- 最新裁决：hub 独立 :3120（理由=与华为产线隔离）；引擎条件冻结（P0-0 三验证后，Plan B=AutoJs6）；
  通道 adb reverse:3120 + 长轮询；白名单=内容快照+版本+哈希；击发=预热锚定+零查找（不承诺固定毫秒数）。
  待拍板：平台顺序（京东先 / 大麦先）、GPL 非商业边界。
