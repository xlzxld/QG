# 项目长期记忆 · 稀缺名额与稀缺商品抢购平台

## 一、用户硬规则（跨模块操作纪律）
1. **白名单纪律**：清单外的对象一律不操作（不开窗/不加载/不点击/不发请求）。闸门必须在副作用之前；匹配失败当错误处理，绝不兜底默认值（搜 `|| {}`/`|| []`）。判定按 id（华为 prdId / 大麦 itemId），不按标题。测试必须带"该放行的要放行"对照组。
2. **状态判据用真实凭据**，不看页面文案。3. **换绑即重置**；自测零副作用。4. **沟通**：大白话、先结论后细节、术语跟一句白话解释；给用户的文档只写点击路径、一页以内。

## 二、项目全景
- 布局：`core/`（grab-bridge :3100｜device-hub :3120｜keepalive｜service-menu）｜`platforms/{huawei,damai,app}`｜`web/hub-console.html`（手机中枢控制台）｜`tools/`｜`verify/`（活跃在根）｜`data/grab/`｜`tests/`。归档目录不入库不测。
- git `github.com/xlzxld/QG`（代理 127.0.0.1:7897；token 姿势见用户级记忆）。启停入口 `服务启停.bat/.command`。
- **改 bridge/hub/agent 代码必须重启服务 / 重推脚本**（改 hub 不重启 → 新字段被白名单**静默丢弃**）；hub-console.html 刷新即生效。
- 沙箱：进程活不过命令边界；同步 spawn 一律 EBUSY（统一异步 spawn）；`npm test` 需 `ESBUILD_BINARY_PATH` 绕行。

## 三、技术约定与踩坑
- spawn 一律 `windowsHide:true`。Windows .bat：CRLF；含中文必须 GBK + `chcp 936`；守卫 `tests/platform-compat.test.mjs`。
- adb 在项目根 `platform-tools/`；**任何 adb 调用超时 ≥6s**。`uiautomator dump` 在动画页上会报错且写 0 字节文件 —— 空 dump 不当证据。挪含 let/const 的代码块时声明一起挪（TDZ）。
- 设备 busy 新任务**排队** → 换参先 `POST /api/tasks/cancel` 再 dispatch。遗留：用户处有 10:00 跑旧路径的计划任务（已失效）。

