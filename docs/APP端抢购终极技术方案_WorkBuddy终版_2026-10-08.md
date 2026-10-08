# APP端抢购终极技术方案（WorkBuddy 终版）

> **编制者身份标识：WorkBuddy**（本机智能体 · 独立成稿）
> 版本：2026-10-v5（终版 · 六份方案全覆盖）｜ 日期：2026-10-08
> 定位：对 `docs/1/` 目录下**全部六份方案**做事实级对比与互斥裁决后，给出可直接开工的终极技术方案。
> 审核与查证声明：本稿所有"现实世界断言"均在 2026-10-08 16:40–17:10 **用实时数据复核**（GitHub API 实时状态 / 仓库源码原文 / 本机代码实测），关键证据落盘 `verify/tmp/`（可复验，见 §9）；本稿按 gstack `plan-eng-review` 规程完成第 2 轮工程审查，并附独立对抗评审（宿主内子代理）结论与逐条处置（见 §8）。
> 目录说明：`docs/1/` 实含 **6 份**文档——我方前稿 1 份 + 他方 5 份（Antigravity 初版/终版、ZCode-GLM 上轮/终版、初级整合版）；其中《Antigravity 版》《ZCode-GLM 版》于本任务进行中加入，均已纳入对比与裁决。

---

## 0. 关键名词（人话速查）

| 名词 | 一句话人话 |
| --- | --- |
| device-hub | 新增的"设备中枢"小服务（:3120）：专管手机——上线、心跳、拉起、发任务、收结果 |
| adb reverse | 一根隐形管子：手机上的 3120 口，直接接回电脑的 3120 口（USB 内跑，不经过网络） |
| 长轮询 | 手机每隔几秒问一次"有新任务吗"；比"电脑推到手机"简单，且不用开网络端口 |
| 击发 | 开抢瞬间那一下关键点击（本方案里最值钱的动作） |
| 坐标锚定 | 提前把按钮位置量好，到点直接按坐标出手，省掉"现场找按钮"的时间 |
| 标定 | 上岗前先实测：量延迟、量对时差、量启动成功率，记下来再按数据干活 |
| 模式乙 / 模式甲 | 人工把页面就位、脚本只负责击发（乙）／全自动拉起+击发（甲） |
| outbox | 手机上的"发件箱"：结果先记本地，送到电脑才勾销；断线不丢单号 |

---

## 1. 六份方案对比

### 1.1 总览矩阵

| | D1 单机调试初版 | D2 WorkBuddy 前稿 | D3 u2 双路线版（ZCode-GLM 上轮） | D4 初级整合版 | D5 Antigravity 终版 | D6 ZCode-GLM 终极版 |
| --- | --- | --- | --- | --- | --- | --- |
| 端侧引擎 | AutoX 概念（未核实生态） | AutoX v7（已核实现址） | Route A u2（PC 驱动）+ Route B 自研 APK | AutoX v7 单一路线 | AutoX v7 + 坐标预锚定 | AutoX v7（公开勘误后）；Plan B=AutoJs6 |
| 通讯通道 | ADB forward（方向含糊）+ MQTT 概念 | `adb reverse :3100` + HTTP 长轮询 | 未定死（forward/reverse 混用）；提议独立 device-hub :3120 | 声明 hub :3120 但命令仍写 :3100（矛盾） | `adb reverse :3120`（修正 D4 矛盾） | 反 + 长轮询（结论同 D2）；§4 图残留 tcp:3100 笔误 |
| 击发方式 | 本地时钟 + 无障碍/坐标 | 本地单调钟 + 无障碍（查找式） | A：PC 每击 10–80ms；B：手机本地 | 本地计时 + 选择器查找 | 预热锚定坐标 + 到点按下（宣称 <5ms） | 本地单调钟 + 适配器状态驱动 |
| 对时 | 秒级 Date + 中位滤波 | 平台权威 + min-RTT + 单调钟 | 三层（NTP+平台+手机） | 两级（原则性描述） | 平台 API/Date + min-RTT + 纳秒钟 | 平台权威 + min-RTT + 相对标定（重申） |
| 自愈/保活 | 未设计 | 心跳 + 告警（自愈留空） | 提出前台服务 + 白名单 | bootstrap 被动检查 | Shizuku + adb 双重静默自愈 | Shizuku + hub 哨兵（reverse 自愈重发） |
| 审查 | 形式化 gstack 段落 | gstack 18 项映射 + 独立评审 | 自身 gstack 8 项 + outside 缺席 | 无 | 无（自述对比裁决） | 自述核实（附录 B）+ 公开勘误 |
| 最大亮点 | 最早立起"控制面/执行面分离 + 本地闭环"框架；坚持真机 | 事实核实清单（30 仓库快照）；与现有系统的白名单/结果/门户同构；监控先行 | 审查诚实度最高（F 清单+被抑制发现）；大麦 deep link 敢标"未核实"；成本账 | 适配器"七函数合同"最清晰；许可证边界声明；冻结规则 | 抓住"击发时延"胜负手并给技法；单机落地指引最具体 | 公开勘误自家误判；**冻结条件化**（三验证后再冻结）；"u2=仪器"定调；Pactum7 顺风车验证 |
| 主要短板 | 无协议/幂等/白名单冻结/标定；对时方法落后；"微秒级"过度承诺 | 白名单 hash-only 缺陷（本轮修）；坐标兜底边界不明；进程架构留白 | 因 kkevsekk1 404 **误判 AutoX 整体不可用**（漏了延续仓）→ 绕远路；自研 APK 工程量数周 | 端口自相矛盾；无标定门；无监控先行；引用 URL 是 6★ 小 fork；残留 `citeturn…` 裸标记 | "<5ms"无测量口径；坐标击发缺"身份校验+冻结"守卫；部分平台断言未核实 | §4 端口笔误残留；平台顺序主张与本稿并列（列拍板项）；渠道表外"顺风车"需用户同意 |

