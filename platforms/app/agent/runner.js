/**
 * runner.js - APP端核心调度逻辑
 * 职责：环境初始化、双模通信初始化、周期心跳、接收PC端下发指令并派发执行
 * 2026-10-09 重构:
 *   - 心跳状态联动任务执行 (busy + taskId)
 *   - 抢购热路径: 开售前就位详情页 → 最后 1 秒高频监测按钮 → 瞬间击发
 *   - 全流程 step 事件上报, PC 控制台可实时显示执行进度
 */

function main() {
    // 屏蔽端侧悬浮窗，避免遮挡手机屏幕交互控件与干扰无障碍
    try { console.hide(); } catch (e) {}
    try { device.wakeUp(); device.keepScreenOn(3600 * 1000); } catch (eW) {}
    console.log("🚀 QG-Agent 移动端自动化抢购引擎启动...");

    // 1. 环境初始化
    Bootstrap.checkEnvironment();

    // 2. 建立双模通信
    Transport.init();
    Transport.hello();

    // 3. 启动周期心跳 (每 4 秒一次, 状态随任务联动)
    setInterval(function() {
        Transport.sendHeartbeat(Transport.taskState || "idle", Transport.currentTaskId || null);
    }, 4000);

    // 4. 启动长轮询接收 PC 任务派发
    Transport.startLongPoll(function(task) {
        handleTask(task);
    });

    try {
        toast("⚡ QG-Agent 抢购引擎就绪！\n已连接控制台中枢: " + (Transport.activeHubUrl || "局域网待命"));
    } catch (eT) {}
    console.log("🎉 Agent 就绪！进入待命状态，等待 PC 派发抢购或新增任务...");
}

/**
 * 核心任务执行引擎
 */
function handleTask(task) {
    Transport.taskState = "busy";
    Transport.currentTaskId = task.taskId;
    try {
        console.log("==========================================");
        console.log("🎯 开始执行任务: " + task.taskId + " [" + task.platform + "/" + task.mode + "]");
        console.log("==========================================");
        Transport.sendEvent(task.taskId, "task_started", {
            mode: task.mode,
            target: task.target ? task.target.name : "",
            ts: java.lang.System.currentTimeMillis()
        });

        var platform = task.platform || "damai";
        var mode = task.mode || "rush";

        if (platform === "damai") {
            if (mode === "add_viewer") {
                var addVRes = DamaiAdapter.addViewer(task);
                addVRes.taskId = task.taskId;
                addVRes.platform = "damai";
                Transport.sendResult(addVRes);
                return;
            }
            if (mode === "add_address") {
                var addARes = DamaiAdapter.addAddress(task);
                addARes.taskId = task.taskId;
                addARes.platform = "damai";
                Transport.sendResult(addARes);
                return;
            }
            if (mode === "monitor") {
                // P0a 只读余票盯梢模式
                MonitorAdapter.runLoop(task, function(newStatus) {
                    Transport.sendEvent(task.taskId, "ticket_status_change", { status: newStatus });
                });
            } else {
                // P0b / P1 准时击发抢票模式 / 安全演练
                executeDamaiRush(task);
            }
        } else {
            console.warn("暂未实现的平台适配器: " + platform);
        }
    } catch (e) {
        console.error("【任务执行抛错】" + (e ? (e.message || e) : "未知异常"));
        Transport.sendResult({
            taskId: task.taskId,
            platform: task.platform || "damai",
            outcome: "failed",
            evidence: "运行时异常: " + (e ? (e.message || e) : "未知异常")
        });
    } finally {
        Transport.taskState = "idle";
        Transport.currentTaskId = null;
    }
}

/**
 * 大麦抢票执行流水线
 * 演练/立即购买: 全流程推进 → 确认订单页 → (演练停在提交前 / buy 直通提交)
 * 定时抢购: 就位详情页 → 服务器对时 → 倒计时 → 最后 1 秒高频监测 → 瞬间击发
 */
