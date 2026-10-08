# 华为抢购：URL 驱动的 SKU 采集 + 控制台

这一层**独立可运行**：爬虫、插件、控制台各自都能单跑。

---

## 零、最快上手

双击 `启动.bat`，然后：

```
1) 打开商品页 → 把地址复制下来
2) 控制台「商品与 SKU」页 → 粘进 URL → 添加
3) 点「采集一次」→ 该商品的全部规格都抓下来了
4) 在 SKU 表里勾中要抢的规格 → 保存
5) 确认无误后关掉演练模式，开售前 90 秒打开商品页
```

---

## 一、配置格式：`data/grab/huawei.config.json`

```jsonc
{
  "products": [
    {
      "url": "商品页地址",              // ★ 一个 URL 就是一个商品
      "id": "mate90-pro-max",          // 备注名，可选
      "enabled": true,                 // false 则跳过
      "sbomCodes": ["2601010640923"],  // 要抢的规格编号；留空 = 全部
      "maxPrice": 12000,               // 价格上限，null = 不限
      "quantity": 1,
      "saleAt": null                   // 开售时间；留空 = 不定时
    }
  ]
}
```

**可以配多条**。每条一个商品，互不影响。

### 为什么不用标题关键字

一个 URL 打开就是一个确定的商品。靠 `prdId`（平台自己的主键）精确匹配就够了。

以前用 `"Mate 90 Pro Max"` 这种关键字，同系列的 Pro / Pro Max / RS 会互相认错 —— 那是很容易在真金白银那一步出事的坑。

### 为什么规格用 `sbomCode` 而不是文字

实测同一个商品 `prdId=10086384648661` 下面：

```
价格 ¥9499  ~  ¥12999     ← 差 3500 元
4 种颜色 × 4 种版本 = 16 个 SKU
```

用「颜色=翡冷翠 + 版本=16GB+512GB 典藏版」这种文字去点，很容易点错到同色不同容量的版本。

`sbomCode` 是平台自己的 SKU 主键，唯一且不会骗人。在控制台上勾一次就自动写进配置，不用手抄。

---

## 二、爬虫抓到了什么

`node platforms/huawei/crawler-huawei.mjs`

**只去配置里的 URL，一个商品都不多跑。** 不翻首页、不扫分类页、不猜"还有什么别的商品"。

### 数据来源

| 来源 | 拿到什么 |
|---|---|
| `__NEXT_DATA__` → `mainData.current.base[sbomCode]` | 规格全名、价格、可购状态、限购、详细参数 |
| `__NEXT_DATA__` → `productOptions.gbomAttrMappings` | **规格维度 → 每个值对应哪些 SKU**（颜色 4 个、版本 4 个、CPU 2 个） |
| `__NEXT_DATA__` → `extInfo.rushBuySkuCodes` | 哪些 SKU 参与抢购 |
| 旁听 `querySkuInventoryV2` | 精确库存数 |
| 旁听 `buy.vmall.com/queryRushbuyInfo.json` | 开售/结束时间、限购、**平台服务器时间** |

页面是 Next.js 做的，SKU 全表在 `<script id="__NEXT_DATA__">` 里（1.2MB）。接口响应只给编号不给规格名，两者必须合起来才拼得出完整 SKU。

### 实际输出示例

```
[1/1] mate90-pro-max
  ✓ HUAWEI Mate 90 Pro Max
     SKU 16 个　现售可买 4　现货有货 4　待抢购 12　附加服务 3 种
     规格维度：颜色(4)  版本(4)  CPU型号(2)
       2601010640927  ¥ 10999  抢购未开售   未开售    10-07 10:08 限购1   翡冷翠/16GB+512GB 典藏版/麒麟9050 Pro
       2601010640917  ¥  9499  现货可买    库存充足  无场次                 曜石黑/12GB+512GB/麒麟9050
       ...
```

每个 SKU 带上：

```jsonc
{
  "sbomCode": "2601010640927",
  "attrs": { "颜色": "翡冷翠", "版本": "16GB+512GB 典藏版", "CPU型号": "麒麟9050 Pro" },
  "price": 10999,
  "buyableText": "抢购未开售",     // 由 buttonMode 映射
  "inventoryQty": null,             // 未开售的平台不查库存
  "rushBuy": { "startTime": "2026-10-07T10:08:00+08:00", "startsInMs": 60819601, "limitNum": 1 },
  "params": [ /* 屏幕/电池/摄像头… 详细参数 */ ]
}
```

### 必须知道的坑

**1. `inventoryQty: 1000` 是封顶哨兵值**

```
0     = 缺货
1000  = ≥1000 或充足（不是精确 1000 台）
```

**2. 未开售的抢购 SKU 库存是 `null`，不是 0**

平台对没开售的 SKU 压根不查库存。这类 SKU 的状态看 `buyableText` / `buttonMode`，别把 `null` 当成缺货。

**3. `buttonMode` 就是可购状态**

| 值 | 含义 |
|---|---|
| `1` | 现货可买 |
| `29` | 抢购未开售（倒计时中）★ 要抢的就是这个 |
| `9` / `10` | 缺货 |
| `2` | 即将开售 |
| `31` | 预约中 |