### 1.2 逐份短评（结合本轮实测）

- **D1（单机调试初版）**：方向正确（真机、本地击发、控制面/执行面分离），但停留在"框架草稿"：命令前后矛盾（forward 与"手机向 PC 连"并存）、对时用秒级 HTTP Date + 中位滤波（进不了毫秒量级）、无任务协议/幂等/白名单冻结。**结论：作为灵感来源保留，不作为工程依据。**
- **D2（WorkBuddy 前稿）**：工程化程度高（协议、幂等、outbox、标定 8 项、双模式、监控先行、gstack 审查），但它自己留了一个真缺陷：白名单只带 hash——**哈希证明"清单没被改过"，却不能回答"当前页面是不是清单里的目标"**（成员判定需要内容本身）。本轮已改为"内容快照 + 版本 + 哈希"三件套（见 §2 裁决 C）。
- **D3（u2 双路线版，ZCode-GLM 上轮）**：审查态度最诚实（把"未核实"和"低置信度发现"都摆上台面），deep link 表 + 大麦探针门禁的做法值得尊重。致命问题在前提：它核实到 `kkevsekk1/AutoX` 404 后，**结论是"AutoX 不可依赖"并改推 uiautomator2 + 自研 APK**。而本轮的实时复核证明：**aiselp/AutoX 是原仓库被删后仍在活跃维护的延续 fork**（★1898、2026-10-05 有推送、2026-10-03 发 v7.2.4、README 自述为现址）。前提错了，路线选择也跟着绕远：u2 每击 10–80ms 且要引入 Python 栈；自研 APK 是"数周级"工程量。**结论：拒绝其主路线，但吸收其审查习惯与 deep link 纪律（该稿作者已在 D6 中公开勘误并改推 AutoX v7——勘误与查证作风记一功）。**
- **D4（初级整合版）**：结构最干净——适配器七函数合同（prepare/preflight/prime/fire/readResult/recover）、状态机、幂等键、许可证边界、冻结规则，这些全部值得继承。但有一个硬错误：正文声明建 `device-hub :3120`，通信章节却仍写 `adb reverse tcp:3100`——**手机连的是桥接而不是 hub，独立 hub 就失去意义**（D5 已抓到这个矛盾，本轮确认属实）。且它没有标定门与监控先行；另可见正文残留 `citeturn…` 裸引用标记（未经清稿，引用可靠性低）。**结论：骨架采纳，端口矛盾与门禁缺陷修正，引用不采信。**
- **D5（Antigravity 终版）**：本轮最强对手稿。亮点是把"击发时延"当成胜负手并给出可实施技法（预热期锚定坐标 → 到点纯注入）、自愈双保险（Shizuku + adb）、行为拟人化清单、单机 30 分钟落地步骤——这些本稿全部吸收。需要压实的有三处：①"<5ms"没有测量口径（应改为"**消除查找** + 逐机型实测记录"，见裁决 D）；②"纯坐标击发"必须配守卫（身份校验 + T-10s 冻结 + T-2s 复核），否则重开 D2 审查修掉的"深链错页盲点"洞（见裁决 D）；③若干平台断言（大麦 Activity 名、京东 `functionId=serverTime`）未核实，本稿统一转成"实测项"。**结论：技法吸收、表述压实、守卫补齐。**
- **D6（ZCode-GLM 终极版）**：本轮最"较真"的对手稿：开篇公开勘误自己上轮的错误判断，并抓出 D4 的引用错误与裸 `citeturn…` 标记；技术上是"工程骨架 + 模块结构 + 平台战术 + 对时框架"的再融合。两个好点被本稿采纳：①**引擎冻结条件化**——不是今天冻结，而是 P0 冲刺三项验证（intent 组件/存储权限/Shizuku 自愈）通过后再冻结，Plan B=AutoJs6（选择器 API 同源、脚本可移植）；②**Pactum7 猫眼/纷玩岛脚本作引擎兼容性顺风车验证**（渠道表外、不占核心资源）→ 列为 P0a 可选项。要留意：其 §4 架构图仍写 `adb reverse tcp:3100`（与 :3120 主张不符，疑残留笔误）；平台顺序主张"大麦先行"与本稿推荐"京东先行"并列保留为拍板项。**结论：条件化冻结与验证作风全面吸收；端口口径以本稿 :3120 为准。**

---

## 2. 八个互斥点的裁决（全部基于本轮实测）

