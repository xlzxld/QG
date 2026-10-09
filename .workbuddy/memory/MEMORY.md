# 项目长期记忆 · 稀缺名额与稀缺商品抢购平台

## 用户定的硬规则（必须遵守）

### 1. 商品列表 = 唯一操作白名单（2026-10-07）
不在 `data/grab/<平台>.config.json` 的 `products[]` 里的商品，脚本一律不操作：不开窗口 / 不加载页面 / 不点击 / 不插页面元素 / 不发请求（读控制台列表那次只读除外）/ 不写缓存 / 不体检。用户手动打开的别的商品页同样完全不动。
- 列表以控制台为权威（`GET <桥接>/api/config/<平台>`），不认本地缓存当权威；判定按 prdId，不按标题关键字
- `skuIds` 留空 = 全部规格；非空 = 只认勾选过的
- 闸门位置：桥接派发接口 / `cdp-rush.mjs` 起飞预检+runSlot 开头 / `checkup-vmall.mjs` C0 / 油猴三层（启动闸 + 配置复核 + SPA 切页哨兵）

### 2. 登录态看浏览器凭据，不看页面文案（2026-10-07）
判据：`sid` / `hwid_cas_sid` @ `.id1.cloud.huawei.com`（未登录都不存在，已登录都在，len=84）。实现 `cdp-core.mjs` 的 `readLoginState()`（驱动+体检共用）；油猴用 `GM_cookie`。
页面文案两个方向都会误判，不用。辅助信号只认"登录已过期/请重新登录"这类明确措辞（60s 保鲜）；不收 `200916` / "用户未登录"。

### 3. 换绑即重置（2026-10-07）
槽位换商品/规格 = 一个事件，必须触发重置；不采用"运行后锁死只能删"（槽位 id 绑着登录档案 `chrome-profile-rush/<id>`，锁死=每场删建=重登）。真正的防误改 = 换绑确认弹窗。
- 服务端 `POST /api/dispatch/slots` 对比旧→新绑定（含同 id 删了又加回）→ 作废配不上的 `checkup-report.json`（检查历史在 `checkup-history.jsonl`，不丢）+ 响应带 `rebinds` 清单
- 控制台：保存/派发前弹换绑确认（列 从→到 + `[此槽位有运行历史]`）；保存后 toast 重置提示；「最近结果」对不上当前绑定则不显示（显示 —）
- 窗口旧页面不用清：驱动起飞会导航归位 + 清残标签
- ⚠️ 换绑自测必须零副作用（只弹确认框再取消）。别在生产槽位做"临时换绑"——控制台轮询会把瞬时值缓存，之后一次保存就写进正式配置

## 项目结构（2026-10-08 深度重组 · 已入 git）
- 布局：`core/`（桥接/启动器/保活/定时器/CDP 底座）｜`platforms/huawei/`（驱动/采集/体检/api/油猴/intercept/recon/实验）｜`platforms/showstart/`、`apple/` 占位｜`web/`｜`tools/`｜`verify/`（活跃工具在根、history 冻结、tmp）｜`docs/`｜`data/grab/`｜`tests/`｜归档不入库
- git：`https://github.com/xlzxld/QG.git`（代理 127.0.0.1:7897）；仓库内 core.autocrlf=false；锚点：tag `baseline-pre-restructure` / 重组 `ebe8e4a` / 回归修复 `693ed86` / 移动端大更新 `6590126`
- URL 约定：`/` = 工作台外壳；控制台 = `/console-huawei` 等专属页（验证脚本打开页面别再用 `/`）；手机中枢 = `http://localhost:3120`
- 挪文件规则：同深度不动、深度 +1 的引用补一层
- 2026-10-09 移动端大更新（`6590126`，58 文件 +10625）：新增 `platforms/app/agent/`、`core/device-hub.mjs`（:3120）、`web/hub-console.html`、`platforms/damai/`、`tools/mobile/`、`core/run-drill.mjs` + 一键演练；华为槽位 acc1-3（端口 9401-9403）；npm scripts（hub/drill/agent:build/device:prepare/huawei:slots-check）；旧依赖清退（hono/pg/zod/tsx），新增 china-division；旧文档入 `docs/archive/`
- 本机 `data/grab/chrome-profile-rush/` 只有 `acc1`/`acc2`（无 acc3）→ 跑三槽位前先 `npm run huawei:slots-check` 补登录