未识别的值原样显示为「未识别模式 X」，**不硬套结论** —— 宁可给原始值也不给错判断。

**4. `startsInMs` 才是倒计时该用的值**

以平台服务器时间 `currentTime` 为基准，**不受本机时钟偏差影响**。别用"本机时间减 startTime"，电脑差几秒就可能错过开售。

**5. 首屏读不到抢购场次**

`__NEXT_DATA__` 里的 `skuRushbuyInfo` 是空的（SSR 不填）。场次数据要靠旁听接口。

后果：**油猴脚本读不到开售时间**。所以定时抢购必须在配置里填 `saleAt`，否则脚本按"看到可买就买"处理（会在日志里警告）。

**6. 规格名以 `base[sbomCode].name` 为准**

`gbomAttrMappings` 里的 `attrValue`（如"翡冷翠"）是单个维度的值，拼起来才是完整规格。用哪个都行，但别自己拼 —— 平台的 `name` 里可能带产品线前缀。

---

## 三、控制台

双击 `启动.bat` 后按 `C`，或直接开 <http://127.0.0.1:3100/>。

界面在 `web/platforms/grab-console.html`（独立文件，不嵌在 .mjs 里）。

四个页签：

| 页 | 干什么 |
|---|---|
| **商品与 SKU** | 加 URL / 采集 / 勾选要抢的规格 |
| **抢购设置** | 演练开关、轮询间隔、每商品的价格上限与数量 |
| **抢购结果** | 脚本回报的订单结果 |
| **怎么用** | 流程与边界 |

### 勾选规格的两种方式

**按维度点**：顶部有「颜色 / 版本 / CPU型号」三个筛选条，点 `翡冷翠` + `16GB+512GB 典藏版` 就自动只留这两个组合的 SKU。

**按行勾**：表格里逐行勾。

勾完点「保存勾选的 SKU」，编号写回配置文件，油猴脚本立即按新目标工作。

---

## 四、抢购速度：瓶颈到底在哪（实测）

**结论：不在"点击"这个动作上，在轮询间隔上。**

有人会觉得"调接口比点按钮快"。实测数据不支持这个判断：

| 环节 | 实测耗时 |
|---|---|
| 一轮状态检测（读页面文本 + 遍历 2192 个元素找按钮） | **6 ms** |
| `el.click()` 本身 | 同步调用，**几毫秒** |
| 默认轮询间隔 | **3000 ms** |
| **→ 平均发现延迟** | **1217 ms**（本机实测，3 次采样 1210/1219/1222） |

**99.5% 的等待时间花在"等下一次轮询"上。**

不同间隔的实测发现延迟（本地 mock 页面，按钮变可点 → 脚本检测到）：

| 轮询间隔 | 实测平均发现延迟 | 说明 |
|---|---|---|
| 3000 ms | **1217 ms** | 改之前 |
| 1000 ms | 223 ms | |
| 300 ms | 70 ms | |
| **150 ms** | **91 ms** | ★ 现在的临售默认值 |
| 80 ms | 78 ms | 收益已经到顶 |

**从 3000ms 改成 150ms，延迟从 1217ms 降到 91ms —— 快了 13 倍，省下 1.1 秒。**

再往下调（80ms）收益递减，因为 `setTimeout` 本身的调度精度开始成为瓶颈。

### 现在的做法：自适应间隔

```
离目标开售时刻还远（> hotWindowMs）  →  慢查，pollIntervalMs（默认 3000ms）
临近或已过开售时刻                    →  快查，pollIntervalHotMs（默认 150ms）
没有配置开售时刻                      →  一直快查
```

配置里对应三个字段：

| 字段 | 默认 | 作用 |
|---|---|---|
| `limits.pollIntervalMs` | 3000 | 平时间隔 |
| `limits.pollIntervalHotMs` | **150** | 临售/开售后间隔 ★ 决定抢购速度 |
| `limits.hotWindowMs` | 10000 | 提前多久切快查（开售前 10 秒） |

### 为什么提高检测频率是安全的

`readStockState()` 只读本地 DOM，**一个网络请求都不发**。
所以提高频率不增加任何平台侧可见的流量，纯粹是本机 CPU 开销
（6ms/轮 × 150ms 间隔 ≈ 4%）。

这也是为什么快查阶段**不加抖动** —— 抖动是为了避免固定节奏被看出规律，
那是针对网络请求的顾虑；这里读本地 DOM，抖一下只是白白丢掉精度。

### 顺带说清「接口 vs 点击」这笔账

| | 点击（当前） | 直接调接口 |
|---|---|---|
| 动作本身耗时 | 几毫秒 | 几毫秒 |
| 签名 | **平台自己的 JS 现算，永远不会错** | 要自己算，算法一变就失效 |
| 请求内容 | 平台自己组装（地址/发票/优惠券…） | 要自己组装，错一个字段就被拒 |
| 失败表现 | 按钮点了没反应，肉眼可见 | 静默失败，不知道错在哪 |
| 出口延迟 | 由平台前端代码决定 | 由自己决定 |