| # | 分歧点 | 各方主张 | **本稿裁决** | 依据 |
| --- | --- | --- | --- | --- |
| A | 端侧引擎 | D1/D4/D5/D6：AutoX；D3（上轮）：u2+自研 APK（已勘误） | **AutoX.js v7 唯一生产引擎**（**冻结条件化：P0-0 三验证通过后正式冻结**；Plan B=AutoJs6 移植评估）；u2 降为开发期控件侦察工具；自研 APK 仅在"Shizuku 兜底实测不可用"时启动最小 PoC | 实测：aiselp/AutoX ★1898、pushed 2026-10-05、release v7.2.4（2026-10-03）、`fork=true, parent=kkevsekk1/AutoX`（原仓已删）；源码级核实启动组件与无障碍组件（§9）。风险对策：锁版本 + 本地留存 APK + 只用稳定 API 子集 + GPL 非商业边界（不自用外分发） |
| B | 进程架构 | D3/D4/D5：独立 device-hub；独立评审：P0 建议内嵌 bridge | **独立 hub :3120（保留）**，但理由重构：核心诉求是**与华为生产线隔离**（bridge 现有代码零修改 → 对已排期场次零回归风险）+ 两条线独立变更节奏；成本用"零改 bridge + 复用启动器/保活模式"缓释；若实践痛感>收益，可按评审意见并回（接口不变） | 评审已证明"重启解除布防"是伪命题（手机任务自主 + bridge 无设备内存态）；故不再用该理由，改用"产线隔离 + 变更节奏"。D4 端口矛盾修正为 `adb reverse tcp:3120` |
| C | 白名单机制 | D2：hash 快照；评审：hash 无法判成员 | **内容快照 + 版本号 + 哈希**三件套：任务单携带精简目标清单（id/场次/票档/规格），端侧做**精确匹配**（命不中即拒绝）；哈希仅作完整性校验 | 评审 F4；与项目铁律"精确匹配、命不中即拒绝"一致 |
| D | 击发技法 | D4：选择器查找；D5：坐标锚定 <5ms | **两段式：预热锚定（节点+坐标双缓存）→ 到点"零查找"出手**；主击发优先"缓存节点动作"，坐标兜底须满足守卫：①T-10s 冻结页面 ②T-2s 复核（身份节点存在 + 目标节点仍可解析）③未登记例外的平台，坐标路径强制转人工。对外口径改"消除查找 + 实测记录"，不承诺 `<5ms` | 吸收 D5 技法 + 补 D2 审查的"深链错页"守卫；"<5ms"无口径（注入层固有耗时若干毫秒），改测量口径 |
| E | 对时 | D2：平台权威+min-RTT；D3：三层；D5：API/Date+min-RTT | **按平台分帧**：京东=手机直采平台时间（对时接口候选三选一，实测定）；淘宝/大麦=无公开时间源 → 以 NTP 校准的 PC 帧为基准 + **相对标定法**（用"平台是否接受点击"扫出提前量）；`fireAt` 带**帧标签**；手机以反向通道 RTT 测自身偏移，末段**单调钟**死等 | 评审 F5；D2 原稿的相对标定法为必要补回；消除"拿电脑钟当平台钟"的错向修正 |
| F | 阶段顺序 | D5：单机闭环优先；D2：监控先行 | **P0a 监控通道（"交易零副作用"）→ P0b 击发**（措辞修正：P0a 不是"零风险"，它是把 80% 高风险件练熟） | 评审 F8；监控本身仍需无障碍+反通道（有检测面），但无交易副作用，先跑数据最划算 |
| G | 模拟器 | 四方一致：实弹禁；D3 最系统 | 采纳共识 + D5 行为拟人化清单：模拟器仅开发/彩排；实弹真机；真机也要守行为纪律（曲线滑动、频率熔断、单账号单设备） | 公开检测项清单（OWASP MASTG）+ 各方实践 |
| H | 自愈 | D5：Shizuku+adb；D2：仅心跳告警 | **三层自愈**：①手机端 AutoX 前台服务+开机自启（内置 BOOT_COMPLETED 接收器已源码核实）②Shizuku 通道（AutoX v7 原生集成）③PC 侧 adb 自愈（`settings put secure enabled_accessibility_services`，组件名已源码核实）；全部失败 → 告警转人工 | 源码核实：无障碍服务组件 = `com.stardust.autojs.core.accessibility.AccessibilityService`；实机验证列入门禁 |

---

## 3. 冻结版架构

### 3.1 系统拓扑

```text
Windows PC
┌──────────────────────────────────────────────────────────────────┐
│ 网页控制台（桥接服务 :3100 提供，现有）                            │
│   └─ 工作台新增一行入口 → 设备页（由 device-hub :3120 提供）        │
│                                                                  │
│ grab-bridge.mjs :3100  ← 现有代码零修改（华为 Web 线保护）         │
│   · 配置/白名单唯一源（GET /api/config/:platform）                │
│   · 结果文件唯一写者（POST /api/results/:platform）               │
│                                                                  │
│ device-hub.mjs :3120  ← 新增独立进程（127.0.0.1）                 │
│   · 设备注册/心跳/告警   · 拉起链路   · 任务生命周期与去重         │
│   · 配置经 bridge GET 读【不复制白名单源】                        │
│   · 结果经 bridge POST 写【保持单写者】                           │
│                                                                  │
│ QtScrcpy / scrcpy ← 投屏 + 人工接管（35–70ms 延迟，多机群控）      │
└──────────────────────────────┬───────────────────────────────────┘
                               │ USB 线（adb reverse tcp:3120）
┌──────────────────────────────▼───────────────────────────────────┐
│ Android 真机                                                      │
│  AutoX.js v7（v7.2.4，arm64）                                     │
│   · bootstrap → transport（长轮询）→ scheduler（单调钟）           │
│   · executor（锚定/击发）→ result-store（outbox）→ watchdog       │
│   · adapters：damai / taobao / jd / monitor                      │
│  目标 App（人已登录、白名单目标、页面可校验）                       │
└──────────────────────────────────────────────────────────────────┘
```

**两条"救命"不变量（任何实现不得破坏）**：

