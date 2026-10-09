/**
 * =====================================================================
 * QG-Agent 移动端全功能免依赖抢购引擎 (AutoJs6 / AutoX 独立全功能单文件版)
 * 生成时间: 2026-10-09T04:05:57.309Z
 * 零 require 依赖，兼容任何目录直接运行 (彻底根除 jvm-npm 相对路径抛错)
 * =====================================================================
 */

"auto";


// ==================== [1. Bootstrap 模块] ====================

/**
 * bootstrap.js - 端侧环境体检与就绪准备
 * =====================================================================
 * 职责：
 *   1. 检查无障碍服务权限是否就绪（非阻塞模式，防止脚本卡死）
 *   2. 锁定屏幕常亮，防止系统休眠
 *   3. 检查基础环境与目录
 * =====================================================================
 */

var Bootstrap = {
    checkEnvironment: function() {
        console.log("==========================================");
        console.log("📱 AutoX / AutoJs6 抢购端侧环境初始化体检");
        console.log("==========================================");

        // 1. 无障碍服务检查（非阻塞探测，保证网络链路能够立即注册并上报）
        try {
            if (typeof auto !== 'undefined') {
                if (!auto.service) {
                    console.warn("【环境提示】无障碍服务尚未激活，尝试自动唤起...");
                    try { auto(); } catch(eA) {}
                }
                if (auto.service) {
                    console.log("✅ 无障碍服务状态: 正常运行");
                } else {
                    console.warn("⚠️ 无障碍服务尚未就绪（如需全自动点击，请在系统设置中允许 AutoJs6 无障碍）");
                }
            }
        } catch (e) {
            console.warn("无障碍服务检测异常: " + (e ? e.message : e));
        }

        // 2. 屏幕常亮保持与唤醒
        try {
            if (typeof device !== 'undefined') {
                if (device.wakeUp) device.wakeUp();
                if (device.keepScreenOn) device.keepScreenOn(3600 * 1000);
                console.log("✅ 屏幕常亮状态: 已锁定保持常亮");
            }
        } catch (e) {
            console.warn("⚠️ 屏幕常亮设置异常: " + (e ? e.message : e));
        }

        // 3. 屏幕与设备参数安全采集
        try {
            if (typeof device !== 'undefined') {
                var w = device.width || 1080;
                var h = device.height || 2400;
                var bat = device.getBattery ? device.getBattery() : 100;
                console.log("✅ 设备屏幕分辨率: " + w + "x" + h);
                console.log("✅ 设备电量: " + bat + "%");
            }
        } catch (e) {}

        return true;
    }
};


// ==================== [2. TimeSync 时钟对齐模块] ====================

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


// ==================== [3. AnchorFire 坐标锚定模块] ====================

/**
 * anchor-fire.js - 预热期坐标锚定与零查找击发器
 * =====================================================================
 * 核心机制：
 *   1. T - 5s 预热期：预先遍历无障碍树，计算按钮物理中心点 (cx, cy) 存入内存
 *   2. T - 10s 冻结守卫：禁止任何页面滑动
 *   3. T - 2s 复核守卫：确认身份元素仍存在
 *   4. T - 0ms 开火：0 毫秒查找，纯坐标物理触摸注入 (<5ms)
 *   5. 安全底线：严禁在未锚定或错页时进行盲点，一旦失败立即报警转人工！
 * =====================================================================
 */

var AnchorFire = {
    cachedPoint: null,
    anchoredNode: null,
    anchoredAt: 0,

    /**
     * T - 5s 预热锚定
     * @param {string|RegExp} matcherRegex 按钮文本正则（如 /确定|立即预订|立即购买/）
     * @returns {boolean} 是否锚定成功
     */
    anchor: function(matcherRegex) {
        this.cachedPoint = null;
        this.anchoredNode = null;

        var target = null;
        try {
            var patStr = (matcherRegex instanceof RegExp) ? matcherRegex.source : String(matcherRegex);
            if (!patStr.startsWith(".*") && !patStr.startsWith("^")) {
                patStr = ".*(" + patStr + ").*";
            }
            target = textMatches(patStr).findOne(2000);
            if (!target) {
                target = descMatches(patStr).findOne(800);
            }
        } catch (e) {
            console.error("【锚定异常】控件查询失败: " + e.message);
        }

        if (target && target.bounds) {
            var b = target.bounds();
            this.cachedPoint = {
                x: Math.floor(b.centerX()),
                y: Math.floor(b.centerY())
            };
            this.anchoredNode = target;
            this.anchoredAt = java.lang.System.currentTimeMillis();
            console.log("【坐标锚定成功】锁定物理坐标: (" + this.cachedPoint.x + ", " + this.cachedPoint.y + ")");
            return true;
        }

        // 绝不盲点，直接报警
        console.error("【锚定失败】未在当前页面找到匹配按钮！严禁盲点，立即呼叫人工接管！");
        device.vibrate(500);
        return false;
    },

    /**
     * T - 2s 复核守卫
     * @returns {boolean}
     */
    verifyGuard: function() {
        if (!this.cachedPoint) return false;
        // 校验距离锚定是否过去太久（超过 15 秒说明页面可能已变异）
        var elapsed = java.lang.System.currentTimeMillis() - this.anchoredAt;
        if (elapsed > 15000) {
            console.warn("【守卫警告】锚定缓存已过期 (" + elapsed + "ms)，需重新验证");
            return false;
        }
        return true;
    },

    /**
     * T0 临界击发：单次物理触摸注入 (热路径速度优先, 抖动保留防指纹)
     * 注意: 只注入一次触摸! (旧版 click()+press() 连发两次是双击 bug)
     * @returns {boolean}
     */
    fire: function() {
        if (this.cachedPoint && this.cachedPoint.x > 0 && this.cachedPoint.y > 0) {
            var jx = this.cachedPoint.x + Math.floor((Math.random() - 0.5) * 10);
            var jy = this.cachedPoint.y + Math.floor((Math.random() - 0.5) * 8);
            console.log("【击发出膛】注入物理坐标: (" + jx + ", " + jy + ")");
            try {
                if (typeof press === "function") {
                    return press(jx, jy, 30);
                }
            } catch (eP) {}
            try {
                if (typeof click === "function") {
                    return click(jx, jy);
                }
            } catch (eC) {
                console.error("【击发失败】触摸注入失败: " + eC.message);
            }
            return false;
        } else {
            console.error("【击发拒绝】未就绪的坐标点，拒绝盲点！");
            return false;
        }
    },

    /**
     * 重置状态
     */
    reset: function() {
        this.cachedPoint = null;
        this.anchoredNode = null;
        this.anchoredAt = 0;
    }
};


// ==================== [4. Transport 通信传输层] ====================

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
        "http://127.0.0.1:3120"      // USB (adb reverse) 首选: 最稳定
        // 局域网地址：由 hub.conf（PC 部署时写入）或自动扫描补充
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

        // 已知地址全都不通 → 自动扫描当前 Wi-Fi 网段找中枢（换网络/换电脑也能连上）
        var scanned = this.scanSubnetForHub();
        if (scanned) {
            var prevScanUrl = this.activeHubUrl;
            this.activeHubUrl = scanned;
            console.log("【通信建立】自动发现中枢: " + scanned);
            if (prevScanUrl !== scanned || !this.hasRegistered) {
                this.hello();
            }
            return true;
        }

        // 如果都未响应，优先保持第一个地址尝试
        this.activeHubUrl = this.hubUrls[0];
        console.warn("【通信警告】未探测到在线 Hub，候补使用: " + this.activeHubUrl);
        return false;
    },

    /**
     * 局域网自动发现：拿本机 Wi-Fi 的 IP 扫同网段（x.1~x.254）的 3120 端口找中枢。
     * 命中后把地址插入 hubUrls 队首，之后探测直接秒连。
     * 60 秒内最多扫一次，避免频繁扫描。
     */
    scanSubnetForHub: function() {
        var nowMs = java.lang.System.currentTimeMillis();
        if (this._lastScanAt && nowMs - this._lastScanAt < 60000) return null;
        this._lastScanAt = nowMs;

        // 1) 取本机 Wi-Fi 的 IPv4
        var myIp = null;
        try {
            var ifaces = java.net.NetworkInterface.getNetworkInterfaces();
            while (ifaces.hasMoreElements()) {
                var ni = ifaces.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                var addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    var ia = addrs.nextElement();
                    var ip = String(ia.getHostAddress() || "");
                    if (ip.indexOf(".") > 0 && ip.indexOf("127.") !== 0) { myIp = ip; break; }
                }
                if (myIp) break;
            }
        } catch (eIp) {}
        if (!myIp) {
            console.warn("【自动发现】拿不到本机 Wi-Fi 地址，跳过扫描（请确认手机连着 Wi-Fi）");
            return null;
        }

        var prefix = myIp.substring(0, myIp.lastIndexOf(".") + 1);
        console.log("【自动发现】扫描局域网 " + prefix + "x : 3120 寻找中枢...");
        var found = null;
        var makeWorker = function(startIdx, step) {
            return function() {
                for (var i = startIdx; i <= 254; i += step) {
                    if (found) return;
                    try {
                        var res = http.get("http://" + prefix + i + ":3120/health", { timeout: 400 });
                        if (res && res.statusCode === 200) {
                            if (!found) found = "http://" + prefix + i + ":3120";
                            return;
                        }
                    } catch (eW) {}
                }
            };
        };
        var workers = 24;
        for (var s = 0; s < workers; s++) {
            threads.start(makeWorker(s + 1, workers));
        }
        var t0 = java.lang.System.currentTimeMillis();
        while (!found && java.lang.System.currentTimeMillis() - t0 < 6000) {
            sleep(120);
        }
        if (found) {
            if (this.hubUrls.indexOf(found) < 0) this.hubUrls.unshift(found);
            return found;
        }
        console.warn("【自动发现】未找到中枢 —— 请确认：①手机与电脑在同一 Wi-Fi ②电脑上「手机中枢」已启动");
        return null;
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
                agentVersion: "1.0.1",
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


// ==================== [5. MonitorAdapter 监控模块] ====================

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


// ==================== [6. DamaiAdapter 适配器] ====================

/**
 * adapters/damai.js - 大麦 App 平台适配器 (2026-10-09 全面重构版)
 * =====================================================================
 * 重构要点 (融合 NNBS / WECENG ticket-purchase / RookieTree DaMaiHelper /
 * Pactum7 ticket-grabbing / gkd-kit 真机快照等成熟开源方案的实证结论):
 *
 *   1. 单次触控纪律: 每个逻辑动作只注入一次物理触摸 (旧版 click()+press()
 *      双击是重大 bug, 会导致复选框勾上又取消、按钮双击误触发)。
 *   2. 热启动唤起: 绝不杀进程、绝不 force-stop; 大麦已在前台直接用;
 *      后台则 reorder_to_front 拉回 (不过 SplashActivity, 无开屏广告);
 *      冷启动兜底等待 + 广告关闭 (homepage_advert_pb 等)。
 *   3. 页面状态机: detectPage() 基于 Activity 名 + 特征控件判断当前页面,
 *      任意卡死页面都能通过 ensureDamaiHome() 回到已知状态继续执行。
 *   4. 瞬时填表: setText(ACTION_SET_TEXT) 毫秒级替换文本, 不逐字输入;
 *      所有文本字段一次性连续填完, 只有省市区选择器需要额外点击。
 *   5. 关键控件 id (实证来源):
 *      - 详情页购买按钮文案: cn.damai:id/tv_left_main_text
 *      - 详情页购买容器:     trade_project_detail_purchase_status_bar_container_fl
 *      - 票档流式布局:       project_detail_perform_price_flowlayout (item_text)
 *      - 数量 + 号:          cn.damai:id/img_jia (容器 layout_num)
 *      - 抽屉确定按钮:       cn.damai:id/btn_buy (旧) / btn_buy_view (新)
 *      - 订单页特征:         文案「价格明细」/ DmOrderActivity
 *      - 观演人序号:         cn.damai:id/text_num (点击序号即选中)
 *      - 开屏广告:           cn.damai:id/homepage_advert_pb
 *      - 首页弹窗广告关闭:   homepage_popup_window_close_btn
 * =====================================================================
 */