## 技术约定
- **vmall 是 Next.js SPA**：站内跳转不重载 → 守卫必须监听 `pushState/replaceState/popstate` + 轮询兜底；页面身份比对用启动时 prdId 基准，不能只问"是否在允许集合内"
- 下单动作必须通过页面自身代码发起（可信点击/内部函数），不构造不重放请求；只读接口（校时/队列/列表）不算越界
- 油猴 `$` 是 getElementById 包装，传纯 id（写 `$('#x')` 整段静默死掉）
- 抢购配置 `dryRun` 默认谨慎；改完核对 `data/grab/rush-slots.huawei.json`
- 桥接 `core/grab-bridge.mjs` 改后必须重启（不热加载）→ 让用户双击「服务启停.bat」→ 按 3（重启全部）；沙箱起的进程活不过命令边界
- spawn 子进程一律带 `windowsHide: true`（否则弹黑窗；**后台/detached 进程尤其致命**——没有控制台可继承，每次调用都弹一个新窗口）；已改 grab-bridge ×6 + grab-launcher ×1 + device-hub ×3（2026-10-09 中枢后台化后"每 5 秒 adb 轮询弹窗"的教训；新增无控制台常驻进程时把它的全部 exec/spawn 过一遍）
- **Windows .bat 规范（2026-10-09 定案）**：一律 CRLF；含中文的 bat 必须 GBK 编码 + `chcp 936`（UTF-8/BOM + `chcp 65001` 组合会把 cmd 解析"啃"错位、直接崩退——实测 EXIT=255）；纯 ASCII 的 bat 内不写中文，中文输出交给 node 打印（WriteConsoleW）。守卫 = `tests/platform-compat.test.mjs` 第 5 项
- **服务启停统一入口（2026-10-09）**：`服务启停.bat / 服务启停.command` → `core/service-menu.mjs`（菜单：启动/停止/重启全部、单项管理、状态、看日志、自检、控制台）；桥接内核 `grab-launcher.mjs`（--start/--stop/--restart/--status，另有 import 守卫：被 import 不执行 main），中枢内核 `hub-launcher.mjs`（--start/--start-bg/--stop/--restart/--status；后台运行，日志 `data/grab/device-hub.log`）；PID 定位三级：/health 自报 → netstat → PID 文件+身份核对。旧启停脚本 12 个（启动/停止服务/重启服务/启动-手机中枢/停止抢购中枢 ×2平台 + start.sh/stop.sh/start-device-hub.sh）已删；Windows 环境自检 = `自检-Windows环境.bat` + `check-windows-env.mjs`（本机现状：ADB 已装 = 项目根 `platform-tools/` v37.0.1，已 gitignore + 用户 PATH；无 winget）
- adb 相关约定（2026-10-09）：本机 adb = 项目根 `platform-tools/`（**不入库**；中枢启动时自动把该目录补进子进程 PATH，不依赖系统 PATH 传播时机）；**任何 adb 调用超时 ≥6 秒**——服务冷启动需 1~4 秒，2 秒超时会被实测强杀、误判「adb 不可用」（device-hub 探测已改 6000ms）
- 局域网连接（2026-10-09）：手机端 `transport.js` 自带**同网段扫描自动发现中枢**（换网络/换电脑零配置，命中缓存进 hubUrls，60s 节流；agentVersion≥1.0.1）；Windows 需管理员放行 TCP 3120（双击 `开启局域网访问-管理员.bat`，规则 QG-Hub-3120）；中枢有 `GET /agent/main.js` 下载路由（手机浏览器免数据线更新脚本）
- `--only` 匹配：精确优先、子串兜底（`pickByOnly`）；桥接 `/api/crawler/run` 对 only 做精确硬闸门（命不中/已停用 → 400）；控制台任何写商品列表的入口后必须 `renderOnlyPicker()`（下拉栏残留=白名单泄漏，已补 4 处：删除/商品设置/添加/原始JSON）
- 控制台采集范围 = 下拉栏（`renderOnlyPicker()`）；验证 `verify/history/verify-only-picker.mjs`
- 服务常驻/"窗口弹不弹"类验证必须借用户环境（沙箱进程活不过命令边界、spawn 子进程不弹窗、schtasks/wmic 黑名单）→ 用户点 bat/点按钮，我在旁采样（`verify/sample_windows.py`）
- 常规控制台操作用户自己点（加删商品/勾规格/填开售时间/采集/派发）；助手只做界面解决不了的代码行为层改动
- 挪动含 let/const 的代码块时，声明必须一起挪到首个使用之前（TDZ 坑）；用 `tsc --noEmit --allowJs --checkJs --target ES2022 --module ES2022 --moduleResolution bundler --skipLibCheck <文件>` 后 grep `TS2448|TS2454` 静态扫
- 内部通道耗时基准 `verify/bench-internal-chain.mjs`：2026-10-08 实测内部购买全链 p50 4.6ms / 内部提交 0.5ms / trustedClick 47ms / 兜底链（含 300ms 硬睡）~352ms（超标未修）
- 控制台「抢购行为」面板 = 可调参数的唯一入口（2026-10-08 全量化，5 组 17 项）；`limits.internalFireMs`（内部喊话节奏，默认 50，替代写死的 300）；开关拨动即存、数字走「保存设置」；保存是桥接 deepMerge 局部 patch；页面按 mtime 热重载；加字段三步（HTML 元素 + renderSettings 读取 + 保存 patch）缺一不可；回归 `verify/verify-console-settings.mjs`
- 预开确认页提交闸门用 `preOpenSubmitLeadMs`（默认 0 = 对准 T0），不再沿用 T0-500ms 提前量（太早发会被"未开始"拒收且失败不补发）；B 快切路径命中确认页会立即提交（无 T0 锚定）——待真场次看服务器接受性
- 驱动不热加载槽位：cdp-rush 启动只读一次 rush-slots → 改过槽位必须"停驱动 → 重新派发"；改槽位脚本一律 stop → sleep → launch
- 控制台平台特化审计（2026-10-08）：grab-console.html 仍与华为深度绑定（硬编码文案 / 槽位层字段仍叫 sbomCode / 「抢购设置」页 = 华为驱动参数镜像 / 桥接 DRIVERS 写死）。已通用：PLATFORM 参数化、platformMeta、catalog 统一字段、结果页。改造方向 P1 文案归一+字段统一 / P2 设置面板改「平台自带设置清单」驱动渲染 / P3 能力开关+桥接注册数据化（留到写第二个平台时再定）；2026-10-08 下午已落地门户架构（workbench + 专属页）
- 桥接体检只查 slots[0]（`checkup-vmall.mjs` 无参 = 第一个槽位；支持 `--slot=accX`，但桥接 `/api/checkup/run` 不带参）。查非首位：临时排到 slots 第一位再触发，完事恢复（核对 + git checkout）；窗口没拉起时会经 `ensureSlotWindow` 自动开窗；front profile 首启那一瞬会误报"端口不可达"，隔几秒复检即正常
- 派发定时没有桥接内置调度（只有爬虫/体检调度，爬虫调度关着）→ 用「自动化任务」或 `core/deferred-timers.mjs <HH:MM> <脚本>`。工具 `tools/dispatch-huawei.mjs`（幂等派发：已在运行=成功不重复派；--plan 只读预演；结果记 `data/grab/auto-dispatch-log.md` 并回传控制台）；手动武装 bat「今早抢购-手动武装.bat」；派发接口自带商品列表闸门（prdId 在 products 且 sbomCode 已勾选才放行）
- 保活守护：`keepalive-daemon.mjs` 由桥接开机自动拉起（PID 防重复），4~6 分钟抖动给所有在跑槽位窗口续命——窗口不跑驱动时也保持登录，新开窗口自动纳入（读 slots 文件端口）。**中途被停不会自动重启**（桥接只在启动时拉起一次）：巡检查 `/api/keepalive/status`，恢复用 `POST /api/keepalive/start`
- **"抢购未中"排查三件套（2026-10-09）**：① 取证 `events.jsonl` 有无 `UNLOCK_SEEN`（无 = 购买按钮从未出现，点击速度不背锅）② 直读 `queryRushbuyInfo.skuStatus`：**开售前=1、售罄=2**；开售过点仍=1 ⇒ 疑该场无放量 ③ 页面 buttonMode：1=现货可买、2=即将开售、9/10=缺货、29=抢购未开售——**29 在开售后不翻转**，控制台「待抢购」徽标会一直挂着（≠能买）。爬虫读的是这些平台字段（如实转译），"待抢购 SKU 实际缺货"是平台自身两套状态的不一致，非爬虫 bug
- 遗留待清理：用户自建 Windows 计划任务 10:00 跑旧路径 `scripts\check-slot-logins.mjs` / `scripts\rush-experiment-3plans.mjs`（10-08 重组后失效，报"找不到模块"，输出 `data/grab/schtasks.log`）