1. **击发不依赖 PC**：任务单在开抢前数分钟已落盘手机；T0 时刻由手机本地单调钟触发。PC/hub 此时死机也不影响击发。
2. **白名单是硬闸门**：三层——hub 派发时对 bridge 的实时配置校验；任务单冻结内容快照；端侧执行前精确匹配。命不中即拒绝（不动作、不点击、不上报假结果）。

### 3.2 通讯协议（冻结版）

通道路径：手机 `http://127.0.0.1:3120` ←(adb reverse)← PC `device-hub :3120`。Agent 为客户端，**HTTP 长轮询取任务（挂起 ≤25s）+ 心跳（3–5s）+ 事件/结果上报**。不用 WebSocket/MQTT（P0）。

```jsonc
// ① hello（Agent 启动即报，含版本握手）
{ "type":"hello", "v":1, "deviceId":"dev-01", "serial":"XXXX",
  "agentVersion":"1.0.0", "autoX":"7.2.4", "screen":[1080,2400],
  "accessibility":true, "shizuku":"active|unavailable", "bootAt":1791449000000 }

// ② heartbeat（3–5s；带状态机）
{ "type":"heartbeat", "deviceId":"dev-01", "state":"idle|armed|primed|firing|waiting_human|done|error",
  "taskId":null, "battery":98, "charging":true, "accessibility":true, "ts":1791449000123 }

// ③ task（hub → Agent，长轮询响应；含白名单内容快照）
{ "type":"task", "taskId":"t-20261015-1930-damai-1", "platform":"damai", "mode":"attack|monitor",
  "target": { "kind":"show", "url":"https://detail.damai.cn/item.htm?id=…",
              "session":"10.15 19:30", "priceText":"内场 980", "viewers":["张三"] },
  "timing": { "fireAtEpochMs":1791500000000, "frame":"platform|ntp",
              "leadMs":40, "expireEpochMs":1791500600000 },
  "whitelist": { "version":3, "hash":"sha256:…", "items":[ /* 精简目标清单：id/场次/票档/规格 */ ] },
  "actionsPlan":"damai.v1" }

// ④ 事件（异常/中间态）
{ "type":"event", "taskId":"…", "event":"risk_challenge|page_mismatch|sold_out|reload|retry",
  "detail":{"screenshot":true}, "ts":1791500000234 }

// ⑤ 结果（先落盘 outbox，再上报；hub 按 taskId+seq 去重后转 bridge 落盘）
{ "type":"result", "taskId":"…", "seq":3,
  "outcome":"ordered|no_stock|risk_challenge|unknown|failed",
  "orderNo":"…", "evidence":"订单页可见『订单提交成功』/ 我的订单可查", "ts":1791500000567 }
```

**幂等**：端侧以 `taskId` 单次击发（已击发/已提交标记持久化，重启拒绝二次）；结果以 `taskId+seq` 去重（hub 持久化去重集，启动时扫描既有结果文件重建）。**结果语义**：读不到凭证一律 `unknown`（告警转人工，不自动重试、不自动放行）。**换绑即重置**：设备换平台/目标 → 旧任务单作废、旧 PRIMED 状态失效、控制台旧结果不再展示。

### 3.3 时间与击发（冻结版）

**帧定义（必须写死在协议里）**：

| 平台 | 权威时间源 | `frame` 标签 | 说明 |
| --- | --- | --- | --- |
| 京东 | 手机直采平台接口（候选：`functionId=serverTime` / `QueryNowTime` / 响应头毫秒戳——**三选一实测**） | `platform` | 开抢前 1 分钟复采一次 |
| 淘宝/天猫 | 无公开源 → NTP 校准 PC 帧 | `ntp` | 提前量用"相对标定法"扫出（看平台是否接受点击） |
| 大麦 | 同上 | `ntp` | 同上；且强实名场景只做彩排标定 |

**击发链路**：

```text
T-5min  任务送达 → 本地落盘（outbox-store）
T-3min  预航：打开目标页 → 场次/票档/观演人就位（模式甲）或已由人工就位（模式乙）
T-1min  对时复采（JD）／读标定表（淘/麦）；T-10s 冻结页面（禁止滑动/滚动）
T-5s    锚定：定位目标节点，双缓存 {node, (cx,cy)}；若锚定失败 → 告警 + 转人工
T-2s    复核：身份节点存在 + 目标节点可解析（不一致 → rejected，不击发）
T-0     出手：缓存节点动作优先；坐标兜底（限已登记例外的平台）；提交只发一发
T+1s    读结果：订单凭证 / 缺货 / 滑块（滑块 → 蜂鸣 + 投屏人工，转 waiting_human）
```

**末段计时规范**（防止校时跳变与线程休眠）：

```javascript
// 最后 100ms 用单调钟自旋；绝对不用 Date.now()/setTimeout() 收口
const t0 = java.lang.System.nanoTime();
const target = t0 + deltaMs * 1_000_000;      // deltaMs 已扣除 offset/lead
while (java.lang.System.nanoTime() < target) { /* busy-wait */ }
fire();                                        // 零查找出手
```

> 口径说明：本稿不承诺"<5ms"这类数字。设计目标是**消除查找与网络往返**；实际耗时逐机型/逐平台实测记录到标定表（字段：`prepare_anchor_ms / fire_call_ms / ui_transition_ms / sample_count`）。

### 3.4 一键拉起（12 步 + 降级链）

