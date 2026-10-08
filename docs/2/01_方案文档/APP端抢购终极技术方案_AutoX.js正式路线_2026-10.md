# APP端抢购终极技术方案：AutoX.js 正式路线

版本：2026-10-v2（终版技术方案）  
日期：2026-10-08  
定位：基于现有 PC 抢购控制台，新增 Android 真机执行面；**AutoX.js v7 为正式端侧自动化运行时**。

---

## 1. 最终技术决策

本方案不再保留“uiautomator2 主路线 / AutoX.js 备选路线”这种双主架构，统一为：

> **Node 控制台 + device-hub + ADB + AutoX.js v7 + scrcpy + Android 真机**

职责固定：

| 组件 | 正式职责 |
|---|---|
| Node 控制台 | 任务配置、平台配置、设备管理、调度、结果、告警、日志 |
| `device-hub` | PC 与 Android 设备之间的设备编排、任务下发、心跳、状态管理 |
| ADB | 设备发现、安装/启动、端口转发、基础系统控制 |
| **AutoX.js v7** | **手机端正式执行引擎：读取 UI、等待页面状态、点击/滑动、定时执行、截图、上报结果** |
| scrcpy | 手机画面监控、人工接管、故障排查 |
| Android 真机 | 正式执行环境 |

AutoX.js v7 当前公开仓库仍在维护，README 明确定位为 Android JavaScript 自动化运行环境，提供无障碍自动操作、控件选择器、脚本执行，并在 v7 增加 Node.js 引擎、TypeScript、Shizuku 等能力。citeturn602228search0turn602228search3

### 为什么最终选 AutoX.js

它最适合当前阶段的原因不是“理论上最快”，而是：

1. **端侧执行完整**：不需要每一次点击都由 PC 远程驱动。
2. **JavaScript 开发效率高**：项目主要逻辑可以直接写成可版本管理的脚本。
3. **控件选择器成熟**：比纯坐标脚本更容易适应分辨率变化。citeturn602228search0
4. **可以把关键时刻逻辑放到手机本地**，避免 PC→手机临界指令传输抖动。
5. 与现有 Node/网页控制台形成清晰的“PC 决策、手机执行”分层。

`uiautomator2` 不再作为生产主执行引擎。它可以保留为独立测试工具，但不进入正式热路径；其当前项目为 MIT，并采用“手机 HTTP 服务 + Python 客户端”的结构。citeturn602228search2turn602228search7

---

## 2. 总体架构

```text
                           Windows PC
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Web 控制台                                                  │
│  ├─ 任务配置                                                 │
│  ├─ 平台/商品白名单                                          │
│  ├─ 设备面板                                                 │
│  ├─ 运行状态                                                 │
│  └─ 告警/结果                                                │
│                                                              │
│  grab-bridge :3100                                           │
│       │                                                      │
│       └── device-hub :3120                                  │
│             ├─ 设备注册                                      │
│             ├─ 心跳                                          │
│             ├─ 任务下发                                      │
│             ├─ 结果接收                                      │
│             ├─ 设备健康检查                                  │
│             └─ 时间同步/任务时间轴                           │
│                                                              │
│  ADB / scrcpy                                                │
└───────────────┬──────────────────────────────────────────────┘
                │ USB 优先
                │ adb reverse
                ▼
┌──────────────────────────────────────────────────────────────┐
│                     Android 真机                             │
│                                                              │
│  AutoX.js v7                                                 │
│  ├─ Agent 主循环                                             │
│  ├─ Task Runner                                              │
│  ├─ UI State Detector                                        │
│  ├─ Scheduler / Local Timer                                  │
│  ├─ Result Reporter                                          │
│  └─ Local Outbox                                             │
│                                                              │
│  目标 APP                                                     │
│  ├─ 大麦                                                     │
│  ├─ 淘宝 / 天猫                                              │
│  ├─ 京东                                                     │
│  └─ 后续其他高价值 APP                                       │
└──────────────────────────────────────────────────────────────┘
```