**两条路在"发出请求"这一步的耗时是同一量级（毫秒）。
真正的差别是"能不能一直对"—— 而点击那条路的签名永远是对的。**

所以速度优化的正确方向是"减少等待"，不是"换发送方式"。
这一节的数据就是证据：省下的是 1.1 秒，而换发送方式能省的不到 10 毫秒。

---

## 五、定时规则（当前：已关闭）

**当前阶段自动调度是关闭的，所有数据都靠手动采集。**

要打开：

```powershell
$env:CRAWLER_SCHEDULE = "on"
node core/grab-bridge.mjs
```

规则：每天在指定窗口内随机挑一个时刻采集一次；手动跑过则当天不再自动跑；失败也算"跑过"（不反复重试放大访问量）。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CRAWLER_SCHEDULE` | **off** | 设为 `on` 打开 |
| `CRAWLER_EARLIEST_HOUR` | 0 | 窗口起点 |
| `CRAWLER_LATEST_HOUR` | 24 | 窗口终点 |
| `CRAWLER_TIMEOUT_MS` | 1200000 | 单次最长运行 |

---

## 六、行为边界（写在代码里，不是写在文档里）

```
✅ 只读：旁听页面自己发起的响应
✅ 不构造请求、不修改参数、不重放、不伪造请求头、不逆向签名
✅ 不涉及任何交易动作：不下单、不加购、不占库存
✅ 遇到验证码/风控 → 立即停止并如实记录，不做任何绕过
✅ 主动剔除响应里的用户/账号/会话字段
✅ 只去配置里的 URL，不自主发现商品

❌ 下单必须走真实页面点击
❌ 绝不编造订单号 —— 读不到就报"结果未知"
```

---

## 七、当前状态

### 已验证

```
✅ 爬虫：只采指定 URL，16 个 SKU 全抓出（颜色4×版本4×CPU2）
✅ SKU 维度映射：gbomAttrMappings 正确解析出三个维度
✅ 抢购场次：开售时间 / 限购 / 平台服务器时间正确，startsInMs 可信
✅ 可购状态：buttonMode 映射正确（4 现货可买 / 12 抢购未开售）
✅ 配置：多商品增删不丢数据，SKU 勾选写回正确
✅ 脚本：商品按 prdId 精确匹配（不用关键字）、SKU 信息读取正确、
        不存在的 SKU 返回 null 不瞎编
✅ 速度：单轮检测 6ms；轮询 3000ms→150ms 后平均发现延迟 1217ms→91ms（实测）
```

### 未验证

```
❌ 插件从未在真实登录态下跑过
❌ 「点击购买 → 提交订单 → 读到订单号」这条链路一次都没走过
❌ 开售后 buttonMode 会不会从 29 变成 1（理论上会，未实测）
```

---

## 八、验证窗口

**`2026-10-07 10:08:00`（Mate 90 Pro Max 典藏版开售，12 个 SKU）**

```
1. 今天先演练（dryRun = true）
   登录华为账号 → 打开商品页 → 确认脚本定位到正确的 SKU
   → 面板显示当前规格标签和价格 → 点一下购买 → 停住

2. 明天 10:08 前 90 秒打开商品页，保持登录

3. 看「抢购结果」页：
     DRY_RUN_OK     演练通过
     ORDER_PENDING  拿到真实订单号
     SUBMIT_UNKNOWN 没读到订单号（不伪造，去"我的订单"核对）
     WAITING_HUMAN  遇到验证码，等人处理
```

**判断成败的唯一标准：拿到平台真实订单号，并能在华为商城「我的订单」里查到。** 截图、本地生成的编号一律不算。
---

## 九、真点击驱动（CDP 专用窗口）——真抢的唯一可用路径

**为什么必须用它**：油猴脚本里的 `el.click()` 是网页内部合成的假点击
（`isTrusted=false`），vmall 的下单按钮直接无视——2026-10-06 演练实测：
点中真按钮页面也纹丝不动。只有浏览器输入管线产生的真事件才被认可。

`platforms/huawei/cdp-rush.mjs` 通过 Chrome 官方调试接口（CDP）的 Input 域派发鼠标事件，
`isTrusted=true`，与真人点击无异；从"发现可买"到"点下去"毫秒级。

### 用法

```
1. 启动桥接服务（启动.bat 或 node core/grab-bridge.mjs）
2. node platforms/huawei/cdp-rush.mjs --prdId=10086621059876
3. 第一次运行会开一个"抢购专用 Chrome 窗口"（独立数据目录
   data/grab/chrome-profile-rush/，与日常浏览器互不干扰），
   在里面登录一次华为账号——登录态持久保存，以后不用再登
4. 之后每次抢购：直接跑第 2 步。窗口已登录，脚本自动盯按钮、
   到点真点击、进入确认订单页