## 测试约定
- ⚠️ 本机（Windows）跑 `npm test` 的坑（2026-10-09 实证）：项目目录树从 default-workspace 层级起被标 "Low Mandatory Level" + 会话 SID → **工作区内的可执行文件**运行时读文件一律被拒（`winapi error #5`，vitest 启动即挂）。绕行（零改项目）：`cp node_modules/@esbuild/win32-x64/esbuild.exe /tmp/esb-test/esbuild.exe` + `ESBUILD_BINARY_PATH=/tmp/esb-test/esbuild.exe npm test` → 34/34 全绿
- **沙箱子进程限制（2026-10-09 实证）**：会话沙箱内 node 的**同步 spawn 一律 EBUSY**（execSync/execFileSync/spawnSync），**异步 spawn / process.kill / fetch 正常** → 采集外部命令输出的新代码统一用异步 spawn（hub-launcher / check-windows-env 已照此实现），沙箱即可全链路验证；reg.exe 在黑名单（自检用 PS 兜底取版本，属正常容错）
- 闸门/判据类改动必跑对应实测脚本（真实 Chrome 无头）：`verify-list-gate.mjs` / `verify-spa-gate.mjs` / `verify-login-detect.mjs` / `verify-login-cdp.mjs` / `verify/verify-picker-refresh.mjs`
- 测试垫片必须真实现（`GM_xmlhttpRequest` 真回调、桥接请求走 `page.route` 代理；真实 GM_xmlhttpRequest 绕过 CORS，页面 fetch 不绕）
- 测"闸门有没有拦住"必须同时验证对照组（该放行的要放行）
- 槽位/换绑类改动用零副作用方式自测（弹窗验证 = 制造 diff → 弹框 → 取消；换绑保存链路用 API + 文件核对，别在控制台点保存）。控制台页面代码包在 `__runConsole()` 里不是全局 → 无头浏览器内省变量不可行，用 DOM 交互测
- 提交捷径验证 `verify/verify-submit-entry.mjs`（2026-10-08：入口可达，向上 8 层 handleOrderSubmit；确认页「提交订单」挂载冷 ~5.8s / 热 ~0.5s → 提交等待预算 30s）。"提交疑似失效/总走兜底"类问题先跑它再翻日志（`GET /api/dispatch/status` 拉最近 200 行）
- 内部通道/降级链路改动：跑 `verify/bench-internal-chain.mjs` 对照 0.1s 预算 + tsc 扫 TDZ；审计结论见《华为抢购脚本审计_内部通道降级与耗时_2026-10-08.md》
- 三方案实验脚本 `platforms/huawei/rush-experiment-3plans.mjs` 逻辑回归：`verify/verify-3plans-pick.mjs`（合成数据、零副作用、11 项断言）

