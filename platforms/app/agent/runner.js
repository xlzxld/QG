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

    // 5. 控制指令消费 (停止脚本 / 自更新) —— 2026-10-09 新增
    //    修复: 中枢下发的 stopAgent / selfUpdate 以前只置了标志位、没人消费 → 两个按钮形同无效
    setInterval(consumeControl, 1000);

    try {
        toast("⚡ QG-Agent 抢购引擎就绪！\n已连接控制台中枢: " + (Transport.activeHubUrl || "局域网待命"));
    } catch (eT) {}
    console.log("🎉 Agent 就绪！进入待命状态，等待 PC 派发抢购或新增任务...");
}

/**
 * 控制指令消费 (1s tick) —— 中枢 «停止手机脚本» / «更新手机脚本并重启» 的唯一落地点。
 * 两个指令都经心跳响应回带 (见 transport.js sendHeartbeat 的 control 分支)。
 */
function consumeControl() {
    try {
        if (typeof Transport === "undefined") return;
        if (Transport.updateRequested) { Transport.updateRequested = false; restartWithLatestScript(); }
        if (Transport.stopRequested) { Transport.stopRequested = false; stopAgentNow(); }
    } catch (e) {
        console.error("【控制】指令消费异常: " + (e ? (e.message || e) : "?"));
    }
}

/**
 * 自更新: 从中枢 /agent/main.js 下载最新脚本覆盖本地 → 重启脚本让新代码生效。
 * 前提: 手机能连到中枢 (USB 反向或 WiFi 都行)。
 */
function restartWithLatestScript() {
    console.log("【自更新】开始下载并覆盖本地脚本…");
    var r = null;
    try { r = Transport.selfUpdate(); } catch (e) { r = { ok: false, reason: (e ? (e.message || e) : "?") }; }
    if (!r || !r.ok) {
        var why = (r && r.reason) || "未知";
        console.warn("【自更新】失败: " + why);
        try { Transport.sendEvent(null, "log", { msg: "【自更新】下载失败: " + why }); } catch (e1) {}
        return;
    }
    var kb = Math.round((r.size || 0) / 1024);
    console.log("【自更新】已覆盖本地脚本 " + kb + " KB, 重启中…");
    try { Transport.sendEvent(null, "log", { msg: "【自更新】已覆盖本地脚本 " + kb + " KB, 重启脚本" }); } catch (e2) {}
    sleep(400);
    try {
        var src = String(engines.myEngine().source);
        engines.execScriptFile(src);   // 先起新引擎 (新代码先跑起来)
        sleep(600);
        engines.myEngine().forceStop(); // 再停旧引擎, 避免"先停后起"中间断线
        return;
    } catch (e3) {
        console.warn("【自更新】自动重启失败, 请在手机上重开脚本: " + (e3 ? (e3.message || e3) : "?"));
        try { Transport.sendEvent(null, "log", { msg: "【自更新】脚本已更新, 自动重启失败, 请手动重开脚本" }); } catch (e4) {}
    }
}

/** 停止脚本: 先把在跑的任务收尾上报 (避免控制台一直显示"执行中"), 再退出 */
function stopAgentNow() {
    var tid = Transport.currentTaskId || null;
    console.warn("【停止】收到中枢停止指令, 脚本退出" + (tid ? " (同时终止任务 " + tid + ")" : ""));
    try {
        if (tid) Transport.sendResult({ taskId: tid, platform: "damai", outcome: "cancelled", reason: "manual_abort", evidence: "控制台停止手机脚本, 任务随之终止" });
    } catch (e1) {}
    try { Transport.sendEvent(null, "log", { msg: "【停止】收到中枢停止指令, 脚本退出" }); } catch (e2) {}
    try { toast("🛑 已按控制台指令停止脚本"); } catch (e3) {}
    sleep(500);
    try { engines.stopAll(); } catch (e4) {}
    try { exit(); } catch (e5) {}
}

/** 手机本地手势 (WiFi 通道下 phone_op/gesture 用; 不需要 ADB) */
function localGesture(x, y, pressMs) {
    try {
        if (typeof press === "function") return press(x, y, pressMs || 40) !== false;
        if (typeof click === "function") return click(x, y) !== false;
    } catch (e) {}
    return false;
}

