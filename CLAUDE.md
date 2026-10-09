# QG 抢购中枢 (Flash Sale System)

稀缺名额与稀缺商品抢购平台：大麦移动端 (AutoJs6 真机自动化) + 华为商城 (PC CDP 多账号)。

## 常用命令

```bash
npm run hub            # 启动设备中枢 (控制台 http://localhost:3120)
node core/hub-launcher.mjs --start|--stop|--status   # 中枢启停/状态（「启动/停止-手机中枢」bat 的内核）
node check-windows-env.mjs                           # Windows 环境自检（或双击 自检-Windows环境.bat）
npm run drill          # 向手机下发大麦安全演练 (停在提交前)
npm run drill:rush     # 下发正式抢票
npm run agent:build    # 重新打包手机端 Agent 单文件 main.js (源码在 platforms/app/agent/)
npm run device:prepare # USB 真机环境一键整备 (无障碍/动效/端口代理)
npm run huawei:slots-check  # 华为抢购槽位窗口登录预检
npm test               # 单元测试 (vitest)
```

## 架构速览

- `core/device-hub.mjs` — 设备中枢：USB/Wi-Fi 双模通信、任务队列、事件流、一键连接
- `web/hub-console.html` — 抢购中枢控制台 (hub 直接服务)
- `platforms/app/agent/` — 手机端 AutoJs6 Agent 源码；`tools/mobile/bundle-agent.mjs` 打包为免依赖单文件
- `platforms/app/agent/adapters/damai.js` — 大麦适配器 (页面状态机/搜索直达/选票/观演人/地址)
- `platforms/damai/` — 观演人档案、探针
- `platforms/huawei/` — 华为商城 CDP 抢购 (cdp-rush.mjs 多槽位并行)
- `data/grab/` — 配置与运行时数据 (damai.config.json / regions.json / rush-slots.huawei.json)

## 关键约定

- 手机端脚本改动后必须 `npm run agent:build` 再经控制台「更新手机脚本」推送
- 添加观演人/地址任务依赖手机 `/sdcard/qg-agent/regions.json` (一键连接时自动推送)
- 大麦部分自绘控件 (SKU 票档滚轮) 无视无障碍手势，Agent 已内置 PC-ADB 注入兜底通道
- 测试: `npm test`；提交前必须全绿
- Windows .bat 规范：一律 CRLF；含中文的 bat 必须 GBK 编码 + `chcp 936`（禁止 UTF-8 / BOM + `chcp 65001` 组合——cmd 解析会错位甚至直接崩退）；纯 ASCII 的 bat 内不要写中文，中文输出交给 node 脚本打印
- 手机中枢启停走 `core/hub-launcher.mjs`（勿在 bat 里写进程查找——PowerShell 转义极易写错）；环境自检逻辑在 `check-windows-env.mjs`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.