```

### 时间同步与到点行为（2026-10-07 起）

- **时间口径一律是华为服务器钟，不是本地钟**。启动时对
  `openapi.vmall.com/serverTime.json`（备用 `queryRushbuyInfo.json` 的
  `currentTime`）做 NTP 中点法采样 5 次取中位数求偏差，T0-10s 再精校一次
  （3 样本）。实测本机与华为服务器钟偏差可达 ±400ms（2026-10-07：慢 384ms），
  Windows 默认 7 天才同步一次系统时间，不校时就是盲跑。
- **开售时刻自动获取**：`buy.vmall.com/queryRushbuyInfo.json?sbomCodes=<SKU>`
  免鉴权返回各 SKU 的官方 `startTime`，有就优先用（配置 saleAt 只做兜底）。
  现货/无场次商品该列表为空，自动回落配置。
- **到点不刷新页面**：高频盯按钮等它自己解锁（2020-2026 五代华为脚本源码
  一致做法）。点击日志带 `服务器钟 T0±xms`，可复盘。
- **保险丝**：开售后 1s（`limits.fuseRefreshDelayMs`）按钮仍未出现，说明
  这页面状态是加载时定死的（网上"疯狂切 SKU"视频的原理就是切规格强制页面
  重新拉数据）——此时做一次绕缓存强刷（`Network.setCacheDisabled` + URL 加
  `_r=` 参数），仅此一次，然后继续盯。
- **排队页/确认页绝不刷新**：刷新排队页会重新排队（约 20s 惩罚位）。
- 开售前不做缺货误判（页面显示"暂不售卖"是正常态，T0 后才允许 OUT_OF_STOCK 退出）。
- 诊断快照：开售前和强刷前各抓一帧 `queryRushbuyInfo` 打进日志，用真实数据
  回答"按钮到底靠什么解锁"。

### 回流监控（monitor，2026-10-07）

抢购未中（缺货/超时）后不退出，继续守到活动结束。依据（2026-10-07 调研+实测）：

- **回流来源**：未付款订单约 **15 分钟**超时回库存（收银台实测原文"15分钟内完成
  支付，否则订单将自动取消"），活动窗口实测 **2 小时**（queryRushbuyInfo 的
  startTime→endTime）。理论回流高峰 T0+15/30 分钟；无公开的回流时间分布统计。
- **双信号**：① Node 轻量轮询 `queryRushbuyInfo`（免鉴权、实测无缓存头；
  `skuStatus` 实测会翻转：开售前=1、售罄=2，语义无文档只当预警），字段一变
  立刻查页面；② 周期绕缓存刷新商品页看按钮（唯一可信信号）。
- **节奏**（参考 ticket-radar / shiyutim·tickets 等成熟监控项目）：间隔+随机
  抖动+连续失败熔断（5 轮）。热窗（监控开启后默认 40 分钟）30s/轮，之后 60s/轮。
  刷新太密有风险：已知一例疑似 IP 拉黑（hw_seckill #160）、greasyfork 作者
  "操作太频繁被盾"警告。
- **捕获后**走与正抢完全相同的可信点击链路；真模式自动提交订单（15 分钟内
  须付款，不付款自动取消）。
- 配置 `config.monitor`：`enabled / pollSecs(60) / densePollSecs(30) /
  jitterSecs(15) / interfacePollSecs(15) / denseWindowMin(40) / maxMs(7200000) /
  ignoreActivityEnd`。
- 已知不可解：`skuStatus/totalInventory/isYY/attendQualification/limitNum` 语义
  公开世界无人解读（grep.app 全库检索确认），不基于它们做决策；直接拼
  queue.html 排队页 URL 绕过商品页的路线（greasyfork 393577 已验证）未采用——
  保持"真人怎么点我们怎么点"。

### 槽位与规格核对（2026-10-07 加固）

- **控制台生成槽位 bug 已修**：旧逻辑给新槽位填"第一个勾选的规格"，两个槽位
  会绑到同一个 SKU（当天 acc1/acc2 实锤）。现在每个勾选的规格独占一个槽位。
- **页面遵循 URL 的 sbomCode 参数**（实测可复现：换参数刷新，"已选"跟着变）。
  10:08 那次页面选着跃影红、绑定的却是零度白——是窗口里的**手动切规格**造成的。
- **驱动侧保险丝**：启动就位后、值守期间（每 30 秒）、正抢循环、监控轮都会把
  页面"已选：X·Y"和槽位绑定规格（采集目录里的 attrs）核对，不符就导航回绑定
  规格；监控里连续 3 次拉不回报 WRONG_SKU 停止。绝不变更规格、绝不抢错规格。
- 注意：acc1 当前绑定 = Pura X View **零度白 12GB+256GB**（2601010634026）。
  要改抢别的规格，去控制台勾选后重新"按勾选的规格生成槽位"。

### 参数速查（大白话）

| 控制台字段 | 代码名 | 干什么用 | 建议 |
|---|---|---|---|
| 模式 | config.mode | rush=到点抢购（失败自动转回流监控）；monitor=不抢首发直接守回流（已接上，之前是摆设） | rush |
| 开售前多少秒进页面就位 | earlyEnterSec | 只在提前很久派发时有用：值守结束后，开售前 N 秒刷新页面进临战状态。临开售才派发则无用 | 90 不用动 |
| 平时轮询间隔 | limits.pollIntervalMs | 就位后、高频前的慢速盯梢节奏，基本用不上 | 默认 |
| 临售/开售后间隔 ★ | limits.pollIntervalHotMs | 高频盯按钮节奏，最核心速度参数 | 150 别再小 |
| 提前多久进入高频 | limits.hotWindowMs | 开售前 N 毫秒切高频+第二次校时 | 5000 |
| 多久没成功就放弃 | limits.giveUpAfterMs | **抢购阶段**时限，到点转回流监控。不会缩短监控（监控守到活动 endTime）；但越大监控启动越晚 | 60000（用户定） |
| 回流监控参数 | config.monitor | pollSecs/densePollSecs/jitterSecs/interfacePollSecs/denseWindowMin/maxMs，见上文回流监控节 | 默认即可 |

### 抢购高频路径为什么快（2026-10-07 重构）

旧路径每轮做两次全页评估（上千元素逐个 innerText，单轮几百 ms），150ms 的轮询
睡眠根本不是节拍主项——10:08 那次实际是 **T0+602ms** 才点下去，比人手还慢。
重构后主循环分两档：

- **慢速档**（离 T0 远）：全文状态+完整按钮扫描，节奏 pollIntervalMs。
- **高速档**（T0 前热窗+开售后）：一轮一次 `fastCheckExpr`——优先直查已知按钮位
  `#prd-botnav-rightbtn`（hw_seckill/greasyfork 双源），锁定态不读全文
  （**实测单轮中位 1ms**，旧全页扫描 13ms）；开售后才读全文出缺货/已选信号，
  且只在文本出现购买关键词时才做全页兜底扫描。