/**
 * 手机本地执行指令 (mode=phone_op) —— 2026-10-09 新增。
 * 中枢在 WiFi 通道下没有 ADB, 无法代为操作手机; 改为把指令下发到端侧, 由本地能力执行。
 * 支持的 op: open_item (本地 deep-link 打开商品页) / gesture (本地无障碍手势)
 */
function executePhoneOp(task) {
    var tid = task.taskId;
    var op = task.op;
    var p = task.params || {};
    var out = { taskId: tid, platform: "damai", outcome: "failed", reason: op || "phone_op" };
    try {
        Transport.sendEvent(tid, "task_started", { mode: "phone_op", target: op || "" });
        if (op === "open_item") {
            Transport.sendEvent(tid, "step", { step: "item_open", status: "start" });
            var r = Transport.openItemLocal(String(p.itemId || ""));
            var landed = !!(r && r.ok) && DamaiAdapter.grabOnDetailPage();
            out.outcome = landed ? "success" : "failed";
            out.message = "本地 deep-link 打开商品页";
            out.evidence = landed ? ("已打开 (" + (r.hit || "") + ")") : ("未落到详情页: " + ((r && r.error) || ""));
            out.data = { hit: (r && r.hit) || "", tried: (r && r.tried) || [], via: "local" };
            Transport.sendEvent(tid, "step", { step: "item_open", status: landed ? "done" : "failed", detail: out.evidence });
        } else if (op === "gesture") {
            var gx = Number(p.x), gy = Number(p.y);
            var okG = (isFinite(gx) && isFinite(gy)) ? localGesture(gx, gy, Number(p.pressMs) || 40) : false;
            out.outcome = okG ? "success" : "failed";
            out.message = "手机本地无障碍手势";
            out.evidence = okG ? ("已注入手势 (" + gx + "," + gy + ")") : "手势注入失败 (无障碍通道异常)";
        } else {
            out.evidence = "未知 phone_op: " + op;
        }
    } catch (e) {
        out.evidence = "phone_op 执行异常: " + (e ? (e.message || e) : "?");
    }
    Transport.sendResult(out);
}

/**
 * 判断某任务是否被中枢请求终止 (取消指令经心跳响应回带, 见 transport.js sendHeartbeat)
 */
function isTaskCancelled(tid) {
    return !!(typeof Transport !== "undefined" && Transport.cancelRequestedTaskId && Transport.cancelRequestedTaskId === tid);
}

/**
 * 上报「已手动终止」结果 (手机端在检查点就地停下后调用)
 */
function reportCancelled(tid, evidence) {
    console.log("【任务终止】" + tid + " 收到中枢终止指令, 就地停下");
    Transport.sendResult({
        taskId: tid,
        platform: "damai",
        outcome: "cancelled",
        reason: "manual_abort",
        evidence: evidence || "用户手动终止任务"
    });
}

/**
 * 核心任务执行引擎
 */