| # | 步骤 | 成功判据 | 失败降级 |
| --- | --- | --- | --- |
| 1 | 设备体检 `adb devices` | 设备在线且 boot 完成 | 提示重插/换线 |
| 2 | 唤醒+解锁 `KEYCODE_WAKEUP` + `wm dismiss-keyguard` | 屏幕亮 | 提示"充电不息屏"设置 |
| 3 | 屏幕纪律（一次性整备）：`svc power stayon true`、三项动画归零 | 设置生效 | 记入整备检查单 |
| 4 | Agent 版本检查（hello / `pm list packages`） | 版本匹配 | 推 APK（首次人工点装） |
| 5 | **adb reverse tcp:3120** | 手机侧探测 `/health` 通 | 幂等重试 3 次 → 红灯 |
| 6 | 启动脚本：`am start -n org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity -d file:///sdcard/qg-agent/main.js` | hello 到达 | 悬浮窗手动运行 → 人工就位 |
| 7 | 无障碍核验（+ 自愈三层） | `accessibility:true` | Shizuku 自愈 → adb 自愈 → 红灯 |
| 8 | 下发任务（长轮询立达） | 端侧 ack | 重推（过期作废） |
| 9 | 预热就位（深链 / adb 直驱 / 人工三选一） | 目标页就位 | 逐级降级 |
| 10 | 页面身份校验 | 目标场次/商品一致 | rejected + 告警（不击发） |
| 11 | 锚定 + 复核 | 双缓存完成 | 转人工 |
| 12 | 待命（T0 本地击发） | 结果上报 | —— |

**关键：1–9 全部发生在开抢前数分钟，不在赛点；赛点永远在手机本地。**

### 3.5 端侧 Agent 结构与适配器合同

```text
platforms/app/agent/            # 部署到 /sdcard/qg-agent/（adb push）
├─ main.js                      # 入口：拉起 bootstrap
├─ bootstrap.js                 # 环境检查（无障碍/App/存储权限/版本握手）
├─ transport.js                 # 长轮询取任务 + 心跳 + outbox 重传 + 断线重连
├─ task-store.js                # 任务单持久化（断电/重启不丢）
├─ scheduler.js                 # 单调钟倒计时 + busy-wait + 状态机
├─ executor.js                  # 锚定/复核/出手/读结果（通用骨架）
├─ result-store.js              # outbox.jsonl（COMMITTED 语义）
├─ watchdog.js                  # 自检 + 异常回安全态
└─ adapters/                    # 平台适配器（业务规则只在这里）
   ├─ damai.js  · taobao.js  · jd.js  · monitor.js
```

**适配器七函数合同**（沿用 D4 骨架，融合 D5 技法）：

```text
prepare(t)   → 预航：页面就位、场次/票档/规格/观演人选择
preflight(t) → 页面身份校验（不通过即拒绝）
prime(t)     → 锚定目标节点（node + 坐标双缓存）
fire(t)      → 出手（缓存节点优先 / 坐标兜底 + 守卫）
readResult(t)→ 读凭证（订单号 > 页面状态 > unknown）
recover(e)   → 从异常回安全态（不盲点、不死循环）
snapshot()   → 标定数据采集（时延/锚定耗时/成功率）
```

**P0 最小实现集**：main/bootstrap/transport/scheduler/executor/result-store + **一个平台适配器（京东）**；watchdog、其余适配器随阶段补齐。版本分发：`adb push` 新版本目录 → hub 发 `reload` 事件 → 脚本自退 → hub 重跑 intent（脚本版本号在 hello 里握手，不匹配拒发任务）。

### 3.6 自愈与保活（三层 + 人工）

```text
① 手机内：AutoX 前台服务 + 开机自启（BOOT_COMPLETED 接收器已源码核实）
   → 进程被杀/手机重启后自动回来，恢复 task-store 并重排倒计时
② Shizuku 通道：AutoX v7 原生集成（shizuku("input tap x y")）
   → 无障碍被系统回收时的第二注入通道 + 自愈辅助
③ PC 侧 adb 自愈（hub 看门狗）：心跳失联 >30s 且处于 armed/窗口期 →
   adb shell settings put secure enabled_accessibility_services \
     org.autojs.autoxjs.v7/com.stardust.autojs.core.accessibility.AccessibilityService
   adb shell settings put secure accessibility_enabled 1   （组件名已源码核实；各 ROM 有差异，实测为准）
④ 全部失败 → 红光告警 + 语音/蜂鸣提示人工接管
```

**看门狗约束**：自动重拉仅在"已布防或开售窗口内"执行，避免平时打扰；重拉动作全量记日志（谁、何时、第几次）。

### 3.7 平台适配要点（含"必须先实测"清单）

| 平台 | 要点 | 实测项（未过不许自动击发） |
| --- | --- | --- |
| 大麦 | 强实名：观演人事先录入、一证一票；详情→场次→票档二级面板；确认页勾人 | ① 详情页/确认页节点覆盖率 ② Activity 名与深链（社区提及的 `ProjectDetailActivity` 等**均为未核实项**）③ 观演人勾选定位 |
| 淘宝/天猫 | 双模式：购物车结算 / 详情立即购买；resource-id 动态混淆 → 多级查找 + `desc` 兜底；核对"结算/提交"文案两端变化 | ① 购物车与详情两路径彩排 ② 混淆 ID 下的定位健壮性（同页 3 次重进成功率） |
| 京东 | 预约制（未预约无购买权限，T-30 巡检预约状态）；BP 直达链路 `p.m.jd.com/norder/order.action?wareId=…` 为**候选**待实测；对时接口三选一 | ① serverTime 候选接口 ② BP 链接是否被 App 接起 ③ 预约标记读取 |
| 监控（P0a） | 只读巡检"缺货登记/已售罄/立即购买"状态跃迁；**频率纪律：10–30s + 退避；仅 T-2min~T+1min 加密到 ≤2Hz；绝不 0.2s 级别轮询** | 状态文案字典（三平台各 1 组） |

