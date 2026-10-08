/**
 * transport.js - 双模网络通信传输层 (USB adb reverse + 局域网 Wi-Fi 并行)
 * =====================================================================
 * 特性：
 *   1. 优先 USB adb reverse (127.0.0.1:3120, 最稳), 其次 hub.conf 写入的
 *      局域网地址 (由 PC 部署时自动写入最新 IP), 最后历史 LAN 地址兜底
 *   2. 维持 4 秒周期心跳与 ≤25 秒 HTTP 长轮询
 *   3. 心跳状态随任务联动 (idle / busy + taskId)
 * =====================================================================
 */

var Transport = {
    hubUrls: [
        "http://127.0.0.1:3120",     // USB (adb reverse) 首选: 最稳定
        "http://192.168.5.49:3120"   // 历史局域网 Wi-Fi IP 兜底
    ],
    activeHubUrl: null,
    deviceId: null,
    heartbeatTimer: null,
    isPolling: false,
    consecutiveHeartbeatFailures: 0,
    taskState: "idle",
    currentTaskId: null,

    init: function(customHubUrl) {
        // 读取 PC 部署时自动写入的 hub.conf (含最新局域网 IP, 多行多地址)
        try {
            var confPath = "/sdcard/qg-agent/hub.conf";
            if (files.exists(confPath)) {
                var savedUrls = String(files.read(confPath)).split(/[\n\r]+/).map(function(s) { return s.trim(); }).filter(Boolean);
                for (var i = savedUrls.length - 1; i >= 0; i--) {
                    if (savedUrls[i].indexOf("http") === 0 && this.hubUrls.indexOf(savedUrls[i]) < 0) {
                        this.hubUrls.unshift(savedUrls[i]);
                    }
                }
                if (savedUrls.length > 0) {
                    console.log("【通信配置】载入 hub.conf 地址: " + savedUrls.join(", "));
                }
            }
        } catch (eC) {}

        if (customHubUrl) {
            this.hubUrls.unshift(customHubUrl);
        }
        var aid = "";
        try {
            if (typeof device !== 'undefined' && device.getAndroidId) {
                var rawId = device.getAndroidId();
                if (rawId) aid = String(rawId);
            }
        } catch(eAid) {}
        this.deviceId = "phone-" + (aid ? aid.substring(0, 8) : ("vivo-" + Math.floor(Math.random() * 8999 + 1000)));
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
                var res = http.get(url + "/health", { timeout: 2500 });
                if (res && res.statusCode === 200) {
                    var prevUrl = this.activeHubUrl;
                    this.activeHubUrl = url;
                    console.log("【通信建立】成功连接至 Hub: " + url);
                    // 重新连上后立即发起 hello 重新登记
                    if (prevUrl !== url || !this.hasRegistered) {
                        this.hello();
                    }
                    return true;
                }
            } catch (e) {
                // 忽略重试下一个
            }
        }
        // 如果都未响应，优先保持第一个局域网 IP 尝试
        this.activeHubUrl = this.hubUrls[0];
        console.warn("【通信警告】未探测到在线 Hub，候补使用: " + this.activeHubUrl);
        return false;
    },

    /**
     * 设备注册握手
     */
    hello: function() {
        if (!this.activeHubUrl) this.detectHub();
        try {
            var isAcc = false;
            try { isAcc = (typeof auto !== 'undefined' && auto.service != null); } catch(eA) {}
            var bat = 100;
            try { if (typeof device !== 'undefined' && device.getBattery) bat = device.getBattery(); } catch(eB) {}
            var sw = 1080, sh = 2400;
            try { if (typeof device !== 'undefined') { sw = device.width || 1080; sh = device.height || 2400; } } catch(eS) {}
            var payload = {
                deviceId: this.deviceId,
                agentVersion: "1.0.0",
                autoX: "7.2.4",
                screen: [sw, sh],
                accessibility: isAcc,
                battery: bat,
                bootAt: java.lang.System.currentTimeMillis()
            };
            var res = http.postJson(this.activeHubUrl + "/api/device/hello", payload, { timeout: 4000 });
            if (res && res.statusCode === 200) {
                console.log("【握手成功】设备已在 Hub 登记: " + this.activeHubUrl);
                try { toast("⚡ 设备已成功连入电脑控制台！"); } catch(eT) {}
                this.hasRegistered = true;
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
        if (!this.activeHubUrl) {
            this.detectHub();
            return;
        }
        try {
            var bat = 100;
            var chg = false;
            try {
                if (typeof device !== 'undefined') {
                    if (device.getBattery) bat = device.getBattery();
                    if (device.isCharging) chg = device.isCharging();
                }
            } catch(eB) {}
            var isAcc = false;
            try { isAcc = (typeof auto !== 'undefined' && auto.service != null); } catch(eA) {}
            var payload = {
                deviceId: this.deviceId,
                state: state || "idle",
                taskId: currentTaskId || null,
                battery: bat,
                charging: chg,
                accessibility: isAcc,
                ts: java.lang.System.currentTimeMillis()
            };
            var res = http.postJson(this.activeHubUrl + "/api/device/heartbeat", payload, { timeout: 3000 });
            var ok = res && res.statusCode === 200;
            if (res && res.body) {
                try { res.body.close(); } catch (e) {}
            }
            if (ok) {
                this.consecutiveHeartbeatFailures = 0;
            } else {
                this.handleHeartbeatFail();
            }
        } catch (e) {
            this.handleHeartbeatFail();
        }
    },

    handleHeartbeatFail: function() {
        this.consecutiveHeartbeatFailures = (this.consecutiveHeartbeatFailures || 0) + 1;
        if (this.consecutiveHeartbeatFailures >= 2) {
            console.warn("【心跳异常】连续 " + this.consecutiveHeartbeatFailures + " 次心跳失败，重新寻找在线 Hub...");
            this.consecutiveHeartbeatFailures = 0;
            var self = this;
            threads.start(function() {
                self.detectHub();
            });
        }
    },

    /**
     * 启动长轮询接收任务 (带看门狗: 轮询线程卡死/死亡时自动重启)
     * 实测: hub 重启会令 OkHttp 长连接悬挂, 轮询线程可能永久卡住,
     * 心跳线程却正常 —— 必须独立看门狗检测恢复。
     */
    startLongPoll: function(onTaskReceived) {
        if (this.isPolling) return;
        this.isPolling = true;
        this._pollCallback = onTaskReceived;
        this.lastPollCompletedAt = java.lang.System.currentTimeMillis();

        threads.start(function() {
            console.log("【长轮询启动】开始监听来自 PC 控制台的任务派发...");
            while (Transport.isPolling) {
                try {
                    var pollUrl = Transport.activeHubUrl + "/api/device/poll-task?deviceId=" + Transport.deviceId;
                    var res = http.get(pollUrl, { timeout: 27000 });
                    Transport.lastPollCompletedAt = java.lang.System.currentTimeMillis();
                    if (res && res.statusCode === 200) {
                        var bodyStr = res.body.string();
                        var json = JSON.parse(bodyStr);
                        if (json.status === "task" && json.task) {
                            console.log("【收到任务】ID: " + json.task.taskId + ", 平台: " + json.task.platform);
                            if (typeof Transport._pollCallback === "function") {
                                Transport._pollCallback(json.task);
                            }
                        }
                    } else if (res && res.body) {
                        try { res.body.close(); } catch (e) {}
                    }
                } catch (err) {
                    Transport.lastPollCompletedAt = java.lang.System.currentTimeMillis();
                    console.error("【长轮询异常】" + (err ? (err.message || err) : "未知错误"));
                    sleep(3000);
                    Transport.detectHub();
                }
                sleep(200);
            }
        });

        // 看门狗: 轮询一轮最长 27s + 余量; 超过 45s 无完成记录则强制重启轮询线程
        var self = this;
        if (this._pollWatchdog) clearInterval(this._pollWatchdog);
        this._pollWatchdog = setInterval(function() {
            var silentMs = java.lang.System.currentTimeMillis() - (self.lastPollCompletedAt || 0);
            if (self.isPolling && silentMs > 45000) {
                console.warn("【轮询看门狗】轮询线程已卡死 " + silentMs + "ms, 强制重启");
                self.isPolling = false;
                sleep(800);
                self.startLongPoll(self._pollCallback);
            }
        }, 15000);
    },

    /**
     * 上报事件
     */
    sendEvent: function(taskId, eventName, detail) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.deviceId) this.deviceId = "phone-vivo";
        if (!this.activeHubUrl) return;
        try {
            var payload = {
                deviceId: this.deviceId,
                taskId: taskId,
                event: eventName,
                detail: detail || {},
                ts: java.lang.System.currentTimeMillis()
            };
            var res = http.postJson(this.activeHubUrl + "/api/device/event", payload, { timeout: 3000 });
            if (res && res.body) {
                try { res.body.close(); } catch (e) {}
            }
        } catch (e) {
            console.warn("上报事件失败: " + e.message);
        }
    },

    /**
     * 请求 PC 通过 ADB 注入一次点击 (Agent 无障碍手势失效时的可靠兜底,
     * 实测大麦 SKU 票档滚轮等自绘控件会无视 dispatchGesture 但响应 adb input)
     */
    adbTap: function(x, y) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return false;
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/tap", { x: Math.round(x), y: Math.round(y) }, { timeout: 2500 });
            return res && res.statusCode === 200;
        } catch (e) {
            return false;
        }
    },

    /**
     * 请求 PC 通过 ADB 注入一次滑动
     */
    adbSwipe: function(x1, y1, x2, y2, ms) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return false;
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/swipe", { x1: x1, y1: y1, x2: x2, y2: y2, ms: ms || 300 }, { timeout: 3000 });
            return res && res.statusCode === 200;
        } catch (e) {
            return false;
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
                reason: resultData.reason || null,
                message: resultData.message || null,
                orderNo: resultData.orderNo || null,
                evidence: resultData.evidence || "",
                data: resultData.data || null,
                ts: java.lang.System.currentTimeMillis()
            };
            var res = http.postJson(this.activeHubUrl + "/api/device/result", payload, { timeout: 5000 });
            var ok = res && res.statusCode === 200;
            if (res && res.body) {
                try { res.body.close(); } catch (e) {}
            }
            if (ok) {
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