function sendLog(taskId, msg) {
    try {
        console.log(msg);
        Transport.sendEvent(taskId || "damai", "log", { msg: String(msg), ts: java.lang.System.currentTimeMillis() });
    } catch (e) {}
}

function sendStep(taskId, step, status, detail) {
    try {
        Transport.sendEvent(taskId || "damai", "step", {
            step: step,
            status: status || "start",
            detail: detail || "",
            ts: java.lang.System.currentTimeMillis()
        });
    } catch (e) {}
}

/**
 * 高斯正态分布随机数 (Box-Muller)
 */
function gaussianRandom(mean, stdev) {
    var u1 = 1.0 - Math.random();
    var u2 = 1.0 - Math.random();
    var randStdNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.sin(2.0 * Math.PI * u2);
    return mean + stdev * randStdNormal;
}

/**
 * 拟人化单次物理点按 (只注入一次触摸!)
 * - 坐标 ±3px 高斯微抖动, 按压 35~55ms, 规避完全几何中心的机器指纹
 */
function humanPress(cx, cy) {
    if (!(cx > 0 && cy > 0)) return false;
    var jx = Math.round(gaussianRandom(cx, 3.0));
    var jy = Math.round(gaussianRandom(cy, 2.6));
    var dwellTime = Math.round(gaussianRandom(45, 6));
    if (dwellTime < 32) dwellTime = 32;
    if (dwellTime > 58) dwellTime = 58;
    try {
        if (typeof press === "function") return press(jx, jy, dwellTime);
    } catch (eP) {}
    try {
        if (typeof click === "function") return click(jx, jy);
    } catch (eC) {}
    return false;
}

/**
 * 速度优先点按 (抢购热路径专用: 抖动保留、按压时间压到最短)
 */
function fastPress(cx, cy) {
    if (!(cx > 0 && cy > 0)) return false;
    var jx = Math.round(gaussianRandom(cx, 3.0));
    var jy = Math.round(gaussianRandom(cy, 2.6));
    try {
        if (typeof press === "function") return press(jx, jy, 30);
    } catch (eP) {}
    try {
        if (typeof click === "function") return click(jx, jy);
    } catch (eC) {}
    return false;
}

/**
 * 拟人贝塞尔平滑拖拽 (仅滑块验证码/下拉刷新等场景使用)
 */
function humanSlide(startX, startY, endX, endY, durationMs) {
    var duration = durationMs || Math.round(gaussianRandom(300, 40));
    try {
        var steps = 14 + Math.floor(Math.random() * 5);
        var pts = [];
        var cp1Y = startY + gaussianRandom(0, 2.0);
        var cp2Y = startY + gaussianRandom(0, 2.0);
        for (var i = 0; i <= steps; i++) {
            var t = i / steps;
            var easedT = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            var oneMinusT = 1 - easedT;
            var bx = oneMinusT * oneMinusT * oneMinusT * startX +
                     3 * oneMinusT * oneMinusT * easedT * (startX + (endX - startX) * 0.3) +
                     3 * oneMinusT * easedT * easedT * (startX + (endX - startX) * 0.7) +
                     easedT * easedT * easedT * endX;
            var by = oneMinusT * oneMinusT * oneMinusT * cp1Y +
                     3 * oneMinusT * oneMinusT * easedT * cp1Y +
                     3 * oneMinusT * easedT * easedT * cp2Y +
                     easedT * easedT * easedT * endY;
            pts.push([Math.round(bx), Math.round(by)]);
        }
        if (typeof gesture === "function") {
            gesture.apply(null, [duration].concat(pts));
            return true;
        }
    } catch (e) {}
    try {
        swipe(startX, startY, endX, endY, duration);
        return true;
    } catch (e2) {}
    return false;
}

/**
 * 点击控件 (坐标优先, 单次触摸; 控件不可点时上溯可点击祖先)
 */
function humanClick(node) {
    if (!node) return false;
    try {
        if (node.bounds) {
            var b = node.bounds();
            var cx = Math.floor(b.centerX());
            var cy = Math.floor(b.centerY());
            if (cx > 0 && cy > 0 && b.width() > 0) return humanPress(cx, cy);
        }
    } catch (e2) {}
    try {
        if (node.clickable && node.clickable()) return node.click();
    } catch (e) {}
    return false;
}

/** 上溯寻找可点击祖先 (点击父容器才能触发的列表项) */
function clickAncestor(node, maxDepth) {
    var depth = maxDepth || 5;
    var cur = node;
    while (cur && depth > 0) {
        try {
            if (cur.clickable && cur.clickable()) {
                return humanClick(cur);
            }
        } catch (e) {}
        cur = cur.parent();
        depth--;
    }
    return humanClick(node);
}

/**
 * 瞬时填充输入框: 只用控件 ACTION_SET_TEXT (毫秒级替换), 逐字段校验回读,
 * 绝不用全局 setText (会写进错误/全部输入框 —— 实测坑)
 */
function fillField(nodeIdFinder, text) {
    for (var attempt = 0; attempt < 3; attempt++) {
        var node = nodeIdFinder();
        if (!node) return false;
        try {
            node.setText(text);
        } catch (eS) {}
        sleep(120 + attempt * 80);
        // 重新查找节点回读, 避免缓存节点读到旧值
        var chk = nodeIdFinder();
        if (chk && chk.text && chk.text() === text) return true;
    }
    return false;
}

/**
 * 判断 SKU 项是否已售罄/缺货 (包围盒内含缺货标签)
 */
function isItemSoldOut(node) {
    if (!node) return false;
    var ib = node.bounds ? node.bounds() : null;
    if (!ib) return false;
    try {
        var soldOutNodes = textMatches(/.*(缺货登记|无票|售罄|不可售|已抢光).*/).find();
        if (soldOutNodes && soldOutNodes.length > 0) {
            for (var i = 0; i < soldOutNodes.length; i++) {
                var tb = soldOutNodes[i].bounds();
                if (tb.centerX() >= ib.left && tb.centerX() <= ib.right &&
                    tb.centerY() >= ib.top && tb.centerY() <= ib.bottom) {
                    return true;
                }
            }
        }
    } catch (e) {}
    return false;
}

function safeTextMatches(pattern) {
    var patStr = (pattern instanceof RegExp) ? pattern.source : String(pattern);
    if (!patStr.startsWith(".*") && !patStr.startsWith("^")) {
        patStr = ".*(" + patStr + ").*";
    }
    return textMatches(patStr);
}

function safeDescMatches(pattern) {
    var patStr = (pattern instanceof RegExp) ? pattern.source : String(pattern);
    if (!patStr.startsWith(".*") && !patStr.startsWith("^")) {
        patStr = ".*(" + patStr + ").*";
    }
    return descMatches(patStr);
}

function now() {
    return java.lang.System.currentTimeMillis();
}

/**
 * 关键点击: AutoJs6 手势优先, 无效果时自动走 PC-ADB 注入兜底
 * @param {function} verify 点击后的效果校验 (返回 true 表示生效)
 * @param {string} label 日志标签
 */
function criticalTap(cx, cy, verify, label, tid) {
    // 通道 1: AutoJs6 无障碍手势
    humanPress(cx, cy);
    sleep(450);
    if (verify && verify()) return true;
    // 通道 2: 控件 ACTION_CLICK 由调用方自行尝试; 这里直接 ADB 注入兜底
    sendLog(tid || "damai", "[兜底] " + (label || "点击") + " 手势未生效, 切换 ADB 注入通道 (" + cx + "," + cy + ")");
    var ok = Transport.adbTap(cx, cy);
    if (ok) {
        sleep(450);
        if (!verify || verify()) {
            sendLog(tid || "damai", "[兜底] ✔ ADB 注入生效");
            return true;
        }
    }
    // 通道 3: 再试一次 ADB (偶发丢点)
    Transport.adbTap(cx, cy);
    sleep(500);
    return !verify || verify();
}