### 核心原则

> **PC 负责“决定做什么”，手机负责“什么时候执行以及怎么执行”。**

PC 不在临界时刻临时发出一次点击指令；任务必须在开售前提前送达手机，并在手机本地完成最终定时执行。

---

## 3. AutoX.js 端侧 Agent

### 3.1 Agent 不是一个“大脚本”

正式结构拆成模块：

```text
agent/
├─ bootstrap.js
├─ transport.js
├─ task-store.js
├─ scheduler.js
├─ ui-state.js
├─ executor.js
├─ result-store.js
├─ health.js
├─ watchdog.js
└─ platforms/
   ├─ damai.js
   ├─ taobao.js
   └─ jd.js
```

### 3.2 各层职责

**bootstrap**

- 检查 AutoX 无障碍服务
- 检查目标 App 是否安装
- 检查 Agent 配置
- 启动心跳与任务通信

**transport**

- 与 PC `device-hub` 通信
- 获取任务
- 上报心跳、事件、结果
- 断线重连

**task-store**

- 本地持久化当前任务
- 防止断电/进程重启导致任务单丢失

**scheduler**

- 维护任务状态
- 本地倒计时
- 到点触发 executor

**ui-state**

- 当前 APP/页面判断
- 目标商品/场次身份确认
- 页面异常识别

**executor**

- 执行平台 Adapter 定义的动作
- 以控件选择器为主
- 坐标为必要时的最后一级兜底

**result-store**

- 结果先本地落盘
- 上报成功后再标记完成

**watchdog**

- Agent 自检
- 长时间无响应时恢复到安全状态

---

## 4. PC ↔ Android 通讯方案

### 正式方案：ADB Reverse + HTTP 长轮询

不使用 WebSocket、MQTT、第三方云消息系统作为 P0 主链路。

```text
Android
127.0.0.1:3100
       │
       │ adb reverse
       ▼
PC
127.0.0.1:3100
```

手机访问自己的 `127.0.0.1:3100`，实际进入 PC 上的桥接服务。

这样有三个优势：

- 不新增局域网服务端口
- 不依赖公网
- 断线与重连逻辑简单

### 任务不是“到点再发送”

任务提前几分钟送达：

```text
PC
↓
任务单
↓
Android 本地保存
↓
等待开售
↓
本地计时
↓
AutoX executor
↓
APP UI 操作
```

因此 PC 即使在最终几百毫秒阶段发生短暂抖动，也不会直接导致关键动作丢失。

---

## 5. 任务协议

统一 JSON。

### 下发任务

```json
{
  "taskId": "task-20261008-001",
  "platform": "damai",
  "target": {
    "type": "event",
    "id": "EVENT_ID",
    "url": "APP_OR_WEB_TARGET"
  },
  "rule": {
    "ticket": ["内场", "看台"],
    "quantity": 1,
    "viewerIds": ["viewer-001"]
  },
  "fireAt": 1791449000000,
  "expiresAt": 1791449060000,
  "mode": "dry|armed|manual_prepare",
  "whitelistVersion": "sha256:xxxx"
}
```

### 心跳

```json
{
  "type": "heartbeat",
  "deviceId": "android-001",
  "state": "idle|armed|firing|waiting_human|done",
  "taskId": null,
  "ts": 1791449000123
}
```

### 结果

```json
{
  "type": "result",
  "taskId": "task-20261008-001",
  "outcome": "success|no_stock|waiting_human|unknown|failed",
  "evidence": {
    "orderNo": null,
    "pageState": "confirmed"
  },
  "seq": 3,
  "ts": 1791449000567
}
```

---

## 6. 任务状态机

```text
CREATED
  ↓
READY
  ↓
ARMED
  ↓
PRIMED
  ↓
WAITING_FIRE
  ↓
FIRING
  ├── SUCCESS
  ├── NO_STOCK
  ├── WAITING_HUMAN
  ├── UNKNOWN
  └── FAILED
```