- 实测节拍：50ms 睡眠 + 1~2ms 检查 ≈ **51~55ms 一轮**；解锁后 ~70-100ms 内完成
  真点击（含 CDP 点击派发），快过人类精英反应（150-200ms）。
- 点击动作链（点击→30s 找确认页→登录/重试处理）抽成 `clickBuyFlow`，慢/高速
  两档与回流监控共用。

### 安全边界（与油猴脚本一致）

- `dryRun=true`（默认）走到"进入确认订单页"为止，绝不点"提交订单"
- 遇到验证码/登录挑战一律停下转人工，不做任何绕过
- 不带 `--enable-automation` 启动，`navigator.webdriver` 保持 false，
  不做任何针对平台检测的伪装（我们只发真实事件，不改网站行为）

---

## 十、B 方案：CDP 响应拦截改写（2026-10-07 落地）+ A 方案触发器 + 改版体检

调研了全网能找到的华为抢购脚本（bytehola/vmall_huawei_seckill、
a6051529/vmall-rush-to-buy、greasyfork 397649/393577、lov3smu/hw_seckill 等）
后定的三条腿路线。项目定位与边界见根目录《限制规则清单.md》（2026-10-07 起改为
《项目定位与设计边界》：个人学习项目）。

### 三条腿

| 腿 | 原理 | 状态 |
|---|---|---|
| **B 主力** | CDP Fetch 域拦截改写"本机浏览器收到的内容"：流量仍全部由页面自己发起，不构造/不重放/不伪造请求 | R1/R3 自测通过（`platforms/huawei/selftest-intercept.mjs` 11/11）；R2 采集阶段 |
| **A 触发器** | 直接调页面内部函数（React fiber → onPress 闭包里的 `Yo()` / `E.goBuy()`），不产生点击事件 | ✅ **2026-10-07 走通**（现货 SKU 实测真实开出确认订单页、`DRY_RUN_OK`）；`triggerMode` 已开 `internal` |
| **真点击兜底** | CDP Input 域可信点击 | 一直可用 |

### B 方案三条规则（`platforms/huawei/intercept/rules.mjs` = 纯函数模板，`install.mjs` = CDP 装配）

- **R1 抢购信息提前解锁**：拦截 `buy.vmall.com/queryRushbuyInfo.json`，把
  `skuRushBuyInfoList[].startTime` 提前 `intercept.leadMs`（默认 300ms）→
  页面倒计时提前归零 → 按钮提前解锁。Node 侧 T0 触发仍按真实 startTime 计算
  （提前太多点早了会被服务器拒）。currentTime 不动（倒计时基准不能乱）。
- **R2 排队页留证**：`queue.html` / `rushbuy2/*/js/queue.js` 响应自动落盘
  `data/grab/evidence/queue-samples/<时间戳>/`（meta.json + body.txt，每会话
  最多 3 份），然后**原样放行**——真实排队页样本从未到手，不写盲改逻辑；
  样本到手后下一轮做排队接管。注意：确认页是新标签，Fetch 拦截按标签会话生效，
  所以 `finishConfirmed` 里会给确认页标签再装一次拦截。
- **R3 确认页零延迟信号**：不走 Fetch（新标签域名未知），用浏览器级
  `Target.targetCreated/targetInfoChanged` 事件——`window.open` 的确认页
  一出现（瞬时）就唤醒 `attemptBuy` 的等待（信号不可用时自动退回 600ms 轮询），
  直接进提交。