---

## 4. 标定门禁与验收（模式分档）

**模式乙（人工就位 + 脚本击发）必过 5 项**：①无障碍存活 + 自愈三层演练 ②timing/lead 标定表（含 JD 对时源选定）③页面身份校验逻辑 ④**Shizuku 兜底通道实测**（激活、`shizuku("input tap …")` 成功率与时延）⑤单机干跑（mock 任务全流程）。

**模式甲（全自动拉起）追加 5 项**：⑥intent 启动组件真机回归（本稿已源码级核到 `org.autojs.autoxjs.v7/…RunIntentActivity`，仍需真机确认）⑦存储权限（MANAGE_EXTERNAL_STORAGE，已源码核实需授权）⑧深链/导航三平台到达验证 ⑨锁屏/省电白名单实战（挂机 30 分钟不杀）⑩**杀进程/手机重启恢复**（≤30s 自动回线并恢复任务）。

**彩排与负样本**：每平台 2 场（模式乙→模式甲），止步支付页（免密关闭）。负样本：①售罄页面（判定 `no_stock` 不误报成功）②超时/断连（拔线后仍按时击发）③重复任务单（拒绝二次击发）④换绑重置。风控页不刻意制造；其判定逻辑用 mock 页单测覆盖。**lead 标定靶**：冷门可下单目标（下单→取消，不付款），观测量 = "点击被接受"的端到端时延分布；这不是循环——标定阶段允许成单后取消，比赛阶段才禁二次下单。

---

## 5. 分阶段落地

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P0-0 引擎冻结验证**（1–2 天，D6 修正采纳） | 真机三验证：①intent 启动组件实测（本稿已源码级核到组件全名，仍需真机回归）②存储权限（MANAGE_EXTERNAL_STORAGE 读 /sdcard 脚本）③Shizuku 自愈；+ u2 侦察首图 | 三项全过 → 引擎正式冻结；任一失败 → AutoJs6 移植评估（Plan B，选择器 API 同源） |
| **P0a 监控通道**（先行） | hub + Agent + 通道 + 监控适配器 + 设备页 + 告警；**交易零副作用** | 冷门演出/商品状态变化能被监控到并落盘；断线告警；连跑 24h |
| **P0b 击发通道** | 标定 5 项 + 彩排（含负样本）+ 京东→大麦→淘宝 逐平台解锁 | 每平台 2 场彩排通过；负样本判定 4/4；断连对照通过 |
| **P1 全自动** | 拉起 12 步全自动 + 对账提醒 + 拉起成功率统计 | 拉起成功率 ≥95%（两周日志）；对账与订单一致 |
| **P2 多机** | USB Hub 多机；hub 单点可靠性；**拆机/杀 hub 隔离演练**；开火抖动窗口（**先减去各机 offset 再统计**）；adb 大操作避开窗口期；ws-scrcpy 内嵌评估 | 8 机演练：单机掉线不影响其余；抖动统计口径复核 |

---

## 6. 安全、合规与纪律（红线）

1. **不碰协议层**：不构造/重放请求，不逆向签名（x-sign/无线保镖/SecSdk）；一切动作由 App 前台 UI 自身发起。
2. **白名单铁律**：只有配置清单内的目标可被操作；命不中即拒绝、不兜底。
3. **验证码转人工**：滑块/点选 → 告警 + 投屏，人工 1 秒级接管；禁止打码破解。
4. **频率纪律**：非窗口期低频 + 退避；窗口期"提交只发一发、绝不重试连发"；绝不沿用社区"多进程并发提交"。
5. **行为拟人化**：滑动走曲线、多机开火带随机抖动、单账号单设备、同设备不频繁切换高价值账号。
6. **数据**：观演人/身份证信息只在 `data/` 本地，随 `.gitignore` 排除；日志不打印证件号。
7. **GPL 边界**：AutoX.js（GPL-2.0 + 上游 MPL 非商业条款）用于本机非商业自用；**不对外分发** Agent 脚本/打包产物；未来商业化前重审运行时选型。
8. **不承诺存活率**：任何方案都无法保证账号/设备"必然存活"；用独立小号灰度先行。

---

## 7. 本稿相对六份文档的"吸收 / 修正"清单

| 来自 | 吸收 | 修正/拒绝 |
| --- | --- | --- |
| D1 | 控制面/执行面分离；真机优先 | 拒绝其含糊的通道方向与秒级对时 |
| D2 | 协议/幂等/outbox/标定门/监控先行/双模式/事实核实流程 | 修正白名单为"内容+版本+哈希"；补坐标守卫；明确 hub 进程与"产线零改动"策略 |
| D3 | 审查诚实度；deep link 未核实即门禁；成本账；多机抖动概念 | 拒绝 u2 主路线与自研 APK 优先（前提已纠：AutoX 有活跃延续仓；该稿作者亦已公开勘误）；吸收其"被抑制发现"写法（本稿不藏低置信度项） |
| D4 | 适配器七函数合同；状态机；许可证决策；冻结规则 | 修正端口矛盾（统一 :3120）；补标定门/监控先行/自愈；其残留 `citeturn…` 裸引用标记不采信（引用可靠性低） |
| D5 | 锚定+零查找击发；Shizuku+adb 自愈；拟人化清单；单机落地步骤 | 压实"<5ms"为实测口径；坐标击发补守卫；其平台断言统一转入实测清单 |
| D6 | 引擎冻结条件化（P0-0 三验证后冻结，Plan B=AutoJs6）；"u2=仪器不是第二引擎"定调；`monkey -p` 冷启兜底（未核实组件名的 App）；Pactum7 猫眼/纷玩岛顺风车验证（P0a 可选项）；查证优先作风 | 端口口径统一 :3120（其 §4 残留 :3100 笔误不采纳）；平台顺序主张与本文推荐并列列拍板 |

