# verify —— 验证与探针区

> 2026-10-08 结构重组：本目录 = 验证区。
> - 根目录 = **活跃回归工具**：`verify-console-settings.mjs`（控制台面板冒烟）／`verify-list-gate.mjs`、`verify-spa-gate.mjs`（白名单闸门）／`verify-login-detect.mjs`、`verify-login-cdp.mjs`（登录判据）／`verify-submit-entry.mjs`（提交入口真机）／`verify-picker-refresh.mjs`（采集下拉栏，净零）／`verify-3plans-pick.mjs`（三方案逻辑回归）／`bench-internal-chain.mjs`（内部链路基准）／`collect-rush-evidence.mjs`（复盘取证）／`sample_windows.py`
> - `history/` = 冻结的一次性探针（不再保证可跑；下方文档描述的 `probe.mjs` 框架在这里）
> - `tmp/` = Chrome 临时 profile（不入库）；`output/`、`evidence/` = 产物与证据（不入库）
> - URL 约定：桥接 `/` = 工作台外壳；控制台 = `/console-huawei`

---

## 附：原探针框架文档（监控路线研究，已冻结）

## 这个探针要回答什么

《抢购系统计划书审查报告 r7.2》第 2.3 节把原计划书"Monitor 层纯 HTTP 轮询"降级为"优先尝试"，主路线改为**共享会话读页面渲染结果**。这个改动压在一个未经验证的假设上：

> 一个持久化的共享浏览器会话，能否在一轮里顺序检查 N 个商品页，稳定读出「在售 / 售罄 / 未知」，且不被风控页替换掉？

以及一个派生问题：

> 哪些平台可以退化为纯 HTTP 探测（监控层不占浏览器资源），哪些必须依赖浏览器渲染？

**这个假设若不成立，商品路线（阶段 4/5）的监控设计需要重做。** 所以探针前置为阶段 3，先用半天证伪，再写监控代码。

## 能力边界（硬约束，写在代码里）

判定依据只有**页面渲染结果** —— `document.body.innerText` 与可见元素文本，即普通用户打开该页面能看到的同一份内容。

本探针**不做**，后续扩展也不应做：

1. 不拦截、不枚举、不解析任何 XHR / fetch 的响应体
   （`page.on('request')` 仅用于统计请求数与跨域子资源，绝不读取 body）
2. 不逆向签名参数，不构造或重放平台内部接口请求
3. 不处理、不绕过任何验证码或人机校验 —— 遇到即标记 `blocked` 并跳过
4. 不做代理轮换、不伪造指纹/UA、不在被封后切换环境重试

HTTP 退化探测的实现方式：用 `javaScriptEnabled: false` 的浏览器上下文加载同一个 URL，得到的就是"一个不带 JS 的普通 HTTP 客户端能拿到的东西"。这样**无需自行构造任何请求**即可回答"纯 HTTP 够不够"。

## 安装

本目录已包含 `node_modules/playwright`（从全局安装复制，版本 1.61.0）。无需 `npm install`，也不会下载浏览器 —— 复用系统已有的 Playwright 浏览器缓存。

若换机器，需保证：

```powershell
# 环境变量：指向 Playwright 浏览器缓存
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:LOCALAPPDATA\ms-playwright"
```