function executeDamaiRush(task) {
    var tid = task.taskId;

    // 1. 唤起大麦 (热启动, 绝不重启进程)
    DamaiAdapter.ensureForeground(tid);

    // 2. 就位演出详情页 (DeepLink / 搜索兜底 / 已在选票或订单页直接复用)
    var positioned = DamaiAdapter.gotoDetail(task, tid);
    if (!positioned) {
        Transport.sendResult({
            taskId: tid,
            platform: "damai",
            outcome: "failed",
            evidence: "未能就位演出详情页 (检查演出名称/ID 或手机页面状态)"
        });
        return;
    }

    // 3. 演练/立即购买模式: 直接推进全流程
    if (task.mode === "test" || task.mode === "dryrun" || task.mode === "buy") {
        var drawerOk = DamaiAdapter.openSkuDrawer(task);
        if (!drawerOk) {
            Transport.sendResult({
                taskId: tid,
                platform: "damai",
                outcome: "failed",
                evidence: "选票抽屉未能展开 (购买按钮不可用或页面异常)"
            });
            return;
        }
        DamaiAdapter.selectSku(task);

        // 点击抽屉「确定」进入确认订单页
        DamaiAdapter.confirmSkuDrawer(tid, false);
        sleep(800);

        var orderResult = DamaiAdapter.handleOrderConfirm(task);
        if (orderResult && typeof orderResult === "object") {
            orderResult.taskId = tid;
            orderResult.platform = "damai";
            Transport.sendResult(orderResult);
            return;
        }
        var result = DamaiAdapter.readResult(task);
        result.taskId = tid;
        result.platform = "damai";
        Transport.sendResult(result);
        return;
    }

    // ===== 定时抢购模式 (rush) =====
    // 4. 预热: 展开抽屉并装配 SKU, 停留在抽屉「确定」前
    var primeOk = DamaiAdapter.openSkuDrawer(task);
    if (primeOk) {
        DamaiAdapter.selectSku(task);
        // 预锚定「确定」按钮坐标 (T-0 毫秒查找击发)
        var btn = id("cn.damai:id/btn_buy").findOne(800) ||
                  id("cn.damai:id/btn_buy_view").findOne(800) ||
                  text("确定").findOne(500);
        if (btn && btn.bounds) {
            var bb = btn.bounds();
            AnchorFire.cachedPoint = { x: Math.floor(bb.centerX()), y: Math.floor(bb.centerY()) };
            AnchorFire.anchoredAt = java.lang.System.currentTimeMillis();
            sendLog(tid, "[预热] 已锚定抽屉确定按钮坐标 (" + AnchorFire.cachedPoint.x + "," + AnchorFire.cachedPoint.y + ")");
        }
    }

    // 5. 服务器对时
    sendLog(tid, "[对时] 执行大麦 MTOP 毫秒级时钟采样...");
    var syncResult = TimeSync.syncDamai();
    Transport.sendEvent(tid, "timesync_done", syncResult);

    var fireTargetEpoch = (task.timing && task.timing.fireAtEpochMs) || (java.lang.System.currentTimeMillis() + 8000);
    var leadMs = (task.timing && task.timing.leadMs) || 40;

    // 6. 倒计时 → 临界击发 (点击抽屉确定 → 进入确认订单 → 提交)
    TimeSync.waitToFire(fireTargetEpoch, leadMs, function() {
        sendLog(tid, "[击发] T0 到点, 击穿选票面板确定按钮!");
        if (AnchorFire.cachedPoint) {
            AnchorFire.fire();
        } else {
            DamaiAdapter.confirmSkuDrawer(tid, true);
        }
    });

    sleep(600);
    DamaiAdapter.dismissPopupsLoop(2);

    var orderResult2 = DamaiAdapter.handleOrderConfirm(task);
    if (orderResult2 && typeof orderResult2 === "object") {
        orderResult2.taskId = tid;
        orderResult2.platform = "damai";
        Transport.sendResult(orderResult2);
        return;
    }
    var result2 = DamaiAdapter.readResult(task);
    result2.taskId = tid;
    result2.platform = "damai";
    Transport.sendResult(result2);
}

main();
