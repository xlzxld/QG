/**
 * main.js - APP端抢购 Agent 核心主入口 (AutoX.js 运行时)
 * =====================================================================
 * 职责：
 *   1. 调起 bootstrap 环境体检与无障碍就绪
 *   2. 建立双模长轮询通信 (Wi-Fi 局域网优先，USB 管道兜底)
 *   3. 周期上报心跳
 *   4. 接收任务单 -> MTOP 毫秒网关对时 -> T-5s 预热锚定 -> 纳秒级到点准点击发
 *   5. 结果回传 PC 控制台
 * =====================================================================
 */

var Bootstrap = require("./bootstrap.js");
var Transport = require("./transport.js");
var TimeSync = require("./timesync.js");
var DamaiAdapter = require("./adapters/damai.js");
var MonitorAdapter = require("./adapters/monitor.js");

function main() {
    console.show(); // 开启端侧浮窗日志输出
    console.log("🚀 QG-Agent 移动端自动化抢购引擎启动...");

    // 1. 环境初始化
    Bootstrap.checkEnvironment();

    // 2. 建立双模通信
    Transport.init();
    Transport.hello();

    // 3. 启动周期心跳 (每 4 秒一次)
    setInterval(function() {
        Transport.sendHeartbeat("idle", null);
    }, 4000);

    // 4. 启动长轮询接收 PC 任务派发
    Transport.startLongPoll(function(task) {
        handleTask(task);
    });

    console.log("🎉 Agent 就绪！进入待命状态，等待 PC 派发抢购或盯梢任务...");
}

/**
 * 核心任务执行引擎
 */
function handleTask(task) {
    console.log("==========================================");
    console.log("🎯 开始执行任务: " + task.taskId + " [" + task.platform + "]");
    console.log("==========================================");

    var platform = task.platform || "damai";
    var mode = task.mode || "rush";

    if (platform === "damai") {
        if (mode === "monitor") {
            // P0a 只读余票盯梢模式
            MonitorAdapter.runLoop(task, function(newStatus) {
                Transport.sendEvent(task.taskId, "ticket_status_change", { status: newStatus });
            });
        } else {
            // P0b / P1 准时击发抢票模式
            executeDamaiRush(task);
        }
    } else {
        console.warn("暂未实现的平台适配器: " + platform);
    }
}

/**
 * 大麦抢票执行流水线
 */
function executeDamaiRush(task) {
    // 1. 预航
    DamaiAdapter.prepare(task);

    // 2. 页面身份核验
    var preflightOk = DamaiAdapter.preflight(task);
    if (!preflightOk) {
        Transport.sendResult({
            taskId: task.taskId,
            platform: "damai",
            outcome: "failed",
            evidence: "页面身份核验失败，拒绝盲点"
        });
        return;
    }

    // 3. 预热与选票面板展开预选 (T - 3min ~ T - 5s)
    var primeOk = DamaiAdapter.prime(task);
    if (!primeOk) {
        Transport.sendResult({
            taskId: task.taskId,
            platform: "damai",
            outcome: "failed",
            evidence: "选票面板预热锚定失败"
        });
        return;
    }

    // 4. 对齐大麦官方网关服务器时间
    console.log("【官方网关对时】执行 MTOP 毫秒级时钟采样...");
    var syncResult = TimeSync.syncDamai();
    Transport.sendEvent(task.taskId, "timesync_done", syncResult);

    // 5. 倒计时并临界击发
    var fireTargetEpoch = (task.timing && task.timing.fireAtEpochMs) || (java.lang.System.currentTimeMillis() + 10000);
    var leadMs = (task.timing && task.timing.leadMs) || 40;

    TimeSync.waitToFire(fireTargetEpoch, leadMs, function() {
        DamaiAdapter.fire(task);
    });

    // 6. 读取结果凭证
    var result = DamaiAdapter.readResult(task);
    result.taskId = task.taskId;
    result.platform = "damai";

    // 7. 回传结果
    Transport.sendResult(result);
}

main();