## 运行

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$env:LOCALAPPDATA\ms-playwright"
node probe.mjs --config targets-smoke.json --rounds 2 --interval 5 --http-rounds 1 --verbose
```

**首次运行建议加 `--headed`**，手动完成可能出现的登录或验证。登录态保存在 `chrome-profile/`，后续轮次与 headless 运行复用同一 profile（这正是在测"持久共享会话"）。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--config <file>` | `targets.json` | 目标清单 |
| `--rounds <n>` | 配置文件的 3 | 渲染轮次 |
| `--interval <s>` | 配置文件的 8 | 目标间隔秒数，实际会加 ±30% 抖动 |
| `--http-rounds <n>` | 1 | 纯 HTTP 退化探测轮次；`--http false` 可整体关闭 |
| `--only <k1,k2>` | 无 | 只跑指定 target id 或 platform，便于单点验证 |
| `--headed` | headless | 显示浏览器窗口，可人工登录 |
| `--verbose` | 关 | 打印命中规则与提取到的价格 |
| `--out <dir>` | `output` | CSV / JSON 输出目录 |
| `--evidence <dir>` | `evidence` | 截图与 DOM 文本证据目录 |
| `--find-links <seedUrl>` | 无 | **链接发现 / 登录模式**：列出种子页上真实存在的 `<a href>`，随后退出（不进入探测循环） |
| `--link-filter <regex>` | 无 | 配合 `--find-links` 过滤链接 |
| `--hold <sec>` | 0 | 配合 `--find-links`：列出链接后**保持窗口打开 N 秒**供人工登录，登录态写入 profile |

### 典型用法

```powershell
# 1. 探测
node probe.mjs --config targets.json --rounds 3 --interval 8 --verbose

# 2. 只跑某个平台
node probe.mjs --config targets.json --only huawei --rounds 3

# 3. 发现真实商品 URL（商品会下架，URL 格式会变，别靠记忆手写）
node probe.mjs --find-links "https://www.apple.com.cn/shop/buy-iphone" --link-filter "buy-iphone/.+/.+"

# 4. 登录一次，把登录态存入 profile（会弹出窗口并保持 300 秒）
node probe.mjs --find-links "https://passport.jd.com/new/login.aspx" --headed --hold 300
```

**步骤 4 的登录必须人工完成，探针不会自动处理任何登录或验证**（红线三）。登录态写入 `chrome-profile/` 后，后续 headless 运行复用同一 profile。

## 输出

| 文件 | 内容 |
|---|---|
| `output/rendered-<时间戳>.csv` | 每次采样一行：页面状态、库存状态、命中证据、HTTP 码、导航耗时、是否跨域重定向 |
| `output/http-only-<时间戳>.csv` | 纯 HTTP 视角的结果，用于判定能否退化为 HTTP 探测 |
| `output/probe-latest.json` | 完整结果含分组分析 |
| `evidence/<id>__r<轮次>.png` | 截图（仅首轮与末轮） |
| `evidence/<id>__r<轮次>.txt` | 渲染后可见正文前 3000 字 + 按钮文本 + 价格 |

## 分类口径

**页面状态 `pageState`**（优先级从上到下，风险信号先判，避免风控页里恰好出现"立即购买"被误读）

| 值 | 含义 |
|---|---|
| `blocked` | 命中验证码/限流/拒绝访问，按设计不做任何规避 |
| `gated` | 需要登录或要求打开 APP |
| `redirected_away` | 请求的商品页被重定向到分类页/导购页/登录页/错误页 —— **目标 URL 失效，不是风控** |
| `product` | 正常商品页 |
| `error` | 导航异常 |

> `blocked` 与 `redirected_away` 都是"读不到状态"，但**排障方向相反**：前者要考虑放弃该平台的监控路线，后者只需修正目标 URL。混为一谈会导致把过期目标当成风控（过度悲观），或把风控当成配置问题而反复重试（触碰红线三）。

### 库存状态 `stockState`

| 值 | 判定线索示例 |
|---|---|
| `out_of_stock` | 已售罄 / 无货 / 补货中 / 到货通知 / 已下架 |
| `preorder` | 预售 / 预约 / 即将开售 / 订金 |
| `in_stock` | 加入购物车 / 立即购买 / 立即抢购 |
| `limited` | 仅剩 N 件 / 库存紧张 / 限购 N |
| `unknown` | 以上均未命中 —— 这是最需要关注的失败信号 |

## 怎么读结论

探针为每个平台给出一个判定：