### 强制规则

1. 一个 `taskId` 只能击发一次。
2. `expiresAt` 到期后拒绝击发。
3. 设备重新绑定平台或目标时，旧 `PRIMED` 状态立即失效。
4. 结果不确定就上报 `UNKNOWN`，不得自行猜测成功。
5. `WAITING_HUMAN` 不等于失败，人工处理后可以继续。

---

## 7. AutoX.js 的页面执行标准

### 7.1 查找优先级

```text
1. resource-id
2. text / textContains
3. className + text 组合
4. desc / contentDescription
5. 坐标兜底
6. 截图/图像识别仅作必要兜底
```

### 7.2 每一步都必须有成功判据

错误方式：

```text
click()
sleep(1000)
click()
sleep(1000)
```

正确方式：

```text
click target
↓
等待目标状态出现
↓
验证成功
↓
进入下一步
```

也就是说 Adapter 是**状态驱动**，不是“固定睡眠驱动”。

### 7.3 页面改版必须快速失败

发现：

- 目标商品/场次身份不一致
- 票档不存在
- 页面结构重大变化
- 登录失效
- 验证状态异常

立即：

```text
停止自动动作
↓
记录截图 + 页面状态
↓
告警
↓
WAITING_HUMAN / FAILED
```

禁止在未知页面上盲点。

---

## 8. 时间系统

时间系统采用两级结构：

### PC：统一调度时钟

负责：

- 任务时间轴
- 开售时间配置
- 设备同步
- 任务提前布防

### Android：最终执行时钟

AutoX Agent 收到任务后，将执行时间转换成本地单调计时逻辑，最终等待不依赖 PC 临时命令。

### 时间校准

平台时间必须通过实际可验证的来源校准。不同平台分别建立 `timesync-probe`：

```text
NTP
+
平台页面/响应时间信息
+
多次采样
+
实际演练结果
```

不得把某个固定“提前 40ms/80ms”之类的数字当成通用常数。每个平台、设备、网络环境都必须通过测试确定参数。

最终保存：

```text
platform
measure_time
offset_p50
offset_p95
offset_p99
lead_ms
sample_count
```

---

## 9. 一键启动链路

控制台点击一次“准备任务”：

```text
1. 检查设备在线
2. 检查系统已启动
3. 检查 AutoX.js / Agent
4. 检查无障碍服务
5. 检查目标 APP 安装与版本
6. 建立 adb reverse
7. 启动 Agent
8. Agent 回报在线
9. 下发任务
10. 目标 APP 预热
11. 页面身份校验
12. 进入待命
```

### 启动设计原则

不要把 undocumented Activity / Scheme 当成固定依赖。

因此：

- AutoX 启动入口先做真机标定
- 大麦/淘宝/京东 deep link 逐平台维护
- deep link 失效时自动降级到普通 APP 启动 + UI 导航
- 不因某个 deep link 失效而阻塞整个平台

---

## 10. 平台 Adapter 设计

统一接口：

```text
prepare(task)
preflight(task)
prime(task)
fire(task)
readResult(task)
recover(error)
```

### 示例：大麦

```text
prepare
→ 启动 APP
→ 确认登录
→ 确认观演人
→ 进入目标项目
→ 进入目标场次
→ 选择票档
→ 停在临界位置

fire
→ 执行最终必要 UI 动作

readResult
→ 读取订单/结果页面
```

### 示例：淘宝 / 天猫

```text
prepare
→ 登录状态
→ 目标商品身份
→ SKU 白名单
→ 规格选择
→ 进入结算前状态

fire
→ 立即购买/确认等必要 UI 动作

readResult
→ 读取订单结果
```

### 示例：京东

同上，但商品定位、SKU、库存与结算步骤由 JD Adapter 独立维护。