var DamaiAdapter = {
    packageName: "cn.damai",

    /* ================================================================
     * 0. 弹窗与广告自愈 (开屏广告 / 首页弹窗 / 须知 / 权限 / 努力刷新)
     * ================================================================ */
    dismissPopups: function() {
        var handled = false;
        try {
            // 1. 开屏广告 (GKD 真机快照实证 id)
            var adSkip = id("cn.damai:id/homepage_advert_pb").findOne(200);
            if (adSkip) {
                console.log("[弹窗自愈] 关闭开屏广告");
                humanClick(adSkip);
                sleep(300);
                handled = true;
            }
            // 2. 首页弹窗广告
            var popupClose = id("cn.damai:id/homepage_popup_window_close_btn").findOne(200);
            if (popupClose) {
                console.log("[弹窗自愈] 关闭首页弹窗广告");
                humanClick(popupClose);
                sleep(300);
                handled = true;
            }
            // 3. 业务提示/须知弹窗 (确定/我知道了/知道啦/好的)
            var btnNotice = id("cn.damai:id/damai_theme_dialog_confirm_btn").findOne(200) ||
                            safeTextMatches(/^(确定|我知道了|知道啦|好的|知道了)$/).findOne(200);
            if (btnNotice) {
                console.log("[弹窗自愈] 确认业务提示弹窗");
                humanClick(btnNotice);
                sleep(300);
                handled = true;
            }
            // 4. 系统权限弹窗
            var btnPerm = text("允许").findOne(150) || text("本次使用时允许").findOne(150) || text("始终允许").findOne(150);
            if (btnPerm) {
                console.log("[弹窗自愈] 允许系统权限请求");
                humanClick(btnPerm);
                sleep(250);
                handled = true;
            }
            // 5. 加载失败「努力刷新」
            var refresh = safeTextMatches(/努力刷新/).findOne(150);
            if (refresh) {
                console.log("[弹窗自愈] 点击努力刷新");
                humanClick(refresh);
                sleep(400);
                handled = true;
            }
        } catch (e) {}
        return handled;
    },

    /** 循环吞弹窗直到无弹窗或超轮数 */
    dismissPopupsLoop: function(rounds) {
        var n = rounds || 3;
        for (var i = 0; i < n; i++) {
            if (!this.dismissPopups()) break;
        }
    },

    /* ================================================================
     * 1. 页面状态机 (任意页面卡死均可识别并恢复)
     * ================================================================ */
    detectPage: function() {
        var act = "";
        try { act = currentActivity() || ""; } catch (e) {}
        var page = "unknown";
        if (act.indexOf("SplashMainActivity") >= 0) page = "splash";
        else if (act.indexOf("homepage.MainActivity") >= 0) page = "home";
        else if (act.indexOf("ProjectDetail") >= 0) page = "detail";
        else if (act.indexOf("NcovSku") >= 0 || act.indexOf("SkuList") >= 0 || act.indexOf(".Sku") >= 0) page = "sku";
        else if (act.indexOf("DmOrder") >= 0 || act.indexOf("OrderConfirm") >= 0 || act.indexOf("NewTradeOrder") >= 0) page = "order";
        else if (act.indexOf("MineMainActivity") >= 0) page = "mine";
        else if (act.indexOf("UserExtras") >= 0) page = "userextras";
        else if (act.indexOf("Search") >= 0) page = "search";

        // Activity 名识别不了时用特征控件兜底
        if (page === "unknown") {
            try {
                if (safeTextMatches(/价格明细/).exists() || safeTextMatches(/立即提交|提交订单/).exists()) page = "order";
                else if (safeTextMatches(/选择票档|选择场次|场次时间均为演出当地时间/).exists() ||
                         id("cn.damai:id/project_detail_perform_price_flowlayout").exists() ||
                         id("cn.damai:id/btn_buy_view").exists() || id("cn.damai:id/btn_buy").exists()) page = "sku";
                else if (id("cn.damai:id/trade_project_detail_purchase_status_bar_container_fl").exists() ||
                         id("cn.damai:id/tv_left_main_text").exists()) page = "detail";
                else if (safeTextMatches(/常用信息/).exists() || id("cn.damai:id/id_user_extra_tabs").exists()) page = "userextras";
                else if (safeTextMatches(/新增实名观演人/).exists()) page = "addviewer";
                else if (safeTextMatches(/新增收货地址|新建收货地址/).exists()) page = "addaddress";
                else if (id("cn.damai:id/homepage_header_search_btn").exists() || id("cn.damai:id/channel_search_text").exists()) page = "home";
            } catch (e) {}
        } else {
            // 已知 Activity 再细化: userextras 页内的新增子页
            try {
                if (safeTextMatches(/新增实名观演人/).exists()) page = "addviewer";
                else if (safeTextMatches(/新增收货地址|新建收货地址/).exists()) page = "addaddress";
            } catch (e) {}
        }
        return { page: page, activity: act };
    },

    /** 大麦是否在前台 */
    isDamaiForeground: function() {
        try { return currentPackage() === this.packageName; } catch (e) { return false; }
    },

    /**
     * 唤起大麦 (热启动优先, 绝不重启进程):
     * 1. 已在前台 → 直接用
     * 2. 后台存活 → reorder_to_front 拉回 (无开屏广告)
     * 3. 进程已死 → 冷启动, 等首页就绪并关广告
     */
    ensureForeground: function(tid) {
        sendLog(tid, "[唤起] 开始确保大麦前台 (热启动策略, 不重启进程)");
        try {
            if (!device.isScreenOn()) {
                device.wakeUp();
                sleep(500);
            }
        } catch (eW) {}
        this.dismissPopups();

        if (this.isDamaiForeground()) {
            var st = this.detectPage();
            sendLog(tid, "[唤起] 大麦已在前台, 当前页面: " + st.page + " (" + st.activity + ")");
            return true;
        }

        sendLog(tid, "[唤起] 大麦不在前台, 平滑拉回 (reorder_to_front, 不触发开屏广告)");
        try {
            app.startActivity({
                packageName: this.packageName,
                className: "cn.damai.homepage.MainActivity",
                flags: ["activity_reorder_to_front", "activity_new_task"]
            });
        } catch (e) {
            try { app.launch(this.packageName); } catch (e2) {}
        }

        // 等待回到前台 (最多 8s)
        for (var i = 0; i < 16; i++) {
            sleep(500);
            if (this.isDamaiForeground()) {
                sleep(400);
                this.dismissPopupsLoop(2);
                var st2 = this.detectPage();
                sendLog(tid, "[唤起] 大麦已回前台, 页面: " + st2.page);
                return true;
            }
        }
        sendLog(tid, "[唤起] 警告: 大麦未能回到前台 (可能被系统限制), 再试 launchApp");
        try { app.launch(this.packageName); } catch (e3) {}
        for (var j = 0; j < 10; j++) {
            sleep(500);
            if (this.isDamaiForeground()) {
                sleep(600);
                this.dismissPopupsLoop(3); // 冷启动后可能有开屏广告+弹窗
                return true;
            }
        }
        return false;
    },

    /**
     * 回退到大麦已知安全页面 (详情/首页), 最多按 back N 次
     * 解决「手机停留在任意页面导致脚本无反应」的问题
     */
    backToKnownPage: function(tid, maxBacks) {
        var n = maxBacks || 4;
        for (var i = 0; i < n; i++) {
            if (!this.isDamaiForeground()) {
                this.ensureForeground(tid);
                return "home";
            }
            this.dismissPopups();
            var st = this.detectPage();
            if (st.page === "detail" || st.page === "home" || st.page === "sku" || st.page === "order") {
                return st.page;
            }
            // 弹窗挡住时优先关弹窗
            try { back(); } catch (eB) {}
            sleep(600);
        }
        var stF = this.detectPage();
        return stF.page;
    },

    /* ================================================================
     * 2. 就位演出详情页 (搜索直达: 大麦 DeepLink 实测只能拉起首页, 不可靠)
     * ================================================================ */
    gotoDetail: function(task, tid) {
        var targetName = (task.target && task.target.name) || "";

        var st = this.detectPage();
        if (st.page === "sku") {
            sendLog(tid, "[就位] 已在选票页, 无需重新进入详情");
            return true;
        }
        if (st.page === "order") {
            // 复用旧订单页前校验张数一致 (旧订单会沿用错误的张数与观演人)
            var wantCount = (task.target && task.target.count) || 1;
            var cntNode = safeTextMatches(/×\s*\d+\s*张/).findOne(800);
            var cntMatch = cntNode ? (((cntNode.text ? cntNode.text() : "").match(/×\s*(\d+)\s*张/)) || [])[1] : null;
            if (cntMatch && parseInt(cntMatch, 10) === wantCount) {
                sendLog(tid, "[就位] 已在订单确认页且张数一致 (" + wantCount + " 张), 直接复用");
                return true;
            }
            sendLog(tid, "[就位] 订单页张数不符 (现 " + (cntMatch || "?") + " 需 " + wantCount + "), 返回重选");
            try { back(); } catch (eB) {}
            sleep(900);
            this.dismissPopups();
            st = this.detectPage();
            if (st.page === "order") {
                try { back(); } catch (eB2) {}
                sleep(900);
            }
            st = this.detectPage();
            if (st.page === "detail" || st.page === "sku") return true;
        }
        if (st.page === "detail") {
            sendLog(tid, "[就位] 已在详情页, 直接复用");
            return true;
        }

        // 从未知/子页面先回退到已知页面
        this.backToKnownPage(tid, 3);
        st = this.detectPage();
        if (st.page === "detail" || st.page === "sku" || st.page === "order") return true;

        if (targetName) {
            return this.searchAndEnter(targetName, tid);
        }
        return false;
    },

    /** 从演出全名提取搜索关键字与城市 */
    extractSearchHints: function(name) {
        var kw = String(name || "");
        var city = "";
        var mCity = kw.match(/^([^·\(（]+)[·\(（]/);
        if (mCity) city = mCity[1].trim();
        var mCity2 = kw.match(/[-—]([^-—站]*?)站/);
        if (!city && mCity2) city = mCity2[1].trim();
        // 关键字去掉城市前后缀, 更利于搜索建议命中
        kw = kw.replace(/^[^·\(（]*[·\(（]/, "").replace(/[-—][^-—]*站$/, "").trim() || name;
        return { keyword: kw, city: city };
    },

    /** 通过搜索进入演出详情 (实测控件链路: 首页搜索钮 → 输入 → 建议 → 结果/城市卡 → 详情) */
    searchAndEnter: function(name, tid) {
        var hints = this.extractSearchHints(name);
        sendLog(tid, "[搜索] 关键字: " + hints.keyword + " 城市: " + (hints.city || "(未知)"));

        // 1. 确保在大麦首页
        var st0 = this.detectPage();
        if (st0.page === "search") {
            // 已在搜索页, 直接复用输入框
        } else {
            if (st0.page !== "home") {
                this.backToKnownPage(tid, 3);
                if (this.detectPage().page !== "home") {
                    try {
                        app.startActivity({
                            packageName: this.packageName,
                            className: "cn.damai.homepage.MainActivity",
                            flags: ["activity_reorder_to_front", "activity_new_task", "activity_single_top"]
                        });
                        sleep(1200);
                    } catch (eH) {}
                    this.dismissPopupsLoop(2);
                }
            }
            // 确保在「首页」Tab (大麦 Tab 状态跨启动保留, 可能停在「我的」)
            var homeTab = text("首页").findOne(600) || id("cn.damai:id/tab_text").text("首页").findOne(500);
            if (homeTab && homeTab.bounds) {
                var htb = homeTab.bounds();
                if (htb.top > device.height * 0.8) { // 底部 Tab 栏才点
                    humanClick(homeTab);
                    sleep(700);
                    this.dismissPopups();
                }
            }
            // 2. 点击首页搜索入口 (多代 id 兜底, 2026-10 实测: pioneer_homepage_header_search_btn)
            var searchEntry = id("cn.damai:id/pioneer_homepage_header_search_btn").findOne(1200) ||
                              id("cn.damai:id/homepage_header_search_layout").findOne(1000) ||
                              id("cn.damai:id/search_text").findOne(800) ||
                              id("cn.damai:id/channel_search_text").findOne(800) ||
                              id("cn.damai:id/homepage_header_search_btn").findOne(800) ||
                              text("搜索").findOne(800);
            if (!searchEntry) {
                sendLog(tid, "[搜索] 未找到首页搜索入口");
                return false;
            }
            humanClick(searchEntry);
            sleep(1000);
        }

        // 3. 输入关键字 (必须走 IME input() 路径: setText 不触发联想建议)
        var inputEt = id("cn.damai:id/header_search_v2_input").findOne(2500) ||
                      className("android.widget.EditText").findOne(1500);
        if (!inputEt) {
            sendLog(tid, "[搜索] 未找到搜索输入框");
            return false;
        }
        // 清空已有内容
        try {
            var delBtn = id("cn.damai:id/header_search_v2_input_delete").findOne(500);
            if (delBtn) humanClick(delBtn);
        } catch (eD) {}
        try { inputEt.setText(""); } catch (eC) {}
        humanClick(inputEt); // 聚焦唤起输入法
        sleep(400);
        try { input(hints.keyword); } catch (eI) {
            try { inputEt.setText(hints.keyword); } catch (eS) {}
        }
        sleep(1400);

        // 4. 点击匹配的搜索建议 (tv_word), 否则第一条
        var clicked = false;
        var suggNodes = id("cn.damai:id/tv_word").find();
        if (suggNodes && suggNodes.length > 0) {
            var target = null;
            var core = hints.keyword.replace(/[0-9\s年月日]/g, "");
            for (var si = 0; si < suggNodes.length; si++) {
                var st = suggNodes[si].text ? suggNodes[si].text() : "";
                if (core && core.length > 1 && st.indexOf(core.slice(0, 4)) >= 0) { target = suggNodes[si]; break; }
            }
            if (!target) target = suggNodes[0];
            sendLog(tid, "[搜索] 点击建议: " + (target.text ? target.text() : "(第一条)"));
            humanClick(target);
            clicked = true;
        }
        if (!clicked) {
            // 无建议: 直接回车搜索
            try { inputEt.imeEnter(); } catch (eE) { try { inputEt.setText(hints.keyword + "\n"); } catch (eE2) {} }
        }
        sleep(2000);
        this.dismissPopups();

        // 5. 结果页: 城市卡 (巡演) 或 普通结果项 → 进入详情
        for (var w = 0; w < 8; w++) {
            if (this.detectPage().page === "detail") {
                sendLog(tid, "[搜索] ✔ 已进入演出详情页");
                return true;
            }
            // 5a. 巡演城市卡: tv_city 匹配目标城市 (或场次日期)
            var cityNodes = id("cn.damai:id/tv_city").find();
            if (cityNodes && cityNodes.length > 0) {
                var hit = null;
                if (hints.city) {
                    for (var ci = 0; ci < cityNodes.length; ci++) {
                        var cn2 = cityNodes[ci].text ? cityNodes[ci].text() : "";
                        if (cn2.indexOf(hints.city) >= 0 || hints.city.indexOf(cn2) >= 0) { hit = cityNodes[ci]; break; }
                    }
                }
                if (!hit) hit = cityNodes[0]; // 兜底第一城
                sendLog(tid, "[搜索] 点击巡演城市卡: " + (hit.text ? hit.text() : "(第一城)"));
                clickAncestor(hit, 3);
                sleep(2200);
                this.dismissPopups();
                if (this.detectPage().page === "detail") {
                    sendLog(tid, "[搜索] ✔ 已进入目标城市演出详情页");
                    return true;
                }
                continue;
            }
            // 5b. 普通结果项
            var item = id("cn.damai:id/ll_search_item").findOne(600) ||
                       id("cn.damai:id/ll_project_right").findOne(600) ||
                       id("cn.damai:id/tv_project_tourName").findOne(600);
            if (item) {
                sendLog(tid, "[搜索] 点击搜索结果项");
                clickAncestor(item, 3);
                sleep(1800);
                this.dismissPopups();
            } else {
                sleep(600);
            }
        }
        sendLog(tid, "[搜索] ✘ 未能进入演出详情页");
        return false;
    },

    /* ================================================================
     * 3. 选票抽屉
     * ================================================================ */
    isInSkuDrawer: function() {
        try {
            var act = currentActivity() || "";
            if (act.indexOf("NcovSku") >= 0 || act.indexOf("SkuList") >= 0 || /\.Sku\w*Activity$/.test(act)) return true;
        } catch (e) {}
        return id("cn.damai:id/btn_buy_view").exists() ||
               id("cn.damai:id/btn_buy").exists() ||
               id("cn.damai:id/project_detail_perform_price_flowlayout").exists() ||
               id("cn.damai:id/img_jia").exists() ||
               safeTextMatches(/选择票档|选择场次|场次时间均为演出当地时间/).exists();
    },

    isInOrderConfirmPage: function() {
        try {
            var act = currentActivity() || "";
            if (act.indexOf("DmOrder") >= 0 || act.indexOf("OrderConfirm") >= 0) return true;
        } catch (e) {}
        return safeTextMatches(/价格明细/).exists() ||
               safeTextMatches(/立即提交|提交订单/).exists();
    },

    /** 点击详情页底栏购买按钮展开抽屉 */
    openSkuDrawer: function(task) {
        var tid = task ? task.taskId : "task";
        sendStep(tid, "open_sku", "start");
        this.dismissPopups();

        if (this.isInSkuDrawer() || this.isInOrderConfirmPage()) {
            sendLog(tid, "[开抽屉] 已在选票抽屉/订单页, 无需重复展开");
            sendStep(tid, "open_sku", "done", "已在选票/订单页");
            return true;
        }

        // 等待详情页加载完成 (骨架屏消失, 最多 8s)
        for (var lw = 0; lw < 8; lw++) {
            if (!id("cn.damai:id/id_new_skeleton").exists()) break;
            sleep(800);
            this.dismissPopups();
        }

        // 验证抽屉就位 (点击 → 排队/验证码处理 → 重试, 最多 12 轮)
        for (var w = 0; w < 12; w++) {
            this.dismissPopups();

            // 排队/加载失败态: 点击「努力刷新」
            var retryBtn = id("cn.damai:id/state_view_retry_btn").findOne(300) ||
                           safeTextMatches(/努力刷新/).findOne(300);
            if (retryBtn) {
                sendLog(tid, "[开抽屉] 页面排队/加载中, 点击努力刷新 (第 " + (w + 1) + " 轮)");
                humanClick(retryBtn);
                sleep(1500);
            }

            // 验证码处理
            if (this.checkCaptcha()) {
                sleep(1500);
            }

            if (this.isInSkuDrawer() || this.isInOrderConfirmPage()) {
                sendLog(tid, "[开抽屉] 选票页已就位 (第 " + (w + 1) + " 轮检测)");
                sendStep(tid, "open_sku", "done");
                return true;
            }

            // 每轮点击底栏购买入口 (手势 + ADB 双通道)
            var btnBuy = id("cn.damai:id/tv_left_main_text").findOne(600);
            var cx, cy;
            if (btnBuy && btnBuy.bounds) {
                var bb = btnBuy.bounds();
                cx = Math.floor(bb.centerX());
                cy = Math.floor(bb.centerY());
            } else {
                var container = id("cn.damai:id/trade_project_detail_purchase_status_bar_container_fl").findOne(800);
                if (container && container.bounds) {
                    var cb = container.bounds();
                    cx = Math.floor(cb.centerX());
                    cy = Math.floor(cb.centerY());
                } else {
                    cx = Math.floor(device.width * 0.63);
                    cy = Math.floor(device.height * 0.962);
                }
            }
            sendLog(tid, "[开抽屉] 点击底栏购买入口: (" + cx + ", " + cy + ")");
            criticalTap(cx, cy, function() {
                for (var v = 0; v < 2; v++) {
                    if (DamaiAdapter.isInSkuDrawer() || DamaiAdapter.isInOrderConfirmPage()) return true;
                    sleep(300);
                }
                return false;
            }, "购买入口", tid);
            sleep(1000);
        }
        sendStep(tid, "open_sku", "failed", "抽屉未在超时内就位");
        sendLog(tid, "[开抽屉] 超时失败! 当前: " + this.detectPage().activity);
        return false;
    },

    /* ================================================================
     * 4. SKU 装配 (场次 + 票档 + 数量) — 每步带渲染验证与重试
     * 实测坑: 大麦场次/票档 item 的 text 为空串, 只能按容器项点击;
     * 页面渲染有延迟, 点击后必须确认下一区域出现才算选中。
     * ================================================================ */
    selectSku: function(task) {
        var tid = task ? task.taskId : "task";
        sendStep(tid, "select_sku", "start");
        var targetSession = task.target && task.target.session;
        var targetPrice = task.target && task.target.priceText;
        var ticketCount = (task.target && task.target.count) || 1;

        // ---- 4.1 场次: 点击场次项, 直到票档区出现 (最多 4 次尝试) ----
        var priceSectionVisible = function() {
            for (var v = 0; v < 3; v++) {
                if (id("cn.damai:id/project_detail_perform_price_flowlayout").exists() ||
                    id("cn.damai:id/tv_price_name").exists()) return true;
                sleep(300);
            }
            return false;
        };
        var sessionOk = false;
        for (var att = 0; att < 4 && !sessionOk; att++) {
            if (priceSectionVisible()) { sessionOk = true; break; }
            var performItems = id("cn.damai:id/ll_perform_item").find();
            if (!performItems || performItems.length === 0) {
                sendLog(tid, "[场次] 未找到场次项 (第 " + (att + 1) + " 次), 等待渲染");
                sleep(900);
                continue;
            }
            var pick = null;
            for (var pi = 0; pi < performItems.length; pi++) {
                if (!isItemSoldOut(performItems[pi])) { pick = performItems[pi]; break; }
            }
            if (!pick) pick = performItems[0];
            var pb = pick.bounds();
            sendLog(tid, "[场次] 点击场次项 #" + (att + 1) + " (" + Math.floor(pb.centerX()) + "," + Math.floor(pb.centerY()) + ")");
            sessionOk = criticalTap(Math.floor(pb.centerX()), Math.floor(pb.centerY()), priceSectionVisible, "场次选择", tid);
        }
        sendLog(tid, "[场次] " + (sessionOk ? "✔ 已选择 (票档区已出现)" : "✘ 未能确认选中"));
        sendStep(tid, "select_sku", "progress", sessionOk ? "场次已选择" : "场次选择未确认");

        // ---- 4.2 票档: 在票档流式布局中选目标或首个在售项 ---- */
        var tierOk = false;
        for (var tatt = 0; tatt < 3 && !tierOk; tatt++) {
            var priceItems = id("cn.damai:id/ll_perform_item").find();
            // 票档项 = 票档区内的 ll_perform_item (通过 y 坐标 > 票档标题 过滤)
            var priceTitle = id("cn.damai:id/tv_price_name").findOne(400);
            var priceY = priceTitle && priceTitle.bounds ? priceTitle.bounds().top : 1100;
            var tierNodes = [];
            for (var ti = 0; ti < priceItems.length; ti++) {
                try {
                    var tb2 = priceItems[ti].bounds();
                    if (tb2.top >= priceY - 60) tierNodes.push(priceItems[ti]);
                } catch (eB) {}
            }

            if (!tierNodes.length) {
                sendLog(tid, "[票档] 未找到票档项 (第 " + (tatt + 1) + " 次)");
                sleep(800);
                continue;
            }

            var targetNode = null;
            if (targetPrice) {
                var priceNum = targetPrice.replace(/[^0-9]/g, "");
                for (var tn2 = 0; tn2 < tierNodes.length; tn2++) {
                    if (isItemSoldOut(tierNodes[tn2])) continue;
                    // 票档 item 无文本 → 用 bounds 无法辨价格, 只能按顺序;
                    // 有文本时优先文本匹配
                    var texts = [];
                    try {
                        var desc = tierNodes[tn2].find(textMatches(/.+/));
                        for (var di = 0; di < desc.length; di++) texts.push(desc[di].text());
                    } catch (eT) {}
                    var joined = texts.join(" ");
                    if (priceNum && joined.indexOf(priceNum) >= 0) { targetNode = tierNodes[tn2]; sendLog(tid, "[票档] 文本命中: " + joined); break; }
                }
            }
            if (!targetNode) {
                // 首个非售罄票档 (自适应)
                for (var tn3 = 0; tn3 < tierNodes.length; tn3++) {
                    if (!isItemSoldOut(tierNodes[tn3])) { targetNode = tierNodes[tn3]; sendLog(tid, "[票档] 自适应选择在售票档 #" + tn3); break; }
                }
            }
            if (!targetNode) {
                sendLog(tid, "[票档] 全部票档售罄");
                break;
            }
            var tb3 = targetNode.bounds();
            var priceSelected = function() {
                for (var v = 0; v < 3; v++) {
                    var priceTv = id("cn.damai:id/tv_price").findOne(300);
                    var priceTxt = priceTv && priceTv.text ? priceTv.text() : "0";
                    if (priceTxt && priceTxt !== "0") return true;
                    sleep(300);
                }
                return false;
            };
            criticalTap(Math.floor(tb3.centerX()), Math.floor(tb3.centerY()), priceSelected, "票档选择", tid);
            tierOk = priceSelected();
        }
        sendStep(tid, "select_sku", "progress", tierOk ? "票档已选择" : "票档未确认");

        // ---- 4.3 数量 (+ 号追加) ----
        if (ticketCount > 1) {
            sendLog(tid, "[数量] 追加至 " + ticketCount + " 张");
            for (var k = 1; k < ticketCount; k++) {
                var plusBtn = id("cn.damai:id/img_jia").findOne(500) ||
                              descContains("增加").findOne(300) ||
                              text("+").findOne(300);
                if (plusBtn) {
                    humanClick(plusBtn);
                    sleep(100);
                } else {
                    sendLog(tid, "[数量] 未找到 + 号按钮, 停止追加");
                    break;
                }
            }
        }

        sendStep(tid, "select_sku", "done");
        return true;
    },

    /** 点击抽屉「确定」进入确认订单页 (手势 + ADB 双通道 + 到位验证) */
    confirmSkuDrawer: function(tid, urgent) {
        var btn = id("cn.damai:id/btn_buy").findOne(urgent ? 300 : 800) ||
                  id("cn.damai:id/btn_buy_view").findOne(urgent ? 300 : 800) ||
                  text("确定").findOne(urgent ? 300 : 800) ||
                  desc("确定").findOne(300);
        if (!btn) return false;
        var b = btn.bounds();
        var cx = Math.floor(b.centerX());
        var cy = Math.floor(b.centerY());
        if (urgent) {
            AnchorFire.cachedPoint = { x: cx, y: cy };
            AnchorFire.anchoredAt = now();
            return fastPress(cx, cy);
        }
        var reachedOrder = function() {
            for (var v = 0; v < 3; v++) {
                if (DamaiAdapter.isInOrderConfirmPage()) return true;
                sleep(350);
            }
            return false;
        };
        return criticalTap(cx, cy, reachedOrder, "抽屉确定按钮", tid);
    },

    /* ================================================================
     * 5. 确认订单页: 观演人配对 + 提交
     * ================================================================ */
    handleOrderConfirm: function(task) {
        var tid = task.taskId;
        sendStep(tid, "order_confirm", "start");
        console.log("[订单确认] 等待进入确认订单页...");

        var reached = false;
        for (var t = 0; t < 15; t++) {
            if (this.isInOrderConfirmPage()) { reached = true; break; }
            this.checkCaptcha();
            sleep(400);
        }
        if (!reached) {
            sendStep(tid, "order_confirm", "failed", "超时未进入确认订单页");
            return { outcome: "failed", evidence: "超时未进入确认购买页 (可能票档无票或需验证)" };
        }
        sendLog(tid, "[订单确认] 已进入确认订单页");
        sendStep(tid, "order_confirm", "progress", "已进入确认订单页");

        // 周边商品 (含收货地址/去支付) 分支
        if (safeTextMatches(/收货人|收货地址/).exists() && !safeTextMatches(/价格明细/).exists()) {
            if (task.mode === "test" || task.mode === "dryrun") {
                return { outcome: "success", evidence: "周边商品订单页就位 (演练模式安全停止)" };
            }
            var payBtn = safeTextMatches(/去支付.*/).findOne(1200);
            if (payBtn) {
                humanClick(payBtn);
                return this.readResult(task);
            }
        }

        // 需要的观演人数 (提示「仅需选择N位」优先)
        var neededCount = 1;
        var tipNode = safeTextMatches(/仅需选择.*位|请选择.*位观演人/).findOne(800);
        if (tipNode) {
            var m = (tipNode.text ? tipNode.text() : "").match(/(?:仅需选择|请选择)\s*(\d+)\s*位/);
            if (m) neededCount = parseInt(m[1], 10);
        } else if (task.target && task.target.count) {
            neededCount = task.target.count;
        }
        sendLog(tid, "[观演人] 需勾选实名观演人: " + neededCount + " 位");

        var targetViewers = [];
        if (task.target && Array.isArray(task.target.viewers) && task.target.viewers.length > 0) {
            targetViewers = task.target.viewers.filter(function(v) { return Boolean(v && String(v).trim()); });
        } else if (task.target && task.target.viewer) {
            targetViewers = [task.target.viewer];
        }

        var selectedNames = this.assembleViewers(targetViewers, neededCount, tid);

        sendLog(tid, "[观演人] 装配完成: " + (selectedNames.join(" + ") || "(无)") + " (需 " + neededCount + " 位)");
        sendStep(tid, "order_confirm", "progress", "观演人装配: " + (selectedNames.join("+") || "无"));

        // 演练模式安全熔断 (绝不提交)
        if (task.mode === "test" || task.mode === "dryrun") {
            var vDisplay = selectedNames.length > 0 ? selectedNames.join("+") : "自适应常用人";
            sendStep(tid, "order_confirm", "done", "演练安全停止在提单前");
            return {
                outcome: "success",
                evidence: "全流程演练成功: 已就位确认订单页, 观演人(" + vDisplay + ")装配 " + selectedNames.length + "/" + neededCount + ", 提单按钮就绪, 安全停在提交前 (不扣款)"
            };
        }

        // 真实提交 (实证节奏: 5 次 x 200ms 重试)
        var submitBtn = null;
        for (var r = 0; r < 5 && !submitBtn; r++) {
            submitBtn = safeTextMatches(/立即提交|提交订单|确认支付|去支付/).findOne(400);
            if (!submitBtn) sleep(200);
        }
        if (submitBtn) {
            sendLog(tid, "[提交] 点击「" + (submitBtn.text ? submitBtn.text() : "提交") + "」");
            sendStep(tid, "submit", "start");
            humanClick(submitBtn);
        } else {
            sendLog(tid, "[提交] 未捕获提交按钮, 点击右下角提单区域");
            humanPress(Math.floor(device.width * 0.8), Math.floor(device.height * 0.95));
        }
        return this.readResult(task);
    },

    /**
     * 观演人装配 (2026-10-09 真机实证结构):
     * recycler_main → layout_main(ViewGroup) → text_name(全名) + checkbox(可读状态)
     * 策略: 等待列表渲染 → 按姓名找行 → 勾选 checkbox (验证 checked 状态) → 不足补位
     * @returns {string[]} 已选中的观演人姓名
     */
    assembleViewers: function(targetViewers, neededCount, tid) {
        // 等待观演人列表渲染 (网络加载偶发慢, 最多 15s; 中途轻推列表触发渲染)
        for (var w = 0; w < 30; w++) {
            if (id("cn.damai:id/text_name").find().length > 0) break;
            if (w === 8 || w === 18) {
                try {
                    var rv = id("cn.damai:id/recycler_main").findOne(500);
                    if (rv && rv.scrollForward) rv.scrollForward();
                } catch (eS) {}
            }
            sleep(500);
        }

        var rows = this.getViewerRows();
        var selected = [];
        var self = this;

        var isChecked = function(cb) {
            try { return cb.isChecked && cb.isChecked(); } catch (e) { return false; }
        };
        var setChecked = function(row, want, name) {
            var cb = row.checkbox;
            if (!cb) return false;
            if (isChecked(cb) === want) return true;
            var b = cb.bounds();
            criticalTap(Math.floor(b.centerX()), Math.floor(b.centerY()), function() {
                // 重新查找该行的 checkbox 状态
                var rows2 = self.getViewerRows();
                for (var i = 0; i < rows2.length; i++) {
                    if (rows2[i].name === name) return isChecked(rows2[i].checkbox) === want;
                }
                return false;
            }, "观演人勾选 " + name, tid);
            var rows3 = self.getViewerRows();
            for (var j = 0; j < rows3.length; j++) {
                if (rows3[j].name === name) return isChecked(rows3[j].checkbox) === want;
            }
            return false;
        };

        // 初始状态: 大麦可能已预选第一位
        for (var r0 = 0; r0 < rows.length; r0++) {
            if (rows[r0].checkbox && isChecked(rows[r0].checkbox)) selected.push(rows[r0].name);
        }
        if (selected.length > 0) {
            sendLog(tid, "[观演人] 大麦预选已生效: " + selected.join(","));
        }

        // 按指定名单勾选 (未被选中且还有席位需求的)
        var desired = [];
        for (var t = 0; t < targetViewers.length; t++) desired.push(String(targetViewers[t]));
        // 如果预选的不在名单里且名单非空 → 取消预选 (脱敏名兼容)
        var isDesired = function(name) {
            for (var q = 0; q < desired.length; q++) {
                if (desired[q] === name) return true;
                if (name.length >= 2 && desired[q].length >= 2 && desired[q].slice(1) === name.slice(1)) return true;
            }
            return false;
        };
        for (var d0 = 0; d0 < selected.length; d0++) {
            if (desired.length > 0 && !isDesired(selected[d0])) {
                var rowD = this.findRowByName(rows, selected[d0]);
                if (rowD) {
                    sendLog(tid, "[观演人] 取消非目标预选: " + selected[d0]);
                    if (setChecked(rowD, false, selected[d0])) selected.splice(d0, 1);
                }
            }
        }
        // 勾选名单内目标
        for (var d = 0; d < desired.length && selected.length < neededCount; d++) {
            if (selected.indexOf(desired[d]) >= 0) continue;
            var row = this.findRowByNameMasked(rows, desired[d]);
            if (row) {
                if (setChecked(row, true, row.name)) {
                    selected.push(row.name);
                    sendLog(tid, "[观演人] ✔ 已勾选: " + row.name);
                }
            } else {
                sendLog(tid, "[观演人] 名单中未找到: " + desired[d]);
            }
        }
        // 不足则按列表顺序补位
        rows = this.getViewerRows();
        for (var f = 0; f < rows.length && selected.length < neededCount; f++) {
            if (selected.indexOf(rows[f].name) >= 0) continue;
            if (rows[f].checkbox && isChecked(rows[f].checkbox)) {
                selected.push(rows[f].name);
            } else if (rows[f].checkbox) {
                if (setChecked(rows[f], true, rows[f].name)) {
                    selected.push(rows[f].name);
                    sendLog(tid, "[观演人] ✔ 自动补位: " + rows[f].name);
                }
            }
        }
        return selected;
    },

    /** 抓取观演人行: [{name, checkbox, row}] */
    getViewerRows: function() {
        var out = [];
        try {
            var nameNodes = id("cn.damai:id/text_name").find();
            for (var i = 0; i < nameNodes.length; i++) {
                var nd = nameNodes[i];
                var nm = nd.text ? nd.text() : "";
                if (!nm) continue;
                var cb = null;
                var holder = nd.parent();
                for (var up = 0; up < 3 && holder; up++) {
                    try {
                        cb = holder.findOne(id("cn.damai:id/checkbox"));
                        if (cb) break;
                    } catch (eF) {}
                    holder = holder.parent();
                }
                out.push({ name: nm, checkbox: cb, row: nd.parent() });
            }
        } catch (e) {}
        return out;
    },

    findRowByName: function(rows, name) {
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].name === name) return rows[i];
        }
        return null;
    },

    /** 兼容脱敏名匹配: 目标「张凌昊」可命中显示「*凌昊」或全名 */
    findRowByNameMasked: function(rows, name) {
        var exact = this.findRowByName(rows, name);
        if (exact) return exact;
        var masked = name.length > 1 ? ("*" + name.slice(1)) : name;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].name === masked) return rows[i];
        }
        for (var j = 0; j < rows.length; j++) {
            var rn = rows[j].name || "";
            if (rn.length >= 2 && name.slice(1) && rn.slice(1) === name.slice(1)) return rows[j];
        }
        return null;
    },

    /* ================================================================
     * 6. 滑块验证码 (贝塞尔拟人滑动 + 重试, 过不了转人工 —— 成熟项目共识)
     * 2026-10-09 真机实测控件: 滑块钮 id=puzzle-captcha-btn-icon,
     * 提示文案「拖动左侧滑块完成上方拼图」/「操作过于频繁」
     * ================================================================ */
    checkCaptcha: function() {
        if (!(safeTextMatches(/操作过于频繁|完成验证|拖动左侧滑块|向右滑动|还原拼图|拖动滑块/).exists() ||
              safeDescMatches(/操作过于频繁|完成验证|拖动左侧滑块|向右滑动|还原拼图/).exists() ||
              id("cn.damai:id/puzzle-captcha-btn-icon").exists())) {
            return false;
        }
        console.error("[风控] 检测到滑块/拼图验证码, 贝塞尔拟人滑动尝试...");
        try { device.vibrate(600); } catch (e) {}
        try {
            var sliderBtn = id("cn.damai:id/puzzle-captcha-btn-icon").findOne(600) ||
                            idContains("nc_1_n1z").findOne(400) ||
                            safeDescMatches(/>>>|向右滑动|滑块/).findOne(400);
            var startX = 132, startY = 1444;
            if (sliderBtn && sliderBtn.bounds) {
                var sb = sliderBtn.bounds();
                startX = Math.floor(sb.centerX());
                startY = Math.floor(sb.centerY());
            }
            // 拼图缺口多位于轨道 30%~80% 区域, 按概率尝试几个落点
            var targets = [0.55, 0.38, 0.70, 0.45];
            for (var ti = 0; ti < targets.length; ti++) {
                var endX = Math.floor(device.width * targets[ti]);
                humanSlide(startX, startY, endX, startY, 260 + Math.floor(Math.random() * 120));
                sleep(1500);
                if (!safeTextMatches(/拖动左侧滑块|还原拼图|操作过于频繁/).exists() &&
                    !id("cn.damai:id/puzzle-captcha-btn-icon").exists()) {
                    console.log("[风控] 验证码已消失 (可能已通过)");
                    return true;
                }
                // 滑块归位后重新定位起点
                var nb = id("cn.damai:id/puzzle-captcha-btn-icon").findOne(400);
                if (nb && nb.bounds) {
                    var nb2 = nb.bounds();
                    startX = Math.floor(nb2.centerX());
                    startY = Math.floor(nb2.centerY());
                }
            }
        } catch (err) {}
        return true;
    },

    /* ================================================================
     * 7. 结果读取
     * ================================================================ */
    readResult: function(task) {
        sleep(800);
        if (this.checkCaptcha()) {
            return { outcome: "risk_challenge", evidence: "出现滑动验证码, 需人工介入" };
        }
        if (safeTextMatches(/已售罄|无票|缺货登记/).exists()) {
            return { outcome: "no_stock", evidence: "页面显示已售罄/无票" };
        }
        if (safeTextMatches(/选择支付方式|微信支付|支付宝|待付款|订单提交成功|支付剩余时间|排队中/).findOne(2500)) {
            return {
                outcome: "ordered",
                evidence: "成功进入收银台/订单提交成功",
                orderNo: "DM-" + now()
            };
        }
        return { outcome: "unknown", evidence: "未能确定结果状态, 转入人工复核" };
    },

    /* ================================================================
     * 8. 导航至「我的-常用信息」(观演人/地址管理页)
     * ================================================================ */
    navToUserExtras: function(targetTab, tid) {
        sendLog(tid, "[导航] 前往常用信息页, 目标 Tab: " + targetTab);

        var inExtras = function() {
            return safeTextMatches(/常用信息/).exists() ||
                   id("cn.damai:id/id_user_extra_tabs").exists() ||
                   id("cn.damai:id/add_customer_btn").exists() ||
                   id("cn.damai:id/tv_add_main").exists();
        };

        if (!inExtras()) {
            // 在新增子页则先返回
            if (safeTextMatches(/新增实名观演人|新增收货地址|新建收货地址/).exists()) {
                try { back(); } catch (e) {}
                sleep(700);
            }

            if (!inExtras()) {
                // 确保大麦前台并回到首页
                this.ensureForeground(tid);
                var st = this.detectPage();
                if (st.page !== "home") {
                    // 从详情等页面返回首页: 用返回键逐级回退
                    for (var bi = 0; bi < 4; bi++) {
                        if (this.detectPage().page === "home") break;
                        try { back(); } catch (eB) {}
                        sleep(600);
                        this.dismissPopups();
                    }
                    // 兜底: 直接拉首页 MainActivity
                    if (this.detectPage().page !== "home") {
                        try {
                            app.startActivity({
                                packageName: this.packageName,
                                className: "cn.damai.homepage.MainActivity",
                                flags: ["activity_reorder_to_front", "activity_new_task", "activity_single_top"]
                            });
                            sleep(1000);
                            this.dismissPopupsLoop(2);
                        } catch (eH) {}
                    }
                }

                // 点「我的」Tab (先按控件找, 坐标仅最后兜底: 1080x2400 四 Tab 布局)
                var myTab = text("我的").findOne(1200) || id("cn.damai:id/tab_text").text("我的").findOne(800);
                if (myTab) {
                    humanClick(myTab);
                } else {
                    humanPress(Math.floor(device.width * 0.875), Math.floor(device.height * 0.958));
                }
                sleep(900);
                this.dismissPopups();

                // 进「观演人/地址」入口
                var extrasBtn = id("cn.damai:id/tv_mine_dynamic_title").text("观演人/地址").findOne(1500) ||
                                text("观演人/地址").findOne(1200) ||
                                textContains("观演人").findOne(1000);
                if (extrasBtn) {
                    humanClick(extrasBtn);
                } else {
                    // 兜底: 我的页网格第一行 (1080x2400: x=162 附近, y 按首行)
                    humanPress(162, Math.floor(device.height * 0.45));
                }
                sleep(1200);
                this.dismissPopups();
            }
        }

        if (!inExtras()) {
            sendLog(tid, "[导航] 未能到达常用信息页, 当前: " + this.detectPage().activity);
            return false;
        }

        // 切 Tab
        var tabBtn = text(targetTab || "观演人").findOne(1000);
        if (tabBtn) humanClick(tabBtn);
        sleep(600);
        return true;
    },

    /* ================================================================
     * 9. 抓取观演人 / 地址列表
     * ================================================================ */
    scrapeViewers: function() {
        var viewers = [];
        var nameNodes = id("cn.damai:id/user_name").find();
        var cardNodes = id("cn.damai:id/idCard").find();
        if (nameNodes && nameNodes.length > 0) {
            for (var i = 0; i < nameNodes.length; i++) {
                var dName = nameNodes[i].text ? nameNodes[i].text() : ("观演人" + (i + 1));
                var idCard = (cardNodes && cardNodes[i] && cardNodes[i].text) ? cardNodes[i].text() : "";
                viewers.push({
                    id: "v-" + i,
                    name: dName,
                    displayName: dName,
                    idType: "身份证",
                    idCard: idCard
                });
            }
        }
        console.log("[抓取] 观演人 " + viewers.length + " 位");
        return viewers;
    },

    scrapeAddresses: function() {
        var addresses = [];
        var nameNodes = id("cn.damai:id/tv_name").find();
        var phoneNodes = id("cn.damai:id/tv_phone").find();
        var addrNodes = id("cn.damai:id/mine_address_item_detail_address_tv").find();
        if (nameNodes && nameNodes.length > 0) {
            for (var i = 0; i < nameNodes.length; i++) {
                addresses.push({
                    id: "a-" + i,
                    name: nameNodes[i].text ? nameNodes[i].text() : "",
                    phone: (phoneNodes && phoneNodes[i] && phoneNodes[i].text) ? phoneNodes[i].text() : "",
                    address: (addrNodes && addrNodes[i] && addrNodes[i].text) ? addrNodes[i].text() : ""
                });
            }
        }
        console.log("[抓取] 收货地址 " + addresses.length + " 个");
        return addresses;
    },

    /* ================================================================
     * 10. 添加实名观演人 (瞬时填表 + 风控弹窗拦截)
     * ================================================================ */
    addViewer: function(task) {
        var tid = task.taskId;
        var name = (task.data && task.data.name) || "";
        var idCard = (task.data && task.data.idCard) || "";
        sendStep(tid, "add_viewer", "start", name);
        sendLog(tid, "[添加观演人] " + name + " (" + idCard + ")");

        if (!name || !idCard) {
            return { outcome: "failed", evidence: "姓名或身份证号为空, 拒绝执行" };
        }

        if (!this.ensureForeground(tid)) {
            return { outcome: "failed", evidence: "大麦未能回到前台" };
        }
        if (!this.navToUserExtras("观演人", tid)) {
            return { outcome: "failed", evidence: "导航至观演人页失败" };
        }

        // 点击「添加新观演人」
        var addBtn = id("cn.damai:id/add_customer_btn").findOne(2000) ||
                     text("添加新观演人").findOne(1500) ||
                     textContains("添加").findOne(1200);
        if (addBtn) {
            humanClick(addBtn);
        } else {
            sendLog(tid, "[添加观演人] 未找到添加按钮 (可能已达上限)");
            return { outcome: "failed", evidence: "未找到「添加新观演人」按钮" };
        }
        sleep(1000);
        this.dismissPopups();

        // 瞬时填表: 姓名和身份证一次性填完 (毫秒级)
        var t0 = now();
        var nameEt = id("cn.damai:id/add_contacts_name").findOne(2500);
        if (!nameEt) {
            return { outcome: "failed", evidence: "未能定位姓名输入框 (页面未就位)" };
        }
        var cardEt = id("cn.damai:id/add_contacts_idcard_number").findOne(1200);
        if (!cardEt) {
            return { outcome: "failed", evidence: "未能定位身份证号输入框" };
        }
        var okName = fillField(function() { return id("cn.damai:id/add_contacts_name").findOne(800); }, name);
        var okCard = fillField(function() { return id("cn.damai:id/add_contacts_idcard_number").findOne(800); }, idCard);
        sendLog(tid, "[添加观演人] 表单瞬时填充完成 耗时 " + (now() - t0) + "ms (姓名:" + okName + " 证件:" + okCard + ")");

        if (!okName || !okCard) {
            return { outcome: "failed", evidence: "表单填充失败 (输入框不可写)" };
        }

        // 收起软键盘 (点中性区域失焦, 绝不用 back 以免退出页面)
        try {
            var titleV = text("新增实名观演人").findOne(500) ||
                         id("cn.damai:id/add_contacts_name").findOne(300);
            if (titleV && titleV.bounds) {
                var tvb = titleV.bounds();
                humanPress(Math.floor(tvb.centerX()), Math.max(60, Math.floor(tvb.centerY()) - 200));
                sleep(350);
            }
        } catch (eK) {}

        // 勾选实名协议 (先找 checkbox, 找不到再点文本区)
        var agreed = false;
        var noticeBox = null;
        try {
            var pageRoot = id("cn.damai:id/add_contacts_notice").findOne(600);
            if (pageRoot) {
                // 通知区块内或邻近找 checkbox
                var holder = pageRoot.parent() || pageRoot;
                noticeBox = holder.findOne(className("android.widget.CheckBox"));
            }
        } catch (eN) {}
        if (!noticeBox) {
            try { noticeBox = className("android.widget.CheckBox").findOne(500); } catch (eN2) {}
        }
        if (noticeBox) {
            try {
                if (!(noticeBox.isChecked && noticeBox.isChecked())) {
                    humanClick(noticeBox);
                    sleep(250);
                }
                agreed = true;
            } catch (eC) {}
        }
        if (!agreed) {
            // 文本坐标兜底 (协议勾选区)
            var noticeNode = id("cn.damai:id/add_contacts_notice").findOne(600);
            if (noticeNode && noticeNode.bounds) {
                var nb = noticeNode.bounds();
                humanPress(nb.left + 24, Math.floor(nb.centerY()));
                sleep(250);
            }
        }

        // 点击保存
        var saveBtn = id("cn.damai:id/add_contacts_save_btn").findOne(1200) ||
                      text("确定").findOne(800) ||
                      text("保存").findOne(800);
        if (saveBtn) {
            humanClick(saveBtn);
        } else {
            humanPress(Math.floor(device.width * 0.5), Math.floor(device.height * 0.95));
        }
        sendLog(tid, "[添加观演人] 已点击保存, 等待大麦校验...");
        sleep(1500);

        // 风控/错误弹窗拦截
        var alertRes = this.detectViewerError(tid);
        if (alertRes) return alertRes;

        // 成功判定: 已离开新增页回到列表
        for (var w = 0; w < 6; w++) {
            if (!safeTextMatches(/新增实名观演人/).exists() && !id("cn.damai:id/add_contacts_name").exists()) {
                var updated = this.scrapeViewers();
                sendStep(tid, "add_viewer", "done", name);
                return {
                    outcome: "success",
                    message: "观演人【" + name + "】添加成功",
                    evidence: "成功添加实名观演人: " + name + " (现有 " + updated.length + " 位)",
                    data: { viewers: updated }
                };
            }
            var alertRes2 = this.detectViewerError(tid);
            if (alertRes2) return alertRes2;
            sleep(700);
        }
        sendStep(tid, "add_viewer", "failed", "保存后仍停留新增页");
        return {
            outcome: "failed",
            reason: "damai_id_validation_error",
            message: "大麦未接受该观演人 (保存后仍停留新增页)",
            evidence: "保存后仍停留新增页 (可能证件信息被拒)"
        };
    },

    /** 检测大麦证件校验错误弹窗/Toast */
    detectViewerError: function(tid) {
        var alertTip = id("cn.damai:id/damai_dialog_tip_content").findOne(600) ||
                       safeTextMatches(/.*您的证件信息有误.*|.*错误输入超过5次.*|.*证件号码输入有误.*|.*请校验后重新输入.*|.*已存在.*观演人.*|.*添加失败.*/).findOne(600);
        if (!alertTip) return null;
        var alertMsg = alertTip.text ? alertTip.text() : "证件信息校验未通过";
        sendLog(tid, "[添加观演人] 大麦返回错误: " + alertMsg);
        var confirmBtn = id("cn.damai:id/damai_dialog_confirm_btn").findOne(800) ||
                         text("知道了").findOne(600) ||
                         text("确定").findOne(600);
        if (confirmBtn) humanClick(confirmBtn);
        sleep(500);
        try { back(); } catch (eB) {}
        sleep(500);
        return {
            outcome: "failed",
            reason: "damai_id_validation_error",
            message: alertMsg,
            evidence: alertMsg
        };
    },

    /* ================================================================
     * 11. 添加收货地址 (瞬时填表 + 三列 WheelView 省市区选择)
     * ================================================================ */

    /** 解析省市区字符串 → [省, 市, 区] (兼容部分值: "浙江省杭州市市" / "北京北京市东城区") */
    parseRegion: function(region) {
        var s = String(region || "").replace(/\s+/g, "");
        if (!s) return null;
        var m = s.match(/^((?:北京|上海|天津|重庆)市?|[^省]+?省|[^省]+?自治区)([^市]+?市|[^市]+?地区|[^市]+?盟|[^市]+?州)(.+)$/);
        if (m && m[3] && m[3].length >= 2) return [m[1], m[2], m[3]];
        // 部分值: 只有省+市 (区县未选, 文本形如 "浙江省杭州市市")
        var m2 = s.match(/^((?:北京|上海|天津|重庆)市?|[^省]+?省|[^省]+?自治区)(.+市)$/);
        if (m2) return [m2[1], m2[2], null];
        return null;
    },

    /** 区划数据集 (regions.json 由 PC 部署时生成推送: [[省名, [[市名, [区名...]]...]]...]) */
    _regionTree: null,

    loadRegionTree: function() {
        if (this._regionTree) return this._regionTree;
        try {
            var p = "/sdcard/qg-agent/regions.json";
            if (files.exists(p)) {
                this._regionTree = JSON.parse(files.read(p));
                sendLog("damai", "[地区] 数据集已载入: " + this._regionTree.length + " 省级单位");
                return this._regionTree;
            }
        } catch (e) {
            sendLog("damai", "[地区] 数据集载入失败: " + e.message);
        }
        this._regionTree = [];
        return this._regionTree;
    },

    /** 名称归一化 (去掉 省/市/区 等后缀差异, 用于比对) */
    normRegionName: function(s) {
        return String(s || "").replace(/(维吾尔|壮族|回族|自治区|特别行政区|自治州|自治县|省|市|区|县|地区|盟|新区)$/g, "");
    },

    /** 在数据集中按名称查找 [provIdx, cityIdx, countyIdx] (后缀模糊匹配) */
    findRegionIndices: function(parts) {
        var r = this.findLevelIndices(parts);
        return r.complete ? [r.p, r.c, r.a] : null;
    },

    /** 分级查找: 返回 {p, c, a, complete} 任意级别可单独使用 */
    findLevelIndices: function(parts) {
        var tree = this.loadRegionTree();
        var out = { p: -1, c: -1, a: -1, complete: false };
        if (!tree.length) return out;
        for (var i = 0; i < tree.length; i++) {
            if (this.normRegionName(tree[i][0]) === this.normRegionName(parts[0])) { out.p = i; break; }
        }
        if (out.p < 0) return out;
        var cities = tree[out.p][1] || [];
        for (var j = 0; j < cities.length; j++) {
            if (this.normRegionName(cities[j][0]) === this.normRegionName(parts[1])) { out.c = j; break; }
        }
        if (out.c < 0) return out;
        var counties = cities[out.c][1] || [];
        for (var k = 0; k < counties.length; k++) {
            if (this.normRegionName(counties[k]) === this.normRegionName(parts[2])) { out.a = k; break; }
        }
        out.complete = out.a >= 0;
        return out;
    },

    /** 查省级索引 */
    findProvIdx: function(name) {
        var tree = this.loadRegionTree();
        for (var i = 0; i < tree.length; i++) {
            if (this.normRegionName(tree[i][0]) === this.normRegionName(name)) return i;
        }
        return -1;
    },

    /** 查省内市级索引 (未选中时按默认索引 0) */
    findCityIdx: function(provName, cityName) {
        var tree = this.loadRegionTree();
        for (var i = 0; i < tree.length; i++) {
            if (this.normRegionName(tree[i][0]) === this.normRegionName(provName)) {
                if (!cityName) return 0;
                var cities = tree[i][1] || [];
                for (var j = 0; j < cities.length; j++) {
                    if (this.normRegionName(cities[j][0]) === this.normRegionName(cityName)) return j;
                }
            }
        }
        return -1;
    },

    /** 查市内区县索引 (未选中时按默认索引 0) */
    findCountyIdx: function(provName, cityName, countyName) {
        var tree = this.loadRegionTree();
        for (var i = 0; i < tree.length; i++) {
            if (this.normRegionName(tree[i][0]) === this.normRegionName(provName)) {
                var cities = tree[i][1] || [];
                for (var j = 0; j < cities.length; j++) {
                    if (this.normRegionName(cities[j][0]) === this.normRegionName(cityName)) {
                        if (!countyName) return 0;
                        var counties = cities[j][1] || [];
                        for (var k = 0; k < counties.length; k++) {
                            if (this.normRegionName(counties[k]) === this.normRegionName(countyName)) return k;
                        }
                    }
                }
            }
        }
        return -1;
    },

    /**
     * 滚轮逐格慢速拖动 (每 120px = 1 项, 20px/100ms 连续手势, 零惯性)
     * 关键约束: 手指路径必须始终保持在滚轮控件边界内 (出界滚轮即停止跟踪),
     * 因此拆分为每段 ≤2 项 (240px) 的连续手势序列。
     * @param wheelId 滚轮控件 id
     * @param items 移动项数 (正=列表向后)
     */
    stepWheel: function(wheelId, items) {
        if (!items) return true;
        var wheel = id(wheelId).findOne(1500);
        if (!wheel || !wheel.bounds) {
            sendLog("damai", "[地区] 未找到滚轮: " + wheelId);
            return false;
        }
        var b = wheel.bounds();
        var x = Math.floor(b.centerX());
        var y = Math.floor(b.centerY());
        var itemH = Math.max(40, Math.floor(b.height() / 5));

        var remaining = items;
        while (remaining !== 0) {
            var chunk = Math.max(-2, Math.min(2, remaining)); // 每段最多 2 项, 保证不出界
            var pixelDelta = -chunk * itemH; // 正向(列表向后) = 手指向上
            var steps = Math.ceil(Math.abs(pixelDelta) / 20);
            var pts = [];
            for (var i = 0; i <= steps; i++) {
                pts.push([x + Math.round((Math.random() - 0.5) * 3), y + Math.round(pixelDelta * i / steps)]);
            }
            try {
                gesture(100 * steps, pts); // 20px / 100ms 极慢连续拖动
            } catch (e) {
                try { swipe(x, y, x, y + pixelDelta, 100 * steps); } catch (e2) {}
            }
            remaining -= chunk;
            if (remaining !== 0) sleep(180);
        }
        sleep(300);
        return true;
    },

    isRegionPickerOpen: function() {
        return id("cn.damai:id/common_business_province_wheel_view").exists() ||
               id("cn.damai:id/common_business_division_select_completed_tv").exists();
    },

    /** 收起软键盘 (点击页面标题等中性区域使输入框失焦) */
    collapseKeyboard: function() {
        try {
            var title = id("cn.damai:id/common_business_add_address_title_main_tv").findOne(500) ||
                        text("新增收货地址").findOne(400);
            if (title && title.bounds) {
                var tb = title.bounds();
                humanPress(Math.floor(tb.centerX()), Math.floor(tb.centerY()));
                sleep(350);
            }
        } catch (e) {}
    },

    /** 读取表单「所在地区」当前已选文本 (带重试) */
    readRegionValue: function() {
        for (var i = 0; i < 3; i++) {
            try {
                var node = id("cn.damai:id/common_business_consignee_region_tv").findOne(600);
                if (node && node.text && node.text()) return node.text();
            } catch (e) {}
            sleep(300);
        }
        return null;
    },

    /** 点击选择器「完成」并确认选择器已关闭 (重试) */
    clickRegionDone: function() {
        for (var i = 0; i < 3; i++) {
            var doneBtn = id("cn.damai:id/common_business_division_select_completed_tv").findOne(600) ||
                          id("cn.damai:id/common_business_division_select_completed").findOne(400) ||
                          text("完成").findOne(400);
            if (!doneBtn) return false;
            if (doneBtn.bounds) {
                var db = doneBtn.bounds();
                humanPress(Math.floor(db.centerX()), Math.floor(db.centerY()));
            } else {
                humanClick(doneBtn);
            }
            sleep(600);
            if (!this.isRegionPickerOpen()) return true;
        }
        return false;
    },

    /**
     * 省市区选择 (三列 canvas WheelView, 分级校正循环):
     * 大麦滚轮为自绘控件 (无障碍无子节点), 顺序与国标存在局部差异,
     * 因此每一级独立执行: 读当前值 → 索引差逐格慢拖 → 完成 → 回读验证 → 偏差修正。
     * 每格 = 控件高度/5 像素的连续慢速拖动 (实测零惯性、逐格精确)。
     */
    selectRegion: function(regionStr, regionParts, tid) {
        var parts = (regionParts && regionParts.length >= 3) ? regionParts.slice(0, 3) : this.parseRegion(regionStr);
        if (!parts) {
            sendLog(tid, "[地区] 无法解析省市区: " + regionStr);
            return false;
        }
        if (!this.loadRegionTree().length) {
            sendLog(tid, "[地区] 手机缺少 regions.json 数据集 (请先在控制台部署)");
            return false;
        }

        this.collapseKeyboard();

        var levels = [
            { name: "省", wheel: "cn.damai:id/common_business_province_wheel_view", part: 0,
              idxOf: function(self, cur) { return self.findProvIdx(cur[0]); },
              tgtIdx: this.findProvIdx(parts[0]) },
            { name: "市", wheel: "cn.damai:id/common_business_city_wheel_view", part: 1,
              idxOf: function(self, cur) { return self.findCityIdx(cur[0], cur[1]); },
              tgtIdx: this.findCityIdx(parts[0], parts[1]) },
            { name: "区县", wheel: "cn.damai:id/common_business_county_wheel_view", part: 2,
              idxOf: function(self, cur) { return self.findCountyIdx(cur[0], cur[1], cur[2]); },
              tgtIdx: this.findCountyIdx(parts[0], parts[1], parts[2]) }
        ];

        for (var li = 0; li < levels.length; li++) {
            var lv = levels[li];
            if (lv.tgtIdx < 0) {
                sendLog(tid, "[地区] 数据集中未找到" + lv.name + ": " + parts[lv.part]);
                return false;
            }
            var ok = false;
            // 阶段一: 索引预测 + 偏差修正 (省/市级与国标顺序一致时直达)
            for (var attempt = 0; attempt < 2 && !ok; attempt++) {
                ok = this.levelAdjustOnce(lv, parts, li, tid);
            }
            // 阶段二: 逐格扫描兜底 (大麦区县级顺序与国标存在重排)
            if (!ok) {
                sendLog(tid, "[地区] " + lv.name + "级索引预测未命中, 转入逐格扫描");
                ok = this.levelScan(lv, parts, tid);
            }
            if (!ok) {
                sendLog(tid, "[地区] ✘ " + lv.name + "级最终未命中, 当前: " + this.readRegionValue());
                return false;
            }
        }

        sendLog(tid, "[地区] ✔ 三级地区全部验证通过: " + parts.join(" / "));
        return true;
    },

    /** 单次索引差调整 + 验证 (返回是否命中) */
    levelAdjustOnce: function(lv, parts, li, tid) {
        var curText = this.readRegionValue();
        var curParts = (curText && this.parseRegion(curText)) || ["北京市", "北京市", "东城区"];
        var curIdx = lv.idxOf(this, curParts);
        if (curIdx < 0) {
            sendLog(tid, "[地区] 当前" + lv.name + "不在数据集中: " + curParts[lv.part]);
            return false;
        }
        var delta = lv.tgtIdx - curIdx;
        if (delta === 0) return true;
        if (!this.openRegionPicker()) return false;
        this.stepWheel(lv.wheel, delta);
        if (!this.clickRegionDone()) {
            this.closeRegionPicker();
            return false;
        }
        var afterText = this.readRegionValue();
        var afterParts = afterText ? this.parseRegion(afterText) : null;
        if (afterParts && this.normRegionName(afterParts[lv.part]) === this.normRegionName(parts[lv.part])) {
            sendLog(tid, "[地区] " + lv.name + "级就位: " + parts[lv.part]);
            return true;
        }
        sendLog(tid, "[地区] " + lv.name + "级未命中 (期望 " + parts[lv.part] + " 实际 " + (afterParts ? afterParts[lv.part] : afterText) + ")");
        return false;
    },

    /** 逐格扫描: 每步移动 1 格并读值验证, 边界处自动翻转方向 */
    levelScan: function(lv, parts, tid) {
        var dir = 1;
        var prev = null;
        for (var n = 0; n < 40; n++) {
            var curText = this.readRegionValue();
            var curParts = curText ? this.parseRegion(curText) : null;
            if (curParts && this.normRegionName(curParts[lv.part]) === this.normRegionName(parts[lv.part])) {
                return true;
            }
            // 值未变化说明到达列表边界, 翻转方向
            if (prev !== null && curParts && prev === curParts[lv.part]) {
                dir = -dir;
            }
            prev = curParts ? curParts[lv.part] : null;
            if (!this.openRegionPicker()) return false;
            this.stepWheel(lv.wheel, dir);
            if (!this.clickRegionDone()) {
                this.closeRegionPicker();
                return false;
            }
        }
        return false;
    },

    /** 打开地区选择器 (返回是否成功打开) */
    openRegionPicker: function() {
        this.collapseKeyboard();
        var row = id("cn.damai:id/common_business_consignee_region_tv").findOne(1500) ||
                  text("所在地区").findOne(800);
        if (!row) {
            sendLog("damai", "[地区] 未找到「所在地区」行");
            return false;
        }
        humanClick(row);
        sleep(600);
        if (!this.isRegionPickerOpen()) {
            sendLog("damai", "[地区] 选择器未打开");
            return false;
        }
        return true;
    },

    closeRegionPicker: function() {
        try {
            var cancel = id("cn.damai:id/common_business_division_select_cancel_tv").findOne(400) ||
                         safeTextMatches(/取消/).findOne(400);
            if (cancel) { humanClick(cancel); return; }
        } catch (e) {}
        try { back(); } catch (e2) {}
    },

    addAddress: function(task) {
        var tid = task.taskId;
        var name = (task.data && task.data.name) || "";
        var phone = (task.data && task.data.phone) || "";
        var detailAddress = (task.data && task.data.detailAddress) || "";
        var region = (task.data && task.data.region) || "";
        var regionParts = (task.data && task.data.regionParts) || null;
        sendStep(tid, "add_address", "start", name);
        sendLog(tid, "[添加地址] " + name + " (" + phone + ") " + region + " " + detailAddress);

        if (!name || !phone || !detailAddress) {
            return { outcome: "failed", evidence: "收货人、手机号或详细地址为空" };
        }

        if (!this.ensureForeground(tid)) {
            return { outcome: "failed", evidence: "大麦未能回到前台" };
        }
        if (!this.navToUserExtras("收货地址", tid)) {
            return { outcome: "failed", evidence: "导航至收货地址页失败" };
        }

        // 点击「添加收货地址」
        var addBtn = id("cn.damai:id/tv_add_main").findOne(2000) ||
                     text("添加收货地址").findOne(1500) ||
                     textContains("新增收货地址").findOne(1200);
        if (addBtn) {
            humanClick(addBtn);
        } else {
            sendLog(tid, "[添加地址] 未找到添加按钮");
            return { outcome: "failed", evidence: "未找到「添加收货地址」按钮" };
        }
        sleep(1000);
        this.dismissPopups();

        // ===== 瞬时填表: 姓名/手机/详细地址一次性毫秒级填完 =====
        var t0 = now();
        var nameEt = id("cn.damai:id/common_business_consignee_name_et").findOne(2500);
        if (!nameEt) {
            return { outcome: "failed", evidence: "未能定位收货人输入框" };
        }
        var okName = fillField(function() { return id("cn.damai:id/common_business_consignee_name_et").findOne(800); }, name);
        var okPhone = fillField(function() { return id("cn.damai:id/common_business_consignee_phone_et").findOne(800); }, phone);
        var okDetail = fillField(function() { return id("cn.damai:id/common_business_consignee_detail_address_et").findOne(800); }, detailAddress);
        sendLog(tid, "[添加地址] 文本表单瞬时填充完成 耗时 " + (now() - t0) + "ms (姓名:" + okName + " 手机:" + okPhone + " 详情:" + okDetail + ")");
        if (!okName) {
            return { outcome: "failed", evidence: "收货人姓名填充失败" };
        }
        if (!okPhone) {
            return { outcome: "failed", evidence: "手机号填充失败" };
        }
        if (!okDetail) {
            return { outcome: "failed", evidence: "详细地址填充失败" };
        }

        // ===== 省市区选择 (唯一需要额外点击的部分) =====
        var regionOk = this.selectRegion(region, regionParts, tid);
        if (!regionOk) {
            return { outcome: "failed", evidence: "省市区选择失败 (未匹配到: " + region + ")" };
        }

        // 收起键盘 (确保保存按钮不被遮挡)
        this.collapseKeyboard();

        // 保存
        var saveBtn = id("cn.damai:id/common_business_add_address_title_right_tv").findOne(1200) ||
                      text("保存").findOne(800);
        if (saveBtn) {
            humanClick(saveBtn);
        } else {
            humanPress(Math.floor(device.width * 0.92), Math.floor(device.height * 0.055));
        }
        sendLog(tid, "[添加地址] 已点击保存, 等待结果...");
        sleep(1500);

        // 检查错误弹窗
        var errTip = id("cn.damai:id/damai_dialog_tip_content").findOne(800) ||
                     safeTextMatches(/.*保存失败.*|.*请填写.*|.*请选择.*|.*地址.*有误.*/).findOne(600);
        if (errTip) {
            var errMsg = errTip.text ? errTip.text() : "地址保存失败";
            sendLog(tid, "[添加地址] 大麦返回错误: " + errMsg);
            var cfm = id("cn.damai:id/damai_dialog_confirm_btn").findOne(600) || text("知道了").findOne(500);
            if (cfm) humanClick(cfm);
            return { outcome: "failed", reason: "damai_address_error", message: errMsg, evidence: errMsg };
        }

        // 成功判定: 已回到地址列表
        for (var w = 0; w < 6; w++) {
            if (!id("cn.damai:id/common_business_consignee_name_et").exists()) {
                var updated = this.scrapeAddresses();
                sendStep(tid, "add_address", "done", name);
                return {
                    outcome: "success",
                    message: "收货地址添加成功: " + name + " (" + phone + ")",
                    evidence: "成功添加收货地址: " + region + " " + detailAddress,
                    data: { addresses: updated }
                };
            }
            sleep(700);
        }
        sendStep(tid, "add_address", "failed", "保存后仍停留新增页");
        return { outcome: "failed", reason: "damai_address_error", message: "保存后未返回列表页", evidence: "保存后仍停留新增页" };
    },

    /* ================================================================
     * 12. 抢购主流程 (预热 → 等待 → 高频击发)
     * ================================================================ */
    /** 详情页倒计时文本 (如 "12月06日 20:00") */
    readSaleCountdown: function() {
        try {
            var node = id("cn.damai:id/id_project_count_sell_time").findOne(800);
            if (node && node.text) return node.text();
        } catch (e) {}
        return null;
    },

    /**
     * 高频监测击发 (开售前 1 秒进入):
     * 在详情页忙轮询购买按钮, 文案从「即将开售/倒计时」变为可购买状态的瞬间立即点击
     */
    watchAndFireOnDetail: function(task, fireAtServerMs, tid) {
        sendLog(tid, "[高频监测] 进入按钮状态高频盯梢模式");
        var buyStates = /立即购买|立即购票|立即预订|特惠购票|特惠购买|选座购买|立即订购|去抢票/;
        var pendingStates = /即将开售|即将售|预约|预售|倒计时|缺货登记|售罄|已预约|不可售|即将/;

        // 最后 1 秒: 高频轮询 (每 ~50ms 一轮)
        var lastLog = 0;
        while (true) {
            var tvMain = null;
            try { tvMain = id("cn.damai:id/tv_left_main_text").findOne(0); } catch (e) {}
            if (tvMain) {
                var t = tvMain.text ? tvMain.text() : "";
                if (t && buyStates.test(t) && !pendingStates.test(t)) {
                    var b = tvMain.bounds();
                    sendLog(tid, "[高频监测] 按钮可购! 文案「" + t + "」→ 立即击发");
                    fastPress(Math.floor(b.centerX()), Math.floor(b.centerY()));
                    return true;
                }
            }
            // 低频心跳日志 (避免刷屏)
            if (now() - lastLog > 3000) {
                lastLog = now();
                sendLog(tid, "[高频监测] 盯梢中... 按钮文案: " + (tvMain && tvMain.text ? tvMain.text() : "(未渲染)"));
            }
            sleep(45);
        }
    },

    recover: function(err) {
        console.warn("[大麦恢复] 异常回退: " + (err ? err.message : ""));
        AnchorFire.reset();
    }
};


// ==================== [7. Main 调度主逻辑] ====================

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