---

## 8. gstack 工程审查报告（第 2 轮）

> 审查对象：本工作稿《APP端抢购终极技术方案（WorkBuddy 终版）》。
> 执行方式：gstack `plan-eng-review` 规程（会话起步检查通过；遥测按配置关闭）；网络核实走宿主检索工具 + GitHub API 实时查询 + 仓库源码原文读取；**独立评审**=宿主内独立子代理（本机无 Claude Code/Codex 外部 CLI，降级替代，如实标注）。
> 结论先行：**条件冻结**——P0-0 三验证通过后正式冻结（D6 修正采纳，Plan B=AutoJs6）；附 2 项待用户拍板（见文末）。独立评审 10 条发现中 6 条"必须修正"已全部落入本稿，1 条（hub 内嵌）经复核后**部分保留分歧**（见下表 F1 处置）。

### 8.1 审查发现与处置

| # | 级别 | 发现（评审原文摘要） | 处置 |
| --- | --- | --- | --- |
| F1 | P1 | 单机 P0 阶段 hub 独立进程净增复杂度；"重启解除布防"理由在"手机自主"原则下不成立（已实测 bridge 无设备内存态） | **部分采纳**：理由重构为"产线隔离 + 变更节奏"（华为线零改动）；成本以"零改 bridge + 复用启动器/保活模式"缓释；保留"并回 bridge"的回退路径。分歧已在 §2-B 明示 |
| F2 | P1 | "bridge 不动/单一写者"是伪命题：去重与设备页访问必然要求改 bridge | **采纳（设计解）**：去重落 hub（生命周期状态属主）；设备页由 hub 自服务；配置读/结果写复用 bridge **既有**接口 → bridge 现有代码零修改（仅工作台加一行链接）。措辞已修正 |
| F3 | P1 | 手机自主的前提是脚本活着；杀进程/重启/厂商省电未处理 | **采纳**：三层自愈 + P0b 门禁第 ⑩ 项（杀进程/重启恢复 ≤30s）+ 看门狗（窗口期限定） |
| F4 | P1 | 白名单 hash 无法判成员 | **采纳**：内容快照 + 版本 + 哈希（裁决 C） |
| F5 | P1 | 淘宝/大麦无公开时间源；`fireAt` 帧未定义 | **采纳**：按平台分帧 + 相对标定法 + 帧标签（裁决 E） |
| F6 | P0 | 引擎单点：无障碍开火瞬间失效即哑火；自研 APK 启动条件太晚 | **采纳**：Shizuku 兜底通道**列为门禁必过项**（不等实战）；自研 APK 降为"Shizuku 不可用时的 PoC 备选" |
| F7 | P1 | 坐标兜底与"身份校验"矛盾，重开盲点洞 | **采纳**：节点优先；坐标兜底需"冻结+复核+登记例外"三守卫；未登记平台坐标路径转人工 |
| F8 | P2 | P0a"只读=低风险"是误判；监控频率纪律丢失 | **采纳**：改为"交易零副作用"表述；补回 10–30s+退避频率纪律 |
| F9 | P2 | 门禁未按模式分档；lead 标定自指循环；负样本未定义 | **采纳**：模式乙/甲分档门禁；标定靶与观测量定义；负样本清单（§4） |
| F10 | P2 | 多机共因失效、hub 单点、抖动统计口径 | **采纳**：并入 P2（隔离演练、hub 可靠性、offset 减法口径） |

### 8.2 测试覆盖（待实现，全部要求"对照组"）

```text
[GAP×12] 通道断连重连 | intent 启动真机回归 | 杀进程恢复 | 手机重启恢复
         对时精度分布实测 | 断连仍击发(对照) | lead 标定 | Shizuku 兜底实测
         幂等(重复/过期任务) | 白名单拒/放行(对照) | 负样本判定 | 换绑重置(零副作用自测)
COVERAGE: 0/12 已测（P0 实现后逐项补齐）
```

### 8.3 完成摘要

- 审查轮次：第 2 轮（第 1 轮结论已并入前稿与本稿）；范围：全量（未按建议收窄 hub，已明示分歧）
- 发现：架构 4 / 代码质量 3 / 性能 2 / 测试缺口 8（映射见上）
- 独立评审：10 条（6 条必须修正已落稿，4 条部分/设计化解）
- 增量修订（v5）：并入 D6（ZCode-GLM 终版）对比与采纳点（冻结条件化 / `monkey -p` 冷启兜底 / Pactum7 顺风车可选项）；端口口径统一 :3120；不影响上述审查结论
- 未决关键缺口：0（2 项业务侧待拍板见文末）

---

## 9. 查证记录（可复验）