Adapter 只表达平台业务规则，不把大麦/淘宝/京东的具体页面逻辑写进通用 Agent。

---

## 11. 真机与模拟器

### 正式执行

> **Android 真机作为正式执行环境。**

### 模拟器

仅用于：

- AutoX API 开发
- UI 控件定位
- 页面流程彩排
- Mock 任务
- 非真实账号测试

不把模拟器作为高价值正式任务的主要执行环境。

### 真机配置标准

单台设备：

```text
1 个 Android 环境
+
稳定的 AutoX Agent
+
明确绑定的执行槽位
```

未来扩容：

```text
1 台 PC
↓
USB Hub
↓
多 Android 真机
↓
device-hub 统一调度
```

不要求“一账号永久占一台设备”，但**同一时刻一个设备只执行一个账号任务，账号会话必须隔离**。

---

## 12. 账号与执行环境

推荐模型：

```text
Account
   ↓
Persistent Account Profile
   ↓
Execution Slot
   ↓
Android Device
   ↓
AutoX Agent
```

### Web 与 App 的区别

Web：

```text
Account → Browser Profile
```

App：

```text
Account → App Session / Device Slot
```

设备资源可以调度，但不要在同一 APP 会话里高频切换不同账号。

正式系统的目标是：

> **会话隔离、任务隔离、状态可追踪，而不是依赖频繁变换环境解决平台限制。**

---

## 13. 人工接管

人工接管是一等能力，不是异常补丁。

触发条件：

- 验证码
- 滑块
- 短信确认
- 登录确认
- 页面无法确定
- 需要人工支付

流程：

```text
AutoX
 ↓
WAITING_HUMAN
 ↓
scrcpy 投屏
 ↓
人工操作
 ↓
AutoX 恢复
 ↓
继续任务 / 结束任务
```

AutoX 不实现验证码破解、验证码轨迹生成或绕过验证逻辑。

---

## 14. 监控与故障恢复

### 设备状态

```text
ONLINE
IDLE
ARMED
PRIMED
FIRING
WAITING_HUMAN
ERROR
OFFLINE
```

### Agent 自恢复

允许：

- Agent 线程恢复
- HTTP 重连
- outbox 重传
- 页面回退到已知安全状态
- 目标 APP 正常重启

不允许：

- 未知页面盲点
- 同一任务无限重试
- 同一任务重复提交
- 通过更换账号/IP/指纹规避平台限制

---

## 15. 幂等与数据一致性

### 手机端

本地：

```text
current-task.json
outbox.jsonl
result.jsonl
```

### PC 端

数据库/JSONL 至少保存：

```text
taskId
deviceId
accountId
platform
state
fireAt
startedAt
finishedAt
result
attemptNo
evidence
```

### 幂等规则

```text
taskId + actionSeq
```

作为端侧重复执行保护键。

桥接端：

```text
taskId + seq
```

作为结果去重键。

---

## 16. 安全与许可证正式决策

### AutoX.js 作为当前阶段正式技术栈

当前项目定位为**非商业学习/研究项目**，因此 AutoX.js v7 正式纳入 Android 执行技术栈。

AutoX.js 官方仓库 README 明确说明其代码来源于 Auto.js，并要求同时遵循 GPL-2.0 与上游 MPL-2.0 + 非商业性使用要求。citeturn602228search0

因此项目当前阶段的技术定位固定为：

> **AutoX.js v7 = Android 端正式运行时。**

未来一旦项目转为商业使用、对外收费或分发涉及 AutoX 衍生程序的组件，必须重新进行许可证审查并决定授权、替代运行时或其他合规方案。

### 代码边界

本项目自己的业务脚本与 AutoX 运行时保持目录/依赖边界，不直接复制其内部实现代码。

---

## 17. 开发顺序

### Phase 0：单机基础链路

```text
AutoX 安装
→ 无障碍
→ Agent 启动
→ adb reverse
→ 心跳
→ 任务获取
→ 本地保存
→ 结果上报
```

