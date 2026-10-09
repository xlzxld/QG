# QG 抢购项目

个人学习研究用的「辅助抢购」工具集。只做可信点击 / 只走页面自身的请求，不做任何协议伪造。

两大入口：

1. **QG 抢购中枢 (大麦移动端)** — 手机 AutoJs6 Agent + 电脑中枢控制台，USB/Wi-Fi 双模。
2. **华为商城抢购 (PC)** — CDP 真点击多槽位并行（详见 `docs/`）。

## 快速开始 (大麦移动端)

```bash
npm install
npm run hub                 # 启动中枢, 浏览器打开 http://localhost:3120
```

手机侧只需：**USB 连接 + 开启 USB 调试 + 安装 AutoJs6**，然后在控制台点「⚡ 一键连接设备」——
自动完成：设备检测 → 端口代理 → 推送 Agent 脚本与省市区数据 → 拉起 Agent → 验证上线。
之后「一键安全演练」即可全流程验证（安全停在提交前，绝不扣款）。

## 快速开始 (华为商城)

```bash
node platforms/huawei/crawler-huawei.mjs        # 采集 SKU
node tools/check-slot-logins.mjs                # 槽位登录预检
node platforms/huawei/cdp-rush.mjs              # 所有槽位并行开抢
```

配置：`data/grab/huawei.config.json`（商品/限额/节奏）+ `data/grab/rush-slots.huawei.json`（账号槽位绑定）。

## 目录导览

| 目录 | 放什么 |
|---|---|
| `core/` | 设备中枢 (device-hub)、CDP 底座、桥接服务 (:3100)、启动器、演练 CLI |
| `web/` | `hub-console.html` 抢购中枢控制台 + 华为工作台页面 |
| `platforms/app/agent/` | 手机端 AutoJs6 Agent 源码（`npm run agent:build` 打包成免依赖单文件） |
| `platforms/damai/` | 大麦观演人档案、演出探针 |
| `platforms/huawei/` | 华为驱动 / 采集 / 体检 / 接口 / 拦截 |
| `tools/mobile/` | 真机整备、Agent 打包器 |
| `tools/` | 槽位预检等运维小工具 |
| `verify/` | 回归验证工具 |
| `docs/` | 技术文档与审计（历史方案在 `docs/archive/`） |
| `data/grab/` | 配置 / 槽位 / 结果 / 体检（登录态与临时产物不入库） |
| `tests/` | 单元测试 (vitest) |

## 常用命令

```bash
npm run hub                 # 设备中枢控制台 (:3120)
node core/service-menu.mjs  # 服务启停台（启动/停止/重启/状态；双击 服务启停.bat）
npm run drill               # 大麦安全演练
npm run agent:build         # 改手机端源码后重新打包
npm run device:prepare      # USB 真机一键整备
npm run huawei:slots-check  # 华为槽位登录预检
npm test                    # 单元测试
```

操作手册： [`使用说明.md`](使用说明.md) ｜ 边界与红线： [`docs/限制规则清单.md`](docs/限制规则清单.md)

## 铁律（改代码前先读 `docs/限制规则清单.md`）

- **商品列表 = 唯一白名单**：清单外不开窗、不点击、不发请求；匹配失败按错误处理，不兜底。
- 下单动作必须通过页面自身代码发起；不构造、不重放请求；验证码一律转人工。
- 桥接不热加载：改 `core/` 后重启服务（双击 `服务启停.bat` → 按 3 重启全部）；子进程一律 `windowsHide: true`。
- 手机端 Agent 改动后必须 `npm run agent:build` 并经控制台「更新手机脚本」推送。

## git

本仓库已纳入 git（远程 `QG`）。回退锚点：tag `baseline-pre-restructure`（重组前）、`ebe8e4a`（重组）、`693ed86`（回归修复）。
