/**
 * adapters/monitor.js - 大麦回流票与余票只读监控适配器 (P0a 阶段核心)
 * =====================================================================
 * 特性：
 *   1. 交易零副作用：只读巡检页面文本（"缺货登记" / "已售罄" / "立即预订"）
 *   2. 频率纪律：平时 10~30s 低频退避；仅在窗口期适度加密，杜绝高频封号
 *   3. 状态跃迁上报：一旦发现由"售罄"变为"有票"，立即上报 Hub 触发提醒
 * =====================================================================
 */

var MonitorAdapter = {
    packageName: "cn.damai",
    lastStatus: "unknown",

    checkTicketStatus: function() {
        if (textMatches(".*(立即预订|选座购买|特惠购买).*").exists()) {
            return "in_stock"; // 有票
        }
        if (textMatches(".*(已售罄|缺货登记|已抢光).*").exists()) {
            return "sold_out"; // 售罄
        }
        return "unknown";
    },

    /**
     * 运行监控循环
     * @param {object} task 任务对象
     * @param {function} onStatusChange 状态变化回调
     */
    runLoop: function(task, onStatusChange) {
        console.log("【余票盯梢启动】开始监控大麦目标演出票务状态...");
        var intervalMs = 15000; // 默认 15 秒低频轮询

        while (true) {
            var currentStatus = this.checkTicketStatus();
            console.log("【余票探测】当前状态: " + currentStatus);

            if (currentStatus !== this.lastStatus) {
                console.log("【状态跃迁】状态由 [" + this.lastStatus + "] 变为 [" + currentStatus + "]");
                this.lastStatus = currentStatus;
                if (typeof onStatusChange === "function") {
                    onStatusChange(currentStatus);
                }
            }

            // 遵守频率纪律，休眠
            sleep(intervalMs);
        }
    }
};

module.exports = MonitorAdapter;