## 四、大麦 grab 现行口径（2026-10-10 定案）
- 链路：hub-console「🔗 链接抢购」→ `POST /api/tasks/dispatch`（mode:'grab'，闸门=itemId 纯数字 + fireAt>0）→ agent `executeDamaiGrab`：就位→核对→定位→对时→开抢前等待→T0-1s 高频盯梢→首击→高频连点链→readResult。
- **结构信号（唯一可靠）**：预约结构 6 项（`id_new_project_normal_count_down_layout` / `id_project_count_sell_time` / `id_project_ticket_remind_me` / `id_project_count_down_remind_layout` / `id_project_count_down_layout` / `id_project_count_down_bg`）里 **≥2 项从有到无** ⇒ 开售；容器属性变化仅兜底；必须**底栏容器仍可读**才算数。**绝不用像素/截图**。干扰项：`id_new_project_grab_tip_text`、预售滚动条。文案兜底只留反向判据（"…开抢"消失）。
- 页面身份**只认标题节点** `info_v2_title_tv1`，目标站名必须出现在标题里（旧 `grabKeywordsOk` 全页搜字 → "跑错站"真 bug）。
- **一个统一锚点通吃 3 个按钮**（立即预订/确定/立即提交 → (841,2310)）；「继续尝试」弹窗是**另一个点位**（(540,1382)，优先点节点中心）。
- **点击只有两路：PC-ADB(USB) → 手机本地 Shizuku**（2026-10-10 用户裁决）——**无障碍手势点击兜底已彻底删除**（真机实测对自绘按钮"返回成功但界面零变化"）：`fastPress` 已删；`adbPress`/`emitFirstTap`/`criticalTap` 不含 `press(`/`click(`/`humanPress`；`executePhoneOp op='gesture'` + 中枢 `case 'gesture'` 删除；能力矩阵 `gesture/gestureReliable` → `tapAdb/tapShizuku`。两路都不通 = 如实报 `first_tap_failed`，**绝不假装成功**。保留的手势用法：`humanPress`（UI 节点坐标点按）、`humanSlide`/`stepWheel` 的 `gesture()`（滑块/省市滚轮拖拽）。
- **点击参数三处必须一致**：控制台 `hub-console.html`（含其**自己的 `deriveCadence`**）= 中枢 `device-hub.mjs` 白名单 = 手机端 `applyClickCfg`。改一处必须三处同改 + `npm run agent:build` + 跑护栏（`tests/mobile/grab-logic.test.mjs` 第16/21/23 条）。现行：抖动 **X0~100 / Y0~40，默认 30/12**（几何极限其实 ±173/±60，按用户口径卡 100/40）；首击超时 30~3000 默认 50；首击发数 1~5 默认 1；**节拍 1~50，无风控硬上限**（去掉 ≥50ms 间隔地板）。
- **2026-10-10 新增四参**（默认）：`doubleReadMs 50`（双读确认延迟）、`blindFire false`（到点盲点一发开关）、`popupDelayMs 300`、`popupPollMs 50`、`watchPollMs 400`。盲点**走 emitFirstTap 统一出手链，USB/WiFi 都支持**，打完继续盯梢。
- **执行方式只剩一种**：旧「彩排 / 无脑高频」已删；绿色「🧪 测试」= 同一份参数 + 到点直接出手（`dryRun`），之后走**同一条完整连点链**；「🩺 全面自检」= 中枢/手机/通道/脚本版本/商品/时间/参数逐项体检 + 按通道给链路说明。
- **点「抢购」= 直接下发**：不许有 confirmModal、不许有会拒绝的 return（itemId/时间/能解析 fireAt/通道在线四条是事实必要条件）。时间异常只 toast + 照发。`mode==='buy'` 的确认框是资金闸门，别删。`parseFireTime(raw, nowMs)` 统一解析；⚠️ 陷阱 `2026-10-10 1:30` = 01:30。
- 预填字段**绝不能"非空就永不覆盖"**：`lastParsedItemId` 记归属商品，商品 ID 一变就重填；同商品只补空值；探针无开售提示 → 清空并提示手填；启动先 `primeGrabLinkBaseline()`。
- 控制台参数**只在点「💾 保存参数」写 localStorage**（无自动保存、无「清空已存」）。
- 连点链**无注入熔断**（不再"连续 3 次失败就停"，只计数上报 `injectFails`）；侧车线程管弹窗处置 + 终态看护，与主链共享 TAP_SPACING（只防撞同一瞬间，不限速）。
- **日志口径：任何操作都要有人话日志** —— 手机端 `sendLog` 一律"大白话 + 数字"（`[就位]/[核对]/[定位]/[对时]/[等待]/[盯梢]/[出手]/[副手]/[连点]/[诊断]/[取证]`，禁裸术语）；控制台 `localLog()` 记"你点了什么"（全局 click 兜底 + `grabArm` 的 `[参数]` 快照），`processEvent` 给每个抢购事件配人话解读，**不许再出现"整段 JSON 兜底"**。
- **全程记录 / 复盘**：控制台 `localLog` 同步 `POST /api/events/console`（只落盘 `device-events.jsonl`，**不回灌事件环**）→ 人工操作与手机事件进同一条时间线；控制台「📄 导出本次记录」→ `POST /api/record/digest`（`buildDigest`）渲染成人话 Markdown（含【人工/控制台】标记 + 关键结论），落盘 `data/grab/digest/`。
- **出手判定不许加"人工介入"前置闸门**（2026-10-10 用户裁决）：我一度加了"页面被点走就暂停判定"（`page_left_watch/skipFire/onDetailAct`），用户判定「基本不会出现这种切走的场景, 徒增负担」→ **已撤**, 护栏反向锁死不许复活。顺带更正一个错误说法：**手挡屏幕不影响无障碍读节点**；真正会整片读不到的是"别的窗口抢了焦点"（系统弹窗/通知栏/输入法, vivo VDialog 尤其明显），`invalidStreak` 只记日志不误判；手指真正会打架的是**注入点击**（按着时注入的 tap 可能被吞或与用户触摸合成多指手势）。
- **现场取证**：`captureEvidenceAsync()` 必须**独立线程**跑 `diagSnapshot`（否则卡住连点链）；弹窗首见 `popup_first_seen` + 取证、验证码 `captcha_seen` + 取证、全场没弹窗 `popup_never_seen` + 补证据。
- **停止脚本 = 手机回报 + 中枢复探**（2026-10-10 用户口径，**以这条为准**）：手机收到停止指令 → **退出前先 `notifyStopping()` 回报** `POST /api/device/stopping` → 中枢 `markStopConfirmed()` 立刻把 `stoppingAt` 打上、`liveAgents()` 当场摘除（通道/设备状态即时刷新）→ **复探**：回报后 3 秒宽限内若仍在发心跳/轮询 ⇒ 判定"停止没生效" `discardStopMark()`（撤状态 + `agent_stop_failed` 事件 + 提示再点一次）；指令发出 10 秒没等到回报 → 自动重发（最多 3 次）。**中枢绝不"点一下就假设停掉"**（`/api/device/stop-agent` 只记 `stopPushedAt`）。控制指令已抽成 `Transport.applyControl()`，**心跳与长轮询共用** → 手机闲着时停止指令经 `deliverControlNow()` 塞进挂起的长轮询，秒级送达。
- **`isAlive` = "脚本真的在跑"，`usbAttached` = "数据线插着"**（两个概念**绝不许互相冒充**）：曾因 `/api/devices` 在 USB 插着时强制 `isAlive:true`，导致停止后控制台永远显示"在线"。现在 `isAlive = 心跳新鲜 && !stoppingAt`。控制台三档：`stopPushedAt` 未确认 → 「🟡 正在停止…」、`stoppingAt` → 「⏹ 已停止」、否则 在线/失联；`grabArm` 的"脚本在线"前置检查**两种通道都要过**。
- **中枢重启 = 内存设备表清空**，而手机只在**脚本启动时**发一次 `hello` → 只在 hello 里上报的字段（`agentVersion` / `screen` / `autoX`）会全丢，控制台就会误报"版本号未上报（旧脚本）"。修法（2026-10-10）：① 心跳 payload 也带 `agentVersion`；② 中枢心跳响应带 `registered`，false 时手机**立刻补发 hello**；③ 校验类判据一律以**体积字节级一致**为准（`canVerifyOp = sizeExact || 版本≥1.3.0`），版本号缺失/不一致在体积一致时不显示❌。⚠️ 改这类判据后要检查测试里"排队任务"的相互干扰（体积一致会真的下发手机自检任务，会挤掉后面的用例）。
- **接口成功判定必须看"契约字段"，不能靠"HTTP 200"或单一 `ok`**（2026-10-10 踩坑）：`/api/device/update-script-lan` 原来只回 `{status:'pending'}`（**没有 `ok`**），而控制台写 `if (r.ok) ... else toast('更新未完成')` → **WiFi 路径必然误报"更新未完成"**（实际已更新）。现在：中枢 LAN 端点回 `ok:true + pending:true`；控制台分三档（已下发 / 已生效 / 已下发未确认 `warn`）；并新增 `confirmScriptUpdated()` **下完 10 秒用体积对账复核**再下结论。`/api/device/verify-script` 支持 `body.deviceId` 指定设备。改任意"更新/自检"类端点时，先对照控制台的判断条件。
- **中枢离线/拔线 = 抢购照跑**（2026-10-10 核实并加固）：开售判定（无障碍读结构）与对时（直连大麦 MTOP）都在手机本地，不经中枢；点击是**逐发尝试**「① PC-ADB(中枢) → ② 本地 Shizuku」，走局域网地址或中枢进程被杀时 ①毫秒级失败 → 自动走 ②；`openItem` USB 失败自动转 `openItemLocal`；结果失败进 `enqueueOutbox`，中枢回来 `flushOutbox` 补发；拔线后长轮询 catch 会 `detectHub()` 重新发现局域网地址。⚠️ **「中枢停止」(电脑程序退出, 不影响手机) ≠ 「停止手机脚本」(命令手机退出, 抢购会停)**。⚠️ 前提：**手机必须开 Shizuku**（WiFi/无数据线下唯一点击通道）。⚠️ 加固：中枢可达性熔断 `hubReachable/noteHubFail/noteHubOk`（连续 3 次失败 → 15 秒内丢弃上报、ADB 点击直接走本地），失败后上报超时 3000→600ms —— 否则"整台电脑关机"时 HTTP 干等会把盯梢循环从 10ms 拖到 3s、毁掉出手时机。
- **WiFi 通道 = 必须开 Shizuku**（用户口径）：自检里 WiFi + Shizuku 未开 = ❌红项（USB 下只提醒）；通道提示也带 Shizuku 状态；下发时只提醒不阻断。中枢 `resolveChannel` 输出 `shizuku/shizukuReady/agentVersion`。
- 其它：链接直达 `am start -a VIEW -d 'damai://detail' --es itemId <ID> -p cn.damai`；探针 = Playwright 无头拦 `mtop.damai.item.detail.getdetail`；手机脚本版本 `POST /api/device/verify-script`（体积对账为主），版本号唯一来源 `Transport.AGENT_VERSION`（正则取版本写 `agent_?version`）。

## 五、测试约定
- 跑测：`cp node_modules/@esbuild/win32-x64/esbuild.exe /tmp/esb-test/esbuild.exe` + `ESBUILD_BINARY_PATH=/tmp/esb-test/esbuild.exe npm test`（2026-10-10：88/88 绿）。
- **控制台 UI 改动必跑"真中枢 + 真浏览器"实测**：`verify/verify-grab-console-v2.mjs`（抢购卡片全量：测试按钮/盲点/四节奏参数/抖动上限/日志面板/自检）、`verify-grab-prefill-refresh.mjs`、`verify-grab-time-guard.mjs` —— 自起中枢 33xxx + `DEVICE_HUB_DATA_DIR` 临时目录 + 探针库副本，不碰生产 data/grab 与 pid；用 `page.route` 截获下发报文断言。端口分配：33120/33121/33122/33123，别撞。
- 垫片必须真实现；测闸门必须同时验对照组；控制台页面代码包在函数里 → 用 DOM 交互测，不能内省变量（会被 TDZ/闭包骗）。
- 常规控制台操作用户自己点；我只做界面解决不了的代码行为层改动。