验收：设备在线 30 分钟无异常，断线后可自动恢复通信。

### Phase 1：AutoX UI 引擎

完成：

- selector
- 页面状态机
- click/wait
- screenshot
- watchdog
- outbox

验收：使用 Mock App / 测试页面完整执行。

### Phase 2：大麦 Adapter

先做：

```text
登录态检测
→ 目标项目定位
→ 场次定位
→ 票档定位
→ 页面预航
→ dry-run
```

通过后再进入真实购买链路。

### Phase 3：淘宝 / 天猫 Adapter

先做：

```text
商品定位
→ SKU 白名单
→ 规格选择
→ 结算前
→ dry-run
```

### Phase 4：京东 Adapter

同样走：

```text
商品定位
→ SKU
→ 结算前
→ dry-run
```

### Phase 5：设备扩容

单机稳定以后再加入：

```text
USB Hub
→ 多真机
→ device-hub 多设备调度
→ 多任务并发
```

---

## 18. 测试标准

### AutoX Agent

必须通过：

- 启动测试
- 无障碍服务测试
- 控件定位测试
- 页面状态机测试
- 断线重连测试
- 任务恢复测试
- 结果幂等测试
- 重启恢复测试

### 平台 Adapter

每个平台至少覆盖：

```text
正常页面
登录失效
目标不存在
库存不足
页面改版
验证挑战
断网
APP 崩溃
任务过期
重复执行
```

### 真实平台测试

真实平台只进行必要的少量 Smoke Test。

大规模性能/并发测试使用 Mock 环境完成，不通过循环制造真实订单来做压力测试。

---

## 19. 开源组件裁决

| 项目 | 结论 |
|---|---|
| **AutoX.js v7** | **正式端侧运行时** |
| ADB | 正式设备控制与通道工具 |
| scrcpy | 正式监控/人工接管工具 |
| uiautomator2 | 测试/研究工具，不进入生产主热路径 |
| MQTT | P0 不需要 |
| 云手机 | 不作为主路线 |
| 模拟器 | 仅开发/彩排 |
| 协议直刷/抓包重放 | 不纳入 |
| 验证码破解 | 不纳入 |

---

## 20. 最终架构结论

最终正式技术栈固定为：

```text
                    PC
┌─────────────────────────────────────┐
│ Web Console                         │
│      ↓                              │
│ grab-bridge                         │
│      ↓                              │
│ device-hub                          │
│      ↓                              │
│ ADB / adb reverse                   │
└──────────────┬──────────────────────┘
               │ USB
               ▼
┌─────────────────────────────────────┐
│ Android 真机                        │
│                                     │
│ AutoX.js v7                         │
│   ↓                                 │
│ Agent                               │
│   ↓                                 │
│ Platform Adapter                    │
│   ↓                                 │
│ 淘宝 / 京东 / 大麦 / 后续平台        │
│                                     │
│ scrcpy ← 人工监控/接管              │
└─────────────────────────────────────┘
```

一句话：

> **AutoX.js 负责“手机上怎么执行”，device-hub 负责“哪台手机什么时候执行什么任务”，ADB 负责“怎么可靠地管理手机”，scrcpy 负责“人怎么接管”。**

这四层职责不要再互相替代，也不要再同时维护两套 Android 自动化主引擎。

---

## 21. 本方案的冻结规则

除非真实测试出现明确的 P0 硬问题，否则不再重新选择 Android 主运行时。

后续优化只能发生在：

```text
Adapter
调度
性能
稳定性
测试
设备管理
```

而不是再次推倒 AutoX / uiautomator2 / Appium 的技术选型。

---

## 参考资料

1. AutoX.js v7 GitHub / README  
   https://github.com/autox-community/AutoX_aiselp
2. uiautomator2 GitHub  
   https://github.com/openatx/uiautomator2
3. scrcpy GitHub  
   https://github.com/Genymobile/scrcpy
