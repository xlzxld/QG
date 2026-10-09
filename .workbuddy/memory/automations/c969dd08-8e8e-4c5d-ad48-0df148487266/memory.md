# 自动化：华为抢购结果巡检

## 定位
只读巡检任务：拉驱动状态 + 结果流水 → 汇总每槽位一行 → 追加 `data/grab/auto-dispatch-log.md`
→ 向 `/api/results/huawei` 回传一条 REVIEW/SUMMARY → 回复简报。
**硬约束：不改配置、不停驱动、不派发、不重启服务。**

## 固定接口
- `GET http://127.0.0.1:3100/api/dispatch/status?platform=huawei`（看 log 尾部 + slots）
- `GET http://127.0.0.1:3100/api/results/huawei?limit=30`
- `POST http://127.0.0.1:3100/api/results/huawei`（body: at/profileId=auto-review-<HHMM>/REVIEW/SUMMARY/message）
- curl 一律加 `--noproxy '*'`

## 判读要点
- 槽位态看 log 尾部的 `[accX]` 行：`到点即点` → `SKU 缺货` → `转回流监控` → `MONITORING` 结果回传。
- 异常定义：`running=false` / `lastExit` 非空 / 某槽位无任何出手记录 / 全部 FAILED。
- 回流监控中照实记录，不等待不干预。
- 已知非故障项：`scanSboms` 只有 1 个规格时回流监控降级为整页刷新探测（warn，不是错）。

## 执行历史
- 2026-10-09 10:12：三槽位（acc1 Mate 90 Pro Max / acc2 Mate XT 2 / acc3 Pura X View，均 10:08 开售）
  全部到点出手、均未抢到（SKU 缺货）、全部转回流监控（acc2 守至 10:35 / acc1 11:35 / acc3 12:08）。
  驱动 running=true 无异常。已写日志 + 回传 auto-review-1012。全程零操作。
  （附带：MEMORY.md 超限，已压缩重整并备份为 MEMORY.md.bak-20261009。）
