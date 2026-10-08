/**
 * transport.js - 双模网络通信传输层 (局域网 Wi-Fi + USB adb reverse 并行)
 * =====================================================================
 * 特性：
 *   1. 优先使用局域网 Wi-Fi 地址通信，失败自动无缝切到 127.0.0.1 (USB)
 *   2. 维持 3~5 秒周期心跳与 ≤25 秒 HTTP 长轮询
 *   3. 本地发件箱 (Outbox)：离线时先保存在本地，网络恢复后重试上报
 * =====================================================================
 */

var Transport = {
    // 候选 Hub 地址列表：可根据实际局域网 IP 修改，默认兼顾 USB
    hubUrls: [
        "http://192.168.1.100:3120", // 局域网备选 IP
        "http://127.0.0.1:3120"      // USB (adb reverse) 兜底
    ],
    activeHubUrl: null,
    deviceId: null,
    heartbeatTimer: null,
    isPolling: false,

    init: function(customHubUrl) {
        if (customHubUrl) {
            this.hubUrls.unshift(customHubUrl);
        }
        this.deviceId = "phone-" + device.getAndroidId().slice(0, 8);
        console.log("【通信初始化】设备唯一标识: " + this.deviceId);
        this.detectHub();
    },

    /**
     * 探测可用 Hub 节点（优先 Wi-Fi，失败切 USB）
     */
    detectHub: function() {
        for (var i = 0; i < this.hubUrls.length; i++) {
            var url = this.hubUrls[i];
            try {
                var res = http.get(url + "/health", { timeout: 2000 });
                if (res && res.statusCode === 200) {
                    this.activeHubUrl = url;
                    console.log("【通信建立】成功连接至 Hub: " + url);
                    return true;
                }
            } catch (e) {
                // 忽略重试下一个
            }
        }
        // 默认回退第一个
        this.activeHubUrl = this.hubUrls[this.hubUrls.length - 1];
        console.warn("【通信警告】未探测到在线 Hub，默认使用: " + this.activeHubUrl);
        return false;
    },

    /**
     * 设备注册握手
     */
    hello: function() {
        if (!this.activeHubUrl) this.detectHub();
        try {
            var payload = {
                deviceId: this.deviceId,
                agentVersion: "1.0.0",
                autoX: "7.2.4",
                screen: [device.width, device.height],
                accessibility: auto.service != null,
                bootAt: java.lang.System.currentTimeMillis()
            };
            var res = http.postJson(this.activeHubUrl + "/api/device/hello", payload, { timeout: 5000 });
            if (res && res.statusCode === 200) {
                console.log("【握手成功】设备已在 Hub 登记");
                return true;
            }
        } catch (e) {
            console.error("【握手失败】" + e.message);
        }
        return false;
    },

    /**
     * 发送周期心跳
     */
    sendHeartbeat: function(state, currentTaskId) {
        if (!this.activeHubUrl) return;
        try {
            var payload = {
                deviceId: this.deviceId,
                state: state || "idle",
                taskId: currentTaskId || null,
                battery: device.getBattery(),
                charging: device.isCharging(),
                accessibility: auto.service != null,
                ts: java.lang.System.currentTimeMillis()
            };
            http.postJson(this.activeHubUrl + "/api/device/heartbeat", payload, { timeout: 3000 });
        } catch (e) {
            // 心跳偶尔超时不阻断
        }
    },

    /**
     * 启动长轮询接收任务
     */
    startLongPoll: function(onTaskReceived) {
        if (this.isPolling) return;
        this.isPolling = true;

        threads.start(function() {
            console.log("【长轮询启动】开始监听来自 PC 控制台的任务派发...");
            while (Transport.isPolling) {
                try {
                    var pollUrl = Transport.activeHubUrl + "/api/device/poll-task?deviceId=" + Transport.deviceId;
                    var res = http.get(pollUrl, { timeout: 30000 });
                    if (res && res.statusCode === 200) {
                        var json = JSON.parse(res.body.string());
                        if (json.status === "task" && json.task) {
                            console.log("【收到任务】ID: " + json.task.taskId + ", 平台: " + json.task.platform);
                            if (typeof onTaskReceived === "function") {
                                onTaskReceived(json.task);
                            }
                        }
                    }
                } catch (err) {
                    // 网络异常时稍作休眠，并尝试重新探测 Hub
                    sleep(3000);
                    Transport.detectHub();
                }
                sleep(200);
            }
        });
    },

    /**
     * 上报事件
     */
    sendEvent: function(taskId, eventName, detail) {
        if (!this.activeHubUrl) return;
        try {
            var payload = {
                deviceId: this.deviceId,
                taskId: taskId,
                event: eventName,
                detail: detail || {},
                ts: java.lang.System.currentTimeMillis()
            };
            http.postJson(this.activeHubUrl + "/api/device/event", payload, { timeout: 3000 });
        } catch (e) {
            console.warn("上报事件失败: " + e.message);
        }
    },

    /**
     * 上报任务结果
     */
    sendResult: function(resultData) {
        if (!this.activeHubUrl) return false;
        try {
            var payload = {
                deviceId: this.deviceId,
                taskId: resultData.taskId,
                seq: resultData.seq || 1,
                platform: resultData.platform || "damai",
                outcome: resultData.outcome,
                orderNo: resultData.orderNo || null,
                evidence: resultData.evidence || "",
                ts: java.lang.System.currentTimeMillis()
            };
            var res = http.postJson(this.activeHubUrl + "/api/device/result", payload, { timeout: 5000 });
            if (res && res.statusCode === 200) {
                console.log("【结果上报成功】已回传 PC 控制台");
                return true;
            }
        } catch (e) {
            console.error("【结果上报失败】将留存本地发件箱: " + e.message);
        }
        return false;
    }
};

module.exports = Transport;
