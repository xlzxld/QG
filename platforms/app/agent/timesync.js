/**
 * timesync.js - 官方网关高精时钟对齐与纳秒单调倒计时
 * =====================================================================
 * 特性：
 *   1. 直采阿里/大麦官方公开 MTOP 毫秒网关时间戳 (无需鉴权)
 *   2. min-RTT 滤波算法：连续探测 5 次，剔除网络抖动，计算精准 offset
 *   3. 终点击发：临界 200ms 内切入 java.lang.System.nanoTime() 硬件微自旋
 * =====================================================================
 */

var TimeSync = {
    damaiMtopUrl: "https://mtop.damai.cn/gw/mtop.common.getTimestamp/*",
    cachedOffset: 0,
    lastSyncRtt: 0,
    lastSyncAt: 0,

    /**
     * 采样大麦官方网关时间
     * @returns {{ offset: number, rtt: number, serverTime: number }}
     */
    syncDamai: function() {
        var minRtt = 999999;
        var bestOffset = 0;
        var bestServerTime = 0;

        for (var i = 0; i < 5; i++) {
            var t0 = java.lang.System.currentTimeMillis();
            try {
                var resp = http.get(this.damaiMtopUrl, { timeout: 3000 });
                var t1 = java.lang.System.currentTimeMillis();
                var rtt = t1 - t0;

                if (resp && resp.statusCode === 200) {
                    var raw = resp.body.string();
                    var json = JSON.parse(raw);
                    if (json && json.data && json.data.t) {
                        var serverMs = parseInt(json.data.t, 10);
                        var approxLocalAtResp = t0 + Math.floor(rtt / 2);
                        var offset = serverMs - approxLocalAtResp;

                        if (rtt < minRtt) {
                            minRtt = rtt;
                            bestOffset = offset;
                            bestServerTime = serverMs;
                        }
                    }
                }
            } catch (e) {
                // 单次网络超时重试
            }
            sleep(40);
        }

        if (minRtt < 999999) {
            this.cachedOffset = bestOffset;
            this.lastSyncRtt = minRtt;
            this.lastSyncAt = java.lang.System.currentTimeMillis();
            console.log("【对时成功】大麦 MTOP 最小 RTT: " + minRtt + "ms, 本地时钟偏置: " + bestOffset + "ms");
            return { offset: bestOffset, rtt: minRtt, serverTime: bestServerTime };
        } else {
            console.warn("【对时告警】所有采样失败，回退使用本地时钟 (offset=0)");
            return { offset: 0, rtt: -1, serverTime: java.lang.System.currentTimeMillis() };
        }
    },

    /**
     * 纳秒级单调钟精准等待并执行击发
     * @param {number} targetEpochMs 目标开火绝对时间戳 (平台时间)
     * @param {number} leadMs 提前量 (通常 30~50ms 抵消事件注入延迟)
     * @param {function} fireCallback 到点回调
     */
    waitToFire: function(targetEpochMs, leadMs, fireCallback) {
        var offset = this.cachedOffset;
        var triggerLocalEpoch = targetEpochMs - offset - leadMs;
        var now = java.lang.System.currentTimeMillis();
        var deltaMs = triggerLocalEpoch - now;

        console.log("【倒计时启动】距离击发还剩: " + deltaMs + "ms (已扣除 lead: " + leadMs + "ms, offset: " + offset + "ms)");

        // 远距离休眠，让出 CPU
        while (deltaMs > 250) {
            var sleepTime = Math.min(deltaMs - 200, 1000);
            sleep(sleepTime);
            now = java.lang.System.currentTimeMillis();
            deltaMs = triggerLocalEpoch - now;
        }

        // 临界 200ms 内转换为纳秒单调时钟，拒绝墙钟跳变
        var startNano = java.lang.System.nanoTime();
        var waitNano = (triggerLocalEpoch - java.lang.System.currentTimeMillis()) * 1000000;
        var endNano = startNano + waitNano;

        while (java.lang.System.nanoTime() < endNano) {
            // CPU 微自旋，绝对准点出膛
        }

        // 准点执行
        var firedAt = java.lang.System.currentTimeMillis();
        console.log("【准点击发】实际击发物理本地时间: " + firedAt);
        if (typeof fireCallback === "function") {
            fireCallback();
        }
    }
};

module.exports = TimeSync;