安全阀：改写失败/坏包/形状不符一律**原样放行**（`Fetch.continueResponse`），
绝不因拦截弄坏页面；`intercept.enabled=false` 一键回到旧行为；
`patterns` 可显式覆盖（自测就是这么用 mock 域的）。

### A 方案触发器（`config.triggerMode`，2026-10-07 走通版）

- `click`：只用可信点击。
- `internal`（**当前使用**）：热窗内每 ≥300ms 调一次页面内部入口——三层候选，
  全部是页面自己的代码（不构造/不重放请求），不产生点击事件（`isTrusted` 无从谈起）：
  1. **`Yo()`**——按钮闭包里的抢购分发函数（无节流；未开售时静默无害，
     按钮文案一到「立即购买」即命中购买分支）；
  2. **`E.goBuy("buy_now_button","rushbuy")`**——购买执行入口（解锁信号出现后
     与 Yo 交替双发，每轮只调一个，不会双开确认页）；
  3. **旧全局路径**（`window.rush.business.doGoRush`）——历史保留，万一换回来。
- **入口怎么拿到的**（不是全局变量）：「立即购买」按钮是 RNW（react-native-web）
  Pressable，fiber 向上 2 层 `memoizedProps.onPress` 是按钮业务回调；其**闭包**里
  的 `Yo`/`E.goBuy` 用 CDP 的 `[[Scopes]]` 通道现取现调（每轮重取，天然抵抗
  React 重渲染、不会用上过期快照；全链实测 ~5ms）。`onPress` 本身有 1s 连点
  节流（`Uo=1000`），故不作主入口、仅作后备口径。
- **★ 关键坑**：调用必须带 `userGesture:true`——确认页由 `window.open` 打开，
  无用户手势会被浏览器弹窗拦截器静默拦下（第一版"没走通"就栽在这里）。
- 失败语义：连续 ~10s 入口不可达才判"结构失效"、停用回落真点击；未开售/
  重渲染瞬间的短时取不到只计数继续。体检 **C7** 监控这条链（C7a 观察旧路径）。
- 复现/侦察工具：`node verify/history/probe-rush-entry.mjs`（默认只读侦察入口链；
  `--dump-closure` 读闭包变量；`--fire` 实测调用一次并监测确认页——只做
  「立即购买」级动作，**本工具不含任何"提交订单"代码**）。

### 登录态怎么判断（2026-10-07 定稿：看浏览器凭据，不看页面文案）

**不用页面文案**——页头会先短暂显示"请登录"再水合回登录态，早读误判；
详情页真未登录时也可能压根不出现那行字，晚读也误判。两个方向都会错。

实测排除掉的办法（都有取证，别重复踩）：
- 请求头里**没有**鉴权令牌（对比 openid 请求头，只有 UA/trace 不同）
- `queryCart` / `getShippingTime` / `querySkuInventory` 两边响应**完全相同**
- `queryRecommendConfig` 主动请求时两边**都返回 200916** → 不能靠它正查

**唯一可靠凭据 = 华为账号 SSO 会话 Cookie：`sid` / `hwid_cas_sid` @ `.id1.cloud.huawei.com`**
未登录完全不存在；已登录两者都在（len=84）。清空 storage 后依然如此。
实现：`cdp-core.mjs` 的 `readLoginState()`（`Network.getAllCookies`），
驱动与体检共用同一份；油猴脚本用 `GM_cookie` 读同一对 Cookie。

辅助信号：接口响应里出现"登录已过期/请重新登录"这类**明确措辞**时，
60 秒内压过凭据判断（会话刚死时它更及时）。
**刻意不收 `200916` / "用户未登录"**——匿名小请求在已登录页面上也会返回它们，会误伤。

### 改版体检（`platforms/huawei/checkup-vmall.mjs`）——定期维护的核心

抢购脚本押注在 vmall 的页面结构/接口形状/内部函数上，华为一改版就**静默失效**。
体检把这些押注逐项对着真实环境验证：**C0 商品列表闸门**、C1 窗口/登录态、
C2 按钮锚点+文案字典、C3 接口形状+R1 干跑、C4 校时、C5 __NEXT_DATA__、
C6 匹配器+排队样本、C7 A 方案内部入口（fiber→Yo/goBuy；C7a 观察旧全局路径）、
C8 价格读取。每项 DRIFT 都带"改哪里"。

- 手动：控制台「改版体检」页 → 立即体检；或 `node platforms/huawei/checkup-vmall.mjs`
- 自动：桥接每日一次（8~22 点随机时刻，`CHECKUP_SCHEDULE=off` 可关）
- 报告：`data/grab/checkup-report.json`（最新）+ `checkup-history.jsonl`（历史）
- 退出码：有 DRIFT/FAIL 时为 1（可挂 CI/计划任务）

### 维护闭环

```
华为改版 → 体检报 DRIFT（每天自动发现）→ 按提示修：
  · 能改配置的：intercept.leadMs / rules.* / 锚点外的参数
  · 必须改代码的：fastCheckExpr 锚点（cdp-rush.mjs）、字段路径
    （vmall-api.mjs / intercept/rules.mjs）、A 方案入口
    （cdp-rush.mjs 的 pickInternalEntry / internalFire）
→ 复检 PASS → 开抢
```

