# 项目长期记忆 · 稀缺名额与稀缺商品抢购平台

## 一、用户硬规则（操作纪律，跨模块）
1. **白名单纪律**：不在清单内的对象一律不操作（不开窗/不加载/不点击/不发请求/不写缓存）。闸门必须装在副作用之前；匹配失败当错误处理，绝不兜底默认值（搜 `|| {}`/`|| []` 类静默兜底）。判定按 id（华为 prdId / 大麦 itemId），不按标题。测试必须带"该放行的要放行"对照组。
2. **状态判据用真实凭据**，不看页面文案（华为登录态 = `sid`/`hwid_cas_sid` @ `.id1.cloud.huawei.com`；大麦页面核对 = Activity 名 + 标题关键词 + 特征控件）。
3. **换绑即重置**：槽位换商品/规格 = 事件 → 重置 + 换绑确认弹窗；自测必须零副作用（弹框后取消）。
4. **沟通**：大白话，先结论后细节，术语跟一句白话解释；给用户的操作文档只写点击路径、一页以内。

## 二、项目全景
- 布局：`core/`（桥接 :3100 grab-bridge｜手机中枢 :3120 device-hub｜保活 keepalive｜启停 service-menu）｜`platforms/{huawei,damai,app}`｜`web/`（workbench + `web/platforms/grab-console.html` 华为控制台 + `hub-console.html` 手机中枢控制台）｜`tools/`｜`verify/`（活跃在根、history 冻结、tmp 草稿）｜`data/grab/`｜`tests/`。归档目录不入库不测。
- git：`github.com/xlzxld/QG`（代理 127.0.0.1:7897；token 姿势见用户级记忆）；锚点 tag `baseline-pre-restructure` / `ebe8e4a` / `693ed86` / `6590126`。
- 服务启停统一入口：`服务启停.bat/.command` → `core/service-menu.mjs`；**改 bridge/hub 代码必须重启**（用户点）；hub-console.html 刷新即生效。
- 沙箱限制（我在沙箱里做的事）：进程活不过命令边界；**同步 spawn 一律 EBUSY**（新代码统一异步 spawn）；`npm test` 需 `ESBUILD_BINARY_PATH` 绕行（见测试节）。

## 三、技术约定与踩坑（高频）
- spawn 子进程一律 `windowsHide:true`（后台/detached 进程尤其致命，每次调用弹黑窗）。
- **Windows .bat 规范**：CRLF；含中文必须 GBK 编码 + `chcp 936`（UTF-8+BOM/chcp65001 会把 cmd 解析啃崩，实测 EXIT=255）；纯 ASCII bat 内不写中文（中文交给 node 打印）。守卫 = `tests/platform-compat.test.mjs` 第 5 项。
- adb：本机 = 项目根 `platform-tools/`（不入库；hub 启动自动补子进程 PATH）；**任何 adb 调用超时 ≥6s**（冷启动 1~4s，2s 会被强杀误判）。
- vmall 是 Next.js SPA：站内跳转不重载 → 守卫监听 `pushState/replaceState/popstate` + 轮询兜底；页面身份比对用启动时基准。
- 下单动作只经页面自身代码（可信点击/内部函数），不构造不重放请求；只读接口（校时/队列/列表）不算越界。
- 油猴 `$` = getElementById 包装（传纯 id；`$('#x')` 会整段静默死）。
- 华为侧：控制台可调参数唯一入口 = 「抢购行为」面板（deepMerge 局部 patch；加字段三步）；预开提交闸门 `preOpenSubmitLeadMs`（默认 0 = 对准 T0）；驱动不热加载槽位（改槽位 stop→launch）；体检只查 slots[0]（`--slot=` 支持但桥接不带参）；保活守护控制口 `127.0.0.1:3101`（/ping = 状态权威；中途被停不会自动重启，巡检查 `/api/keepalive/status`，恢复 `POST /api/keepalive/start`）；派发定时用自动化任务 / `core/deferred-timers.mjs` / `tools/dispatch-huawei.mjs`（幂等）；`--only` 精确闸门 + 任何写商品列表入口后必须 `renderOnlyPicker()`。
- 「抢购未中」排查三件套：① 取证 events 有无 `UNLOCK_SEEN`（无 = 按钮从未出现）② 直读 `queryRushbuyInfo.skuStatus`（开售前=1、售罄=2）③ buttonMode（1 现货/2 即将/9-10 缺货/29 未开售且**开售后不翻转**）。
- 挪含 let/const 代码块时声明一起挪（TDZ）；`tsc --noEmit --allowJs --checkJs --target ES2022 --module ES2022 --moduleResolution bundler --skipLibCheck` 后 grep `TS2448|TS2454` 静态扫。
- 遗留待清理：用户自建 Windows 计划任务 10:00 跑旧路径 `scripts\*.mjs`（已失效报模块找不到，输出 `data/grab/schtasks.log`）。
- **★ `uiautomator dump` 在"有持续动画的页面"上会一直 `ERROR: could not get idle state.` 且不写文件（0 字节）**
  → 拿到的空文件别当证据（2026-10-09 我据此误判过一次）。**判 dump 有效性先看大小/节点数**。
  Agent 本身不走 uiautomator（用无障碍 `id().findOnce()` 直查），不受此影响；诊断快照接口已把 dump 失败降级为"仅截图"。