function handleTask(task) {
    Transport.taskState = "busy";
    Transport.currentTaskId = task.taskId;
    Transport.cancelRequestedTaskId = null; // 清除上一轮残留的取消标记, 避免误伤新任务
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
        var mode = task.mode || "test";

        if (platform === "damai") {
            if (mode === "phone_op") {
                // 中枢 WiFi 通道下的"代操作"降级入口 (打开商品页 / 本地手势)
                executePhoneOp(task);
                return;
            }
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
                // runLoop 能正常返回只有一种情况: 收到手动终止指令
                if (isTaskCancelled(task.taskId)) reportCancelled(task.taskId, "余票盯梢已手动终止");
            } else if (mode === "grab") {
                // 链接抢购 (2026-10-09 重写): 链接就位 → 页面核对 → 锚定 → 高频突变检测 → 首击 → 连点链
                executeDamaiGrab(task);
            } else {
                // 安全演练 / 立即购买 (直通流; 旧 rush 全自动流程已下线)
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
 * 大麦演练/立即购买 直通流水线
 * (旧「定时抢购 rush」全自动选票 + T0 锚定击发流程已于 2026-10-09 整体删除:
 *  前置准备改由用户在 App 内手动完成, 抢购执行统一走 mode='grab' → 见 executeDamaiGrab)
 */
function executeDamaiRush(task) {
    var tid = task.taskId;

    // 1. 唤起大麦 (热启动, 绝不重启进程)
    DamaiAdapter.ensureForeground(tid);
    if (isTaskCancelled(tid)) { reportCancelled(tid, "唤起阶段被手动终止"); return; }

    // 2. 就位演出详情页 (DeepLink / 搜索兜底 / 已在选票或订单页直接复用)
    var positioned = DamaiAdapter.gotoDetail(task, tid);
    if (isTaskCancelled(tid)) { reportCancelled(tid, "就位阶段被手动终止"); return; }
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
        if (isTaskCancelled(tid)) { reportCancelled(tid, "打开选票页阶段被手动终止"); return; }
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
        if (isTaskCancelled(tid)) { reportCancelled(tid, "选票阶段被手动终止"); return; }

        // 点击抽屉「确定」进入确认订单页
        DamaiAdapter.confirmSkuDrawer(tid, false);
        if (isTaskCancelled(tid)) { reportCancelled(tid, "进入订单页前被手动终止"); return; }
        sleep(200);

        var orderResult = DamaiAdapter.handleOrderConfirm(task);
        if (orderResult && typeof orderResult === "object") {
            orderResult.taskId = tid;
            orderResult.platform = "damai";
            Transport.sendResult(orderResult);
            return;
        }
        if (isTaskCancelled(tid)) { reportCancelled(tid, "订单确认阶段被手动终止"); return; }
        var result = DamaiAdapter.readResult(task);
        result.taskId = tid;
        result.platform = "damai";
        Transport.sendResult(result);
        return;
    }

    // (旧「定时抢购 rush」全自动选票 + T0 锚定击发流程已于 2026-10-09 整体删除:
    //  前置准备改由用户在 App 内手动完成, 抢购执行统一走 mode='grab' → 见 executeDamaiGrab)
}

/**
 * 大麦「链接抢购」执行流水线 (2026-10-09 重写)
 * 就位(链接直达) → 页面核对 → 信号锚定 → 对时 → 低频预监视
 * → T0-1s 高频突变检测 → 瞬间首击(纯ADB) → 拟人连点链 → 提交风暴 → 结果
 * 彩排(dryRun) 例外: 不检测变化, 到点直接真打 (首击 + 4s 固定锚点超高频连点), 只测点击链路
 */
function executeDamaiGrab(task) {
    var tid = task.taskId;
    var grab = task.grab || {};
    // 通道: 任务开始强制重探 (有数据线就走数据线), 并实测往返给节拍换算
    try { Transport.detectHub(true); } catch (eHub) {}
    var chanProbe = Transport.calibrateChannel();
    DamaiAdapter.applyClickCfg(grab, chanProbe.ms);   // 点击参数 + 实测往返 → 反解间隔/按压
    Transport.sendEvent(tid, "channel_probe", { ms: chanProbe.ms, ok: chanProbe.ok, url: chanProbe.url });
    Transport.sendEvent(tid, "grab_armed", {
        itemId: task.target && task.target.itemId,
        dryRun: !!grab.dryRun,
        selfTest: !!grab.selfTest,
        hammer: !!grab.hammer,
        fireAt: task.timing && task.timing.fireAtEpochMs
    });

    // 0. 唤起大麦 (热启动, 绝不重启进程)
    DamaiAdapter.ensureForeground(tid);
    if (isTaskCancelled(tid)) { reportCancelled(tid, "就位前被手动终止"); return; }

    // 1. 链接就位 (已在目标页则复用; 否则请求中枢 am start 深度链接打开)
    var locate = DamaiAdapter.grabLocate(task, tid);
    if (isTaskCancelled(tid)) { reportCancelled(tid, "就位阶段被手动终止"); return; }
    if (!locate.ok) {
        Transport.sendResult({ taskId: tid, platform: "damai", outcome: "failed", reason: "locate_failed", evidence: "链接就位失败: " + (locate.reason || "") });
        return;
    }

    // 2. 页面核对闸门 (对不上 → 不动作 + 报警, 白名单纪律)
    var verify = DamaiAdapter.grabVerify(task, tid);
    if (!verify.ok) {
        Transport.sendResult({ taskId: tid, platform: "damai", outcome: "failed", reason: "page_verify_fail", evidence: "页面核对不通过, 已拒绝操作" });
        return;
    }

    // 3. 信号锚定 (基线 + 按钮坐标, 热路径零查找)
    var anchor = DamaiAdapter.grabAnchor(task, verify, tid);
    if (!anchor.ok) {
        Transport.sendResult({ taskId: tid, platform: "damai", outcome: "failed", reason: "anchor_failed", evidence: "无法锚定按钮坐标 (容器缺失且未配置)" });
        return;
    }

    // 4. 服务器对时
    var sync = TimeSync.syncDamai();
    Transport.sendEvent(tid, "timesync_done", sync);
    if (isTaskCancelled(tid)) { reportCancelled(tid, "对时后被手动终止"); return; }

    // 5. 通道自测分支 (盯按钮区域 + 触发一次真实变化测发现延迟)
    if (grab.selfTest) {
        var st = DamaiAdapter.grabSelfTest(task, anchor, tid);
        Transport.sendResult({
            taskId: tid, platform: "damai",
            outcome: st && st.detectMs >= 0 ? "success" : "failed",
            reason: "selftest",
            message: "检测通道自测",
            evidence: "基线变化 " + (st ? st.baselineChanges : "?") + " 次, 读取 " + (st ? st.readsPerSec : "?") + " 次/秒, 发现延迟 " + (st ? st.detectMs : "?") + "ms",
            data: st || null
        });
        return;
    }

    // 6. 预监视 → 高频突变检测 → 首击 (彩排模式: 不检测变化, 到点直接真打)
    var watch = DamaiAdapter.grabWatchAndFire(task, anchor, tid, !!grab.dryRun);
    if (watch.cancelled) { reportCancelled(tid, "监视阶段被手动终止"); return; }
    if (grab.dryRun) {
        Transport.sendResult({
            taskId: tid, platform: "damai",
            outcome: watch.fired ? "success" : "failed",
            reason: "rehearsal_tap",
            message: "彩排: 到点首击 ΔT0 " + watch.deltaMs + "ms, 接拟人连点 " + (watch.taps || 0) + " 击",
            evidence: "首击 ΔT0 " + watch.deltaMs + "ms · 连点 " + (watch.taps || 0) + " 击 / " + (watch.burstMs || 0)
                + "ms = 均 " + (watch.tapsPerSec || 0) + " 击/秒 · 峰值 " + (watch.peakPerSec || 0) + " 击/秒"
                + " (固定锚点 " + anchor.cx + "," + anchor.cy + ", 抖动间隔且 ≤20 击/秒, 彩排不打提交)",
            data: { deltaMs: watch.deltaMs, taps: watch.taps, tapsPerSec: watch.tapsPerSec, peakPerSec: watch.peakPerSec, burstMs: watch.burstMs }
        });
        return;
    }
    if (watch.late) {
        Transport.sendResult({ taskId: tid, platform: "damai", outcome: "failed", reason: "late_armed", evidence: "已过开抢时刻超过 5 秒, 拒绝出手 (防误点)" });
        return;
    }
    if (!watch.fired) {
        Transport.sendResult({
            taskId: tid, platform: "damai",
            outcome: "failed",
            reason: watch.watchTimeout ? "watch_timeout" : "not_fired",
            evidence: watch.watchTimeout
                ? ("已连续盯梢 " + Math.round((watch.waitedMs || 0) / 60000) + " 分钟仍未检测到结构变化 —— 兜底闸门收工, 未点击 (无观察窗, 不会提前放弃)")
                : "未完成击发"
        });
        return;
    }
    if (isTaskCancelled(tid)) { reportCancelled(tid, "首击后被手动终止"); return; }

    // 7. 连点链 + 提交风暴 (拟人连点直到跳转 → 右下角超高频直到提交)
    var chain = DamaiAdapter.grabChain(task, anchor, tid);
    if (chain.cancelled) { reportCancelled(tid, "连点链被手动终止"); return; }

    // 8. 结果读取与回传
    var result = DamaiAdapter.readResult(task);
    result.taskId = tid;
    result.platform = "damai";
    Transport.sendResult(result);
}

main();