| 断言 | 证据 | 落盘/复验方式 |
| --- | --- | --- |
| AutoX 延续仓 = aiselp/AutoX（★1898，pushed 2026-10-05，`fork=true, parent=kkevsekk1/AutoX`） | GitHub API 实时查询（16:40） | `verify/tmp/oss-repos.json` + 附录命令 |
| 最新版本 v7.2.4（2026-10-03），资产 `Autox-v7-arm64-v8a-release-v7.2.4.apk`(145MB) / `v7_mini`(107MB) | GitHub Releases API | 同上 |
| 启动组件 = `org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity`（v7 flavor `applicationIdSuffix=".v7"`；组件读 `intent.getData()` 并执行 file:// 脚本） | 仓库源码：`app/build.gradle.kts`、`AndroidManifest.xml`、`RunIntentActivity.java`（51 行，已存档） | `verify/tmp/autox-runintent-sample.java` |
| 无障碍服务组件 = `com.stardust.autojs.core.accessibility.AccessibilityService`；BOOT_COMPLETED 接收器存在；MANAGE_EXTERNAL_STORAGE 已声明 | `autojs/src/main/AndroidManifest.xml`、`app/src/main/AndroidManifest.xml` | 附录命令 |
| kkevsekk1/AutoX=404；autox-community/AutoX_aiselp 仅 ★6（D4 引用不佳）；uiautomator2 ★8414 MIT 活跃 | GitHub API（16:40–17:00） | `verify/tmp/oss-repos.json` + `oss-repos-addendum.json` |
| 参考生态：Guyungy/damaihelper ★4215(2026-08)；shiyutim/tickets ★3403(2026-09)；currycan/HaTickets ★477(2026-07, Apache-2.0, "Mobile(U2)/Desktop(Tauri+Rust)")；Pactum7/ticket-grabbing ★1950(2026-07)；RookieTree 停更；Hamibot OSS 仓 2023-11 后未更 | GitHub API 实时查询 | `verify/tmp/oss-repos-addendum.json` |

> 复验命令（摘）：`curl -s https://api.github.com/repos/aiselp/AutoX | jq '{fork,parent:.parent.full_name,stars:.stargazers_count,pushed_at}'`；源码：`https://raw.githubusercontent.com/aiselp/AutoX/setup-v7/app/src/main/java/org/autojs/autojs/external/open/RunIntentActivity.java`

---

## 10. 实施任务清单（T1–T13）

- [ ] T1（P0）设备整备 + 标定表 v1：按 §3.4/§4 逐项实测（含 intent 真机回归、Shizuku 兜底、对时源三选一），产出《标定报告》
- [ ] T2（P0）device-hub :3120 骨架：注册/心跳/长轮询/派发/结果转发（经 bridge 既有接口）+ 去重持久化 + `verify/verify-device-hub.mjs`（含白名单拒/放行对照）
- [ ] T3（P0）Agent 最小集：main/bootstrap/transport/scheduler/executor + `/sdcard/qg-agent` 分发 + 版本握手
- [ ] T4（P0）设备页（hub 提供）：设备卡片/状态/拉起/派发/告警灯；工作台加一行入口
- [ ] T5（P0）监控适配器 + P0a 闭环（频率纪律写进代码常量）
- [ ] T6（P0）时间与击发：对时模块 + 单调钟 busy-wait + 锚定/复核/出手 + 断连对照用例
- [ ] T7（P0）京东适配器：预约巡检 + BP 候选实测 + 结算链路彩排（模式乙→甲）
- [ ] T8（P0）大麦适配器：场次/票档/观演人 + 负样本彩排
- [ ] T9（P1）淘宝适配器：购物车/详情双模式彩排
- [ ] T10（P0）拉起 12 步整合 + 逐级降级 + 成功率统计
- [ ] T11（P0）自愈三层 + 看门狗（窗口期限定）+ 杀进程/重启恢复演练
- [ ] T12（P1）投屏接管联动（QtScrcpy 常开 + risk_challenge 蜂鸣置顶）
- [ ] T13（P1）对账提醒 + 运行手册（点击路径版）

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | — | Scope & strategy | 0 | — | —（方向已由用户拍板） |
| Outside Review | 独立子代理（宿主内，降级替代） | Independent 2nd opinion | 2（两轮合计） | completed | 本轮 10 条：6 必须修正已落稿 / 4 部分采纳（F1 保留分歧） |
| Eng Review | /plan-eng-review | Architecture & tests (required) | 2 | ISSUES MAPPED | 架构 4 / 质量 3 / 性能 2 / 测试缺口 8；全部映射为设计或任务 |
| Design Review | — | UI/UX gaps | 0 | — | not run（设备页为实现后评估） |
| DX Review | — | Developer experience gaps | 0 | — | not run |

- **OUTSIDE COVERAGE:** 宿主内独立子代理（本机无 Claude Code / Codex 外部 CLI，降级替代），phase=plan-review，completed，10 findings。
- **VERDICT:** **条件冻结** —— 六份方案的互斥点已全部裁决并有实测依据；6 条必须修正项已落入本稿；正式冻结 = P0-0 三验证通过（D6 修正采纳）；工程侧无阻断项，可进入 P0-0/P0a 实施。
- **UNRESOLVED DECISIONS:**
  - U1 首批解锁"自动击发"的平台顺序：本稿推荐 **京东 → 大麦 → 淘宝**（首弹风险最小：流程最直白、对时源候选最多）；备选 **大麦 → 京东 → 淘宝**（ZCode-GLM 主张：价值最高 + 表单式流程 + Pactum7 猫眼同类验证）；两方一致：**淘宝最后**。
  - U2 GPL/非商业边界确认：AutoX.js 采用 GPL-2.0（+上游 MPL 非商业条款），本稿按"本机非商业自用、不对外分发"处理；若未来商业化/分发，须重审运行时选型。