### 模块结构（2026-10-07 重构后）

```
core/
  cdp-core.mjs          CDP 客户端（事件订阅）+ 可信点击 + 槽位窗口（共用）
platforms/huawei/
  vmall-api.mjs         官方接口探测 + 校时（驱动与体检共用同一份解析）
  cdp-rush.mjs          抢购驱动（拦截装配、A 方案入口 pickInternalEntry、
                        触发器、确认页信号都接在这里）
  intercept/rules.mjs   改写规则纯函数（单测：tests/intercept/rules.test.mjs）
  intercept/install.mjs Fetch.enable 装配 + 放行/留证（坑：getResponseBody
                        的字段名是 base64Encoded）
  checkup-vmall.mjs     改版体检（C7 只读检测 A 方案入口链）
  selftest-intercept.mjs 端到端自测（本地 mock + 真 Chrome，11 项断言）
verify/history/
  probe-rush-entry.mjs  A 方案入口侦察器（只读定位 / --dump-closure / --fire）
```

自测：`node platforms/huawei/selftest-intercept.mjs`（约 30s，不碰 vmall）——验证改写→
提前解锁→可信点击→确认页信号→提交→留证→放行全链。
A 方案入口复检：`node verify/history/probe-rush-entry.mjs`（只读；加 `--dump-closure`
看闭包变量，加 `--fire` 实测开确认页）。

---

## 十一、2026-10-08 大版本：提速 / 登录保活 / 预热 / SKU 扫描回流

### 11.1 热路径提速（对照 0.1s 目标，全部实测）

| 项 | 旧 | 新 |
|---|---|---|
| 内部 fire 节流 | 300ms | 50ms（`limits.internalFireMs`） |
| 提交按钮挂载探测节拍 | 300ms | 100ms（submitOrder PROBE_MS） |
| NO_ENTRY 降级前摇 | 6 轮×300ms=1.8s | 2 轮×100ms=0.2s |
| 提交兜底坐标等待 | 固定 300ms 硬睡 | 坐标稳定判断（两次一致即点，≤400ms） |
| 点击后等确认页（热路径） | 30s 盲等 | 8s（monitor 段保留 30s） |
| 内部入口失效判定 | 200 次计数 ≈60s | 时间窗 10s（internalMissSince） |
| 校时 | 5 样本中位数 | 取最小 RTT 样本（NTP 惯例，慢样本不再拖偏） |
| 到点等待精度 | 最后 60ms 忙等 | 最后 500ms 忙等（压住 Windows 15.6ms 定时器抖动） |
| 提交后读订单号 | 500ms/拍 | 前 3 秒 200ms/拍，之后 500ms |

**0.1 秒结论**：发现→触发段 = 轮询相位（≤50ms）+ 内部链（p50 4.7ms）≈ **最坏 55ms**，
达标；真点击兜底 47ms 也达标。超标的只剩两类：①确认页加载（页面自身，3~6s——
预热针对它，见 11.3）；②提交兜底完整链（~160ms，仅当内部入口失效时才走）。

### 11.2 提交订单修复（用户初修复查结论）

- **P0 崩溃（用户修复里藏着）**：`submitOrder` 的 evidence 引用了 `if` 块内声明的
  `pos`——内部提交成功后 `report()` 必抛 `ReferenceError`，**真模式每次提交后结果都
  回传失败**。已修：`pos` 提升为函数级变量。
- **兜底路径补齐**：兜底点击现在也先等按钮挂载（最长 30s、100ms 节拍）——修掉
  「确认页 5.8s 挂载期间兜底直接放弃报 SUBMIT_NOT_FOUND」的问题（11:44 实录）。
- **明确失败信号补发**：提交后页面出现「提交失败/网络异常/系统繁忙/活动未开始…」
  且无订单号/收银台 → 最多补发 `limits.submitErrorRetryMax`（默认 2）次，间隔 150ms；
  没有失败信号绝不补发（防重复下单红线不变）。
- **预开提交时机**：预开的确认页改为 **T0 对准提交**（`limits.preOpenSubmitLeadMs`
  默认 0）——旧版在 T0-500ms 就提交，会被服务器以「未开始」拒收。

### 11.3 跨商品预热（实测验证 + 驱动内置）

实测（`verify/history/verify-warm-cross.mjs`，清缓存对照）：预热商品确认页按钮挂载
852ms → 紧随其后的目标商品 **501ms**（对照用户观测的冷加载 ~5.8s）。静态资源是
全商品共享的，任何现货商品的确认页都能焐热目标商品的确认页。

驱动内置（`config.warmup.enabled` 默认开）：**优先用 `warmup.url` 指定的商品**
（控制台「抢购设置 → 预热用哪个商品」；推荐配一个长期现货的商品），没填才退回
"商品列表里除本商品外的现货候选"。锁定/售罄候选 2 秒内跳过；整体截止 T0-15s
（绝不吃热窗）；草稿页计入 tabBaseline（绝不被误当成果页），main() 收尾统一关闭。