| 判定 | 含义 | 对架构的影响 |
|---|---|---|
| `可纯 HTTP` | 渲染与纯 HTTP 都能判定，且耗时低、无风控 | 监控层可不占浏览器资源，成本最低 |
| `需共享浏览器会话` | 纯 HTTP 拿不到可用信息，但共享会话稳定可判定 | 按第 2.3 节方案实施：监控资源按会话分配，不按 SKU |
| `需进一步验证` | 判定不稳定或跨轮次结论不一致 | 选择器需要加固；或该平台不适合监控路线，改为定时准点执行 |
| `需人工介入` | 出现风控/验证 | 该平台不适合自动化监控；先人工确认页面行为再做决定 |
| `渲染路线失败` | 页面根本读不出库存状态 | 该平台监控不可行，只能退化为"已知开售时间 + 准点执行" |

### 三个必须看的数字

1. **`可判定 / 稳定`** —— 若某平台上 `可判定` 达标但 `稳定` 不达标，说明状态在多轮之间跳变，选择器需要加固，此时不要急着写监控层
2. **中位耗时** —— 乘以目标数得到"一轮全量检查耗时"。商品补货场景下这个数字直接决定你能多快发现回流
3. **`阻塞` 计数** —— 非零即说明该平台对自动化不友好。**按红线三，不做任何规避**；此时应放弃该平台的监控路线，而不是想办法绕过

## 目标清单怎么配

`targets.json` / `targets-smoke.json` 里的 `url` 换成你的真实目标即可。`expect` 字段先留 `unknown`，跑一轮看分类器是否合理，再回填期望值做准确率比对。

```json
{
  "id": "apple-iphone",
  "platform": "apple",
  "kind": "brand_official",
  "url": "https://www.apple.com.cn/shop/buy-iphone/iphone-17-pro",
  "expect": "unknown"
}
```

**建议配置真实目标而非演示目标** —— 探针的价值完全取决于目标是否与你的实际需求同构。同一个平台的不同页面类型（商品详情页 vs 搜索列表页）风控强度往往不同，值得分别配一个。

参考：`targets.json` 已内置三个平台的样例目标（华为商城、苹果中国官网、京东），其中华为商城是**目前唯一被实测证实可判定的平台**。

**商品 URL 会静默失效。** 苹果官网的 `buy-iphone/iphone-17-pro` 指向已下架机型，请求会被重定向到机型选购页 —— 表现为"读不到库存"，极易被误判为风控。配置目标后请先确认 `pageState` 是 `product` 而非 `redirected_away`。

## 已知限制

1. **单 IP 单会话**。探针不做 IP 轮换（红线三）。若平台对单一出口 IP 的容忍度低，探针会如实报告被拦截，这是结论而不是故障
2. **选择器依赖渲染文本**，不做 DOM 结构匹配。页面改版后 `stockState` 会退化为 `unknown`，这本身是有价值的告警
3. **不覆盖执行环节**。探针只回答"能不能读到状态"，不回答"能不能下单成功"——后者属于阶段 1/2 的 Adapter 验证范围
4. **`--headed` 首轮登录态**依赖人工，探针不会自动处理任何登录或验证
5. **纯 HTTP 视角在低可见文本量页面上会过度自信（待修复）**。华为旧款页面禁用 JS 后可见文本仅 383 字，却因其中含「订金」二字被判为"可纯 HTTP"——该判定很可能来自 SEO 文本而非用户可见的交互状态。**待加约束：可见文本低于约 1500 字时不得据此判定库存状态，应返回 `unknown`。** 在此之前，`HTTP可判定` 计数仅供参考

## 实测基线（华为商城，2026-10-04）

| 指标 | 数值 |
|---|---|
| 可判定率 | 3 目标 × 2 轮 = **6/6** |
| 拦截次数 | **0** |
| 一轮全量检查（3 目标） | **8.7 秒** |
| 单页耗时中位 | **2.9 秒** |
| 纯 HTTP 可判定 | **否** —— 禁用 JS 后可见文本仅 339 字 / DOM 833 KB，库存由脚本注入 |
| 桌面 URL 与移动 URL | 均归一化到 `item.vmall.com/product/comdetail/index.html?prdId=...`，**适配器只需针对一个模板** |

完整结果与逐项证据见《探针运行结论_2026-10-04.md》。