## 移动端执行面（2026-10-09 大麦全链路已落地）
- 手机 Agent 源码 `platforms/app/agent/`（改完必须 `npm run agent:build` 打包单文件 main.js，再经控制台「更新手机脚本」推送）；中枢 `core/device-hub.mjs` v9 + 新控制台 `web/hub-console.html`（一键连接/安全演练/游标日志）；观演人档案经手机「我的」自动探测同步落 `data/grab/account.profile.json`；省市区 `regions.json` 随一键连接推送
- ⚠️ **观演人档案/大麦配置含实名信息 → 2026-10-09 已移出仓库 + 加忽略（本地保留）；公开历史仍含旧数据（彻底清除需重写历史，待定）。新增含个人信息的配置类文件一律先问"要不要入库"。**
- App 端（淘宝/京东/大麦）抢购 = 安卓真机 + `adb reverse tcp:3100 tcp:3100` + HTTP 长轮询 + 端侧薄击发（AutoX.js v7）；正式场只用真机，模拟器仅开发/彩排；**击发不依赖 PC**（任务单先落盘手机，本地单调钟死等）
- 硬门槛：标定 8 项（intent 组件名/存储权限/锁屏/省电/深链/无障碍覆盖率/对时源/提前量）全过才允许自动击发；对时以平台服务器为权威（min-RTT 采样）；结果 outbox + taskId 幂等；白名单快照冻结进任务单；深链落页需页面身份校验
- 终版全文（六方对比 + 冻结版 + 审查）：`docs/APP端抢购终极技术方案_WorkBuddy终版_2026-10-08.md`；各家方案存 `docs/1/`（6 份）
- 关键事实（2026-10-08 源码级核实）：AutoX 延续仓 = aiselp/AutoX（kkevsekk1 原仓已删的 fork，★1.9k、v7.2.4）；启动组件 `org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity`（-d file:// 直跑脚本）；无障碍组件 `com.stardust.autojs.core.accessibility.AccessibilityService`（adb settings put secure 自愈）
- 最新裁决：hub 独立 :3120（与华为产线隔离）；引擎条件冻结（P0-0 三验证后，Plan B=AutoJs6）；通道 adb reverse:3120 + 长轮询；白名单=内容快照+版本+哈希；击发=预热锚定+零查找（不承诺固定毫秒数）。待拍板：平台顺序（京东先/大麦先）、GPL 非商业边界