- **大麦抢购的成熟路线（2026-10-09 调研）** = 盯**按钮文案/结构变化**（不是像素、不是固定时间戳）：
  开源 ticket-purchase 盯"立即预订/立即购买/选座购买"文案；AutoJs6 作者原话"**按钮状态才是唯一可信的准点信号**"、
  "到点前几秒高频但**避免毫秒级重复点击**"、"**忽略电池优化+后台白名单**防定时任务延迟"；
  PC 端 DamaiGrabber 用 ADB+uiautomator2+"纯坐标连点"（与我们同构）；AutoJs6 甚至**不支持区域截图**（像素方案更慢）。
- **★ 页面身份只认标题节点**（2026-10-09 修掉"跑错站"真 bug）：`cn.damai:id/info_v2_title_tv1`（标题含城市+站名）。
  原来的 `grabKeywordsOk` 是**全页 textContains 搜字** → 巡演站选择器里列着**所有**站名，
  于是"给厦门站布防、手机却停在贵阳站"也能通过核对 → 脚本不跳转、在**错误商品**上蹲守（实测复现）。
  现行规则：① 只用标题比对；② `target.session`（目标站名）**必须出现在标题里**，否则直接否决；
  ③ 标题读不到才退化全页并上报 `page_id_degraded`。
- **第三重文案兜底只留"反向判据"**：实测 预约态(pos0,neg1) / 已开售(pos0,neg0) ——
  "立即购买/立即预订/缺货登记"等正向词条**两态都读不到**（画在画布上），已清空不作依赖；
  有效的是"…开抢"这行字**开售后从可读文本消失**（它按文字找、不按 id 找，改版换 id 时仍有效）。
- 落点抖动**分 XY 轴**：`jitterXPx`/`jitterYPx`（控制台两个输入框；旧 `jitterPx` = 两轴最大值）。
  **语义 = 每个值是"上限"**：每次点击在 `-上限~+上限` 随机、两轴各自独立且**每次同时生效**（`jitterInt = round(base+(random*2-1)*amp)`）；0 = 不抖。
- **改控制台参数区后必须核对所有 input id 都在位**（2026-10-09 我误删 `grab-ft-timeout` 导致布防整条会抛错）；
  `numVal` 已改为"元素缺失返回默认值"兜底，但新增/删除字段仍要回查一遍 id 与 `GRAB_FIELDS` 清单。
- 中枢 `taskStates` 只保留最近 30 条 → 记录被清理后任务**撤不掉**（手机还在跑）。
  已加 `deviceCancelOverride`（cancel 找不到记录时按"设备当前任务"登记，心跳回带 `cancelTaskId`）。

