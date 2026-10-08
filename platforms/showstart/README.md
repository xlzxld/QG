# 秀动（ShowStart）· 待开发的第二平台（占位）

本目录是「秀动演出抢票」平台的落地位。**当前为占位**（原型阶段，尚未开发）。

## 现状（2026-10-08 结构重组后）
- 前端已有原型页：`web/platforms/console-showstart.html`（静态演示，未接真实数据）
- 应用清单已登记：`data/grab/manifest.json` → showstart（`status: prototype`）
- 桥接已开路由：`/console-showstart`

## 下一步（待启动时）
1. 站点侦察（只读）：登录方式 / 演出页结构 / 购票流程 / 接口
2. 落地文件：
   - `platforms/showstart/crawler-showstart.mjs`（采集演出票档）
   - `platforms/showstart/showstart-rush.mjs`（抢票驱动，桥接按 manifest 派发）
   - `data/grab/showstart.config.json` + `data/grab/rush-slots.showstart.json`
   - `data/grab/crawlers.json` 登记一行
3. 控制台从原型做真（接 `/api/*/showstart`；页面放 `web/platforms/`）

平台接入约定详见 `docs/加新平台.md`。