### 11.2b 提交被拒（火爆）补发（2026-10-08 真场实录）

真场实测：内部提交成功调用后，服务器拒单话术为「**您下单的商品火爆销售中，
请稍后再试。**」。旧版两个 bug 导致没能补发：①地址判定在前——确认页常驻的
"新增收货地址"按钮被误判成缺地址（有地址也会中招）；②失败信号判定在后。
现修复：**失败信号（含"火爆"）优先判定**，命中即补发（`submitErrorRetryMax`
默认 2 次、间隔 400ms）；缺地址判据收紧为「请填写/请选择…收货地址」。

### 11.4 登录保活（存活短的根因 + 对策）

实测根因（`verify/history/probe-login-ttl.mjs`）：
- `sid`/`hwid_cas_sid`（登录凭据）本身 **400 天有效期**，不是它过期；
- 真凶是 vmall 侧的滚动短命 Cookie：**`cluster`（负载均衡路由粘性）只有 15 分钟
  窗口**、`cartId` 数小时。值守期间零请求 → 它们过期 → 下次请求被路由到别的后端
  → 会话对不上 = "掉线"（Cookie 还在，服务端认不得）；
- `CASTGC`（CAS 续票）和 vmall 会话 Cookie 是**会话级**（关窗口就没）——重启电脑
  后要求重新登录是正常现象；
- 实验证实：**请求一次 www.vmall.com 会把 cluster 续期出新的 15 分钟窗口**
  （queryUserInfo 不续）。

对策（已内置）：值守/回流监控期间每 `limits.sessionPingMs`（默认 8 分钟）从页面
上下文发一次轻请求（www.vmall.com no-cors + queryUserInfo 验活）；探测到服务端
会话没了立刻报 NEEDS_LOGIN 并继续值守等人登回。仍无法覆盖的：同账号在别处登录
把会话挤下线（需换专用账号）、绝对 TTL 到期（只能重新登录）。

### 11.5 回流监控 · SKU 随机切换扫描（默认方式，2026-10-08 晚按用户要求定稿）

依据（`verify/history/probe-sku-switch.mjs` 实证）：在商品页切换规格，页面 **~150ms
内自发重拉该 SKU 实时状态**（refreshSbomRealInfoV3 / sbomDetailParamCacheInfo），
按钮随之重渲染——这就是"疯狂切规格"能捡到回流的原理。

- **切换范围**（多账号各配各的，2026-10-08 晚定稿）：① 槽位自己的
  `slots[].scanSboms`（rush-slots 文件按账号配，控制台「开抢」页槽位表格可编辑）
  > ② 默认 = 该商品勾选要抢的规格（product.skuIds，即"需要抢购的那些"）>
  ③ 该商品全部规格。在这些 SKU 里**随机切、不切回**——出现可买按钮时立刻出手，
  真模式直接提交订单，无需任何前置步骤。清单只有 1 个规格时（切自己不会触发
  数据重拉）自动退回整页刷新并提示。
- 切换方式：按目标 SKU 的规格值逐维按下芯片自己的 onPress（真点击对 RNW 芯片无效）。
- **出手闸门**：页面"已选"必须落在清单内（平台可能把组合吸附到清单外 SKU，
  此时不出手、继续切）——宁可错过不错买。
- 节奏 `monitor.skuScanSecs`（默认 10s）+ 随机抖动（默认 ±5s）；连续 5 次失败熔断
  自动退回整页刷新模式；每 `skuFallbackRefreshSecs`（默认 600s）整页刷新兜底一次。
- 接口预警信号保留（queryRushbuyInfo 每 15s，字段一变立即触发一轮扫描）。
- 旧行为可回退：`monitor.scanMode = "refresh"`。

### 11.6 出手链路改为「内部优先、真点击兜底」

2026-10-08 实测（`verify/history/probe-click-debug.mjs`）：当前 RNW 版页面上，
**CDP 真点击连购买按钮也打不动了**（锚点/host 中心点击均无反应），内部 onPress
稳定开出确认页。因此 `triggerBuyFlow()` 统一出手：内部入口 8s 窗 → 没出确认页
再真点击 30s 窗兜底。正抢、预开、回流捕获全部走这条链。

### 11.7 演练开关

槽位/商品可设 `ignoreApiStart: true`：无视官方接口的开售时刻、强制用配置的
saleAt——纯定时商品想演练人工设定时刻时用（否则永远被官方场次压着）。

### 11.8 新增探针工具

```
verify/bench-internal-chain.mjs  内部链路延迟基准（可重跑回归）
verify/verify-submit-entry.mjs   确认页提交入口真机验证（只查不调）
verify/history/verify-warm-cross.mjs     跨商品预热对照实验
verify/history/probe-sku-switch.mjs      SKU 切换数据重拉实证
verify/history/probe-login-ttl.mjs       登录 Cookie 全景 + 续期实验
verify/history/probe-click-debug.mjs     真点击 vs 内部入口对照
```