## 四、测试约定
- 本机跑测：`cp node_modules/@esbuild/win32-x64/esbuild.exe /tmp/esb-test/esbuild.exe` + `ESBUILD_BINARY_PATH=/tmp/esb-test/esbuild.exe npm test`（低完整性级别目录的绕行；2026-10-09 52/52 全绿）。
- 闸门/判据类改动必跑对应实测脚本（verify-list-gate / verify-spa-gate / verify-login-* / verify-picker-refresh / verify-keepalive-control / verify-damai-probe / verify-damai-console-ui）。
- 垫片必须真实现（真回调/真代理）；测闸门必须同时验对照组；槽位/换绑类自测零副作用；控制台页面代码包在函数里 → 用 DOM 交互测，不能内省变量。
- 服务常驻/"窗口弹不弹"类验证借用户环境（用户点 bat/按钮，我旁采样 `verify/sample_windows.py`）。
- 常规控制台操作用户自己点；我只做界面解决不了的代码行为层改动。

## 五、大麦移动端执行面（2026-10-09 下午 grab 重写后）
- 链路：hub-console「🔗 链接抢购」卡片 → `POST /api/tasks/dispatch`（`mode:'grab'`，校验 itemId 纯数字 + fireAt）→ 手机 agent `executeDamaiGrab`：就位→页面核对→信号锚定→对时→低频预监视→T0-1s 高频突变检测→瞬间首击→拟人连点链→提交风暴→readResult。
- **链接直达（实测）**：分享链接 `/shows/item.html` 系统解析不到 App；改用 `am start -a VIEW -d 'damai://detail' --es itemId <ID> -p cn.damai` → 精确命中 `ProjectDetailActivity`。hub `/api/adb/open-item` 内置备用入口序列（trade/detail、projectdetail、perform/item.html、PRO_DETAIL）；闸门 = 纯数字 + 必须在探针库。
- **检测信号（真机 dump 实证）**：底栏主按钮 = 自绘空容器（无文本/无子节点/clickable=false，中心 (682,2305)）；`tv_left_main_text` 预约态**不存在**（有票态才有）；倒计时数字 = 自绘 View 不可读。信号元组 = `tv文本 | 容器(childCount/text/desc/clickable/中心) | btn_buy | btn_buy_view`，任一变化即击发；容器消失时只认"正向信号"（防一次读异常误触）；异常不影响（全 catch）。
- **点击通道**：自绘控件只认 PC-ADB。hub 内置**常驻 adb shell**（持久进程经 stdin 写命令）：连发 ≈29ms/次、echo 往返 3ms（对比每次 spawn adb.exe ≈210ms）；失活自愈 + 回落 execSync。`/api/adb/tap-burst` = 一次写入 N 枚（count/gapMs/jitter/pressMs）。
- 击发策略：首击纯 ADB、无校验 sleep；随后拟人连点（±3px、按压 38-55ms、间隔 200-350ms）直到页面跳转（Activity 变化；超时即转无脑）；跳转后超高频连点（微瞄准 btn_buy_view/提交订单，burst 5、gap 30）直到支付/成功/验证码/超时；保底 = 到点未检测到变化盲点一发；迟到 >5s 拒绝盲点；彩排 dryRun 只检测不点击。
- 「🧪 检测通道自测」：基线 3s 采样 + 自动点「想看」触发真实变化测发现延迟（测完还原）。
- 旧 rush 全自动流程已删除（hub 拒 rush；`run-drill --rush` 提示改道；agent 保留 test/dryrun/buy 演练直通流）。
- 关键文件：`core/device-hub.mjs`（open-item/tap-burst/常驻通道/dispatch grab 白名单 clamp）；`platforms/app/agent/{runner.js(executeDamaiGrab), adapters/damai.js(§13 grab), transport.js(adbOpenItem/adbTapBurst)}`；`web/hub-console.html`（新卡片 + parseItemId/onGrabLinkInput/grabArm/grabSelfTest 等）；测试 `tests/mobile/grab-logic.test.mjs` + `verify-device-hub.test.mjs`（12 项）。改 agent 必须 `npm run agent:build` 再经控制台推送。
- 大麦探针口径：探针 = Playwright 无头拦截 `mtop.damai.item.detail.getdetail`（直连 HTTP 必被反爬）；字段：巡演站 = `guide.tour.projectList[]`、场次 = `performRules[].performDate`、开售提示 = `desc.introduce` 正则；catalog 按站 merge（当前站全量 + 其它站概要，补采升级不降级）；`/api/probe` 与 hub 代码改动 → 必须重启中枢。
- 实名信息：观演人档案/大麦配置已移出仓库 + 忽略（本地保留）；公开历史仍含旧数据（彻底清除需重写历史，待定）；新增含个人信息的配置文件先问"要不要入库"。
- vivo 特性：系统窗（VDialog/DMThemeDialog）会间歇抢占 active window → 该时段节点查询全空，需重试容忍；ASM 脚本拉起 = `org.autojs.autoxjs.v7/...RunIntentActivity -d file://`。
- **★ 检测信号必须盯"结构"，不能盯自绘按钮的节点属性**（2026-10-09 17:17 实战失败实证，已定案并修复）：
  大麦底栏按钮是自绘控件 → 无障碍树里只有一个**静态占位容器**，开售前后 `childCount/text/desc/clickable/中心` **完全不变**；
  `tv_left_main_text`/`btn_buy`/`btn_buy_view` 在详情页**根本不存在**。
  → 旧信号（容器五属性 + 那三个 id）在"预约态"与"开售后"两态下**字符串完全一致**，永远不可能触发
  （两张真机 dump 差集实证；同期用户目视确认按钮准点变了）。
  **正确信号 = 预约结构成片消失**：`id_new_project_normal_count_down_layout`（倒计时整块）
  + `id_project_count_sell_time`（开抢时间文本）+ `id_project_ticket_remind_me`（预约提醒），
  三者中 ≥2 项从有到无 ⇒ 开售。
  **候选已放宽到 6 项**（另加 `id_project_count_down_remind_layout`、`id_project_count_down_layout`、`tour_city_select_bg`），
  规则 = 6 项里 **≥2 项从有到无**；容器属性变化仅作兜底。**本项目已明确放弃"像素/截图"检测方案**（更慢且会拖慢触摸响应）。
  **观察窗已被用户明确移除**（"等观察窗那早没票了"）：盯梢**绝不提前放弃**，一有变化立即出手；
  只保留 `watchHardCapMs`（10 分钟）**兜底闸门防任务永久挂住**（名字不叫观察窗，超时报 `watch_timeout`）。
  回归护栏（`tests/mobile/grab-logic.test.mjs`）：源码不得含 `blind_deadline` / `postFireWatchMs`，控制台不得有 `grab-watch-ms`。
  ⚠️ 干扰项：`id_new_project_grab_tip_text` 与「预售 | 本商品为预售…」都是**滚动词条**，绝不可作信号。
  ⚠️ 防假信号：整页读失败时所有结构都会"消失" ⇒ 结构触发必须要求**底栏容器仍可读**；且双读确认窗口拉到 80ms。
- **★ 改中枢（device-hub）代码必须重启中枢**，否则新增的 `grab.*` 字段会被白名单**静默丢弃**、回退旧默认；
  旧中枢在跑时想临时生效，只能下发它认识的旧字段（自行按 `deriveCadence` 算好 `gapMinMs/gapMaxMs/pressMinMs/pressMaxMs`）。
- 设备 busy 时新任务会**排队**（不会自动替换）→ 换参必须**先 `POST /api/tasks/cancel` 再 dispatch**。
- 手机端节拍/通道参数链路（2026-10-09 起）：控制台只填"最少/最多 几下每秒"→ `deriveCadence(rateMin,rateMax,rtt)` 反解间隔与按压；
  通道「有数据线优先走 127.0.0.1（adb reverse），没插线才 WiFi」（实测往返 9~14ms vs WiFi 40ms+）。
  数据线拔掉后 `adbDevicesCount=0`、推送脚本（走 USB）会直接失败 → 需要重插线；hub 会自动回落 WiFi 地址。
