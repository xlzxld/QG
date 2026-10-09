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
        // 局域网地址：由 hub.conf（PC 部署时写入）追加在后面（2026-10-09: 修掉"局域网被插到队首、
        // 结果插着数据线也永远走 WiFi"的问题 —— 现在按"有线优先, 没有才 WiFi"）
    ],
    USB_URL: "http://127.0.0.1:3120",
    USB_PROBE_TIMEOUT_MS: 1200,      // 探测超时短一点: 没插线就立刻回落, 不拖慢启动
    USB_PROBE_CACHE_MS: 15000,       // 探测结果缓存 15s, 避免频繁探测
    activeHubUrl: null,
    deviceId: null,
    heartbeatTimer: null,
    isPolling: false,
    consecutiveHeartbeatFailures: 0,
    taskState: "idle",
    currentTaskId: null,
    cancelRequestedTaskId: null, // 中枢请求取消的任务 (经心跳响应回带; 任务执行期间唯一可靠的下行通道)

    init: function(customHubUrl) {
        // 读取 PC 部署时自动写入的 hub.conf (含最新局域网 IP, 多行多地址)
        try {
            var confPath = "/sdcard/qg-agent/hub.conf";
            if (files.exists(confPath)) {
                var savedUrls = String(files.read(confPath)).split(/[\n\r]+/).map(function(s) { return s.trim(); }).filter(Boolean);
                for (var i = 0; i < savedUrls.length; i++) {
                    if (savedUrls[i].indexOf("http") === 0 && this.hubUrls.indexOf(savedUrls[i]) < 0) {
                        this.hubUrls.push(savedUrls[i]);   // 追加在 USB 之后: 有线优先
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
     * 探测数据线通道 (adb reverse → 127.0.0.1:3120)。
     * 有线通道不受 WiFi 休眠/抖动影响, 是"闲置后第一个请求慢"的根治办法。
     * @param {boolean} force 任务开始时强制重探 (绕过缓存)
     */
    probeUsb: function(force) {
        var t = 0;
        try { t = java.lang.System.currentTimeMillis(); } catch (eT) { t = Date.now(); }
        if (!force && this._usbProbedAt && (t - this._usbProbedAt) < this.USB_PROBE_CACHE_MS) return !!this._usbAlive;
        this._usbProbedAt = t;
        try {
            var res = http.get(this.USB_URL + "/health", { timeout: this.USB_PROBE_TIMEOUT_MS });
            this._usbAlive = !!(res && res.statusCode === 200);
            if (res && res.body) { try { res.body.close(); } catch (e1) {} }
            console.log("【通道】USB 探测 " + (this._usbAlive ? ("✓ 数据线可用 " + this.USB_URL) : "✘ 不可用 → 回落 WiFi"));
        } catch (e2) {
            this._usbAlive = false;
            console.log("【通道】USB 探测 ✘ " + e2.message + " → 回落 WiFi");
        }
        return !!this._usbAlive;
    },

    /** 通道校准: 实测一次往返耗时 (给端侧节拍换算用, 让"预估真实节拍"有据可依) */
    calibrateChannel: function() {
        var w = this.warmChannel(1500);
        return { ok: !!(w && w.ok), ms: (w && w.ms) || 0, url: this.activeHubUrl || "" };
    },

    /**
     * 探测可用 Hub 节点 —— 2026-10-09 修正为「数据线优先」:
     *   ① 先探 USB (adb reverse 127.0.0.1) → 通了就用它
     *   ② 没插线/隧道没建好 → 回落 hub.conf 的局域网地址
     *   ③ 都不通 → 同网段扫描 → 兜底
     */
    detectHub: function(forceUsb) {
        if (this.probeUsb(forceUsb)) {
            var prevUsb = this.activeHubUrl;
            this.activeHubUrl = this.USB_URL;
            console.log("【通信建立】走数据线 (USB 反向): " + this.USB_URL);
            if (prevUsb !== this.USB_URL || !this.hasRegistered) this.hello();
            return true;
        }
        for (var i = 0; i < this.hubUrls.length; i++) {
            var url = this.hubUrls[i];
            if (url === this.USB_URL) continue;   // USB 已在上面探过, 不重复等 2.5s
            try {
                var res = http.get(url + "/health", { timeout: 2500 });
                if (res && res.statusCode === 200) {
                    var prevUrl = this.activeHubUrl;
                    this.activeHubUrl = url;
                    console.log("【通信建立】成功连接至 Hub (WiFi): " + url);
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
                scriptSize: this.scriptSize(),   // 本脚本体积: 中枢据此判断"手机脚本是否最新"
                ts: java.lang.System.currentTimeMillis()
            };
            var res = http.postJson(this.activeHubUrl + "/api/device/heartbeat", payload, { timeout: 3000 });
            var ok = res && res.statusCode === 200;
            if (ok && res.body) {
                // 解析响应体: 中枢可能捎带「取消当前任务」指令 (任务执行期间唯一可靠下行通道)
                try {
                    var hbJson = JSON.parse(res.body.string());
                    if (hbJson && hbJson.control) {
                        var ctl = hbJson.control;
                        if (ctl.cancelTaskId) {
                            if (this.cancelRequestedTaskId !== ctl.cancelTaskId) {
                                console.warn("【终止指令】收到中枢取消请求: " + ctl.cancelTaskId);
                            }
                            this.cancelRequestedTaskId = ctl.cancelTaskId;
                        }
                        // 停止整个脚本 (2026-10-09: 电脑端一键让手机 Agent 下线, 不用碰手机)
                        if (ctl.stopAgent && !this.stopRequested) {
                            this.stopRequested = true;
                            console.warn("【停止指令】收到中枢「停止脚本」请求, 本轮心跳后退出");
                        }
                        // 局域网自更新 (2026-10-09: 免数据线更新手机脚本)
                        if (ctl.selfUpdate && !this.updateRequested) {
                            this.updateRequested = true;
                            console.warn("【自更新】收到中枢「更新脚本」请求, 下次 tick 执行");
                        }
                    }
                } catch (eH) {
                    // 解析失败不影响心跳本身
                }
            }
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
    adbTap: function(x, y, timeoutMs) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return false;
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/tap", { x: Math.round(x), y: Math.round(y) }, { timeout: timeoutMs || 2500 });
            return res && res.statusCode === 200;
        } catch (e) {
            return false;
        }
    },

    /**
     * 通道预检 (T0 前探一次路): 确认中枢可达 + 唤醒链路, 返回耗时。
     * 首击是全场最关键的一下 —— 网络抖动时宁可提前知道, 也不要到点才发现打不出去。
     */
    warmChannel: function(timeoutMs) {
        var t0 = Date.now();
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return { ok: false, ms: Date.now() - t0, reason: "无可达中枢" };
        try {
            var res = http.get(this.activeHubUrl + "/api/status", { timeout: timeoutMs || 1500 });
            var ok = !!(res && res.statusCode === 200);
            if (res && res.body) { try { res.body.close(); } catch (eC) {} }
            return { ok: ok, ms: Date.now() - t0, reason: ok ? "" : ("HTTP " + (res ? res.statusCode : "无响应")) };
        } catch (e) {
            return { ok: false, ms: Date.now() - t0, reason: e.message };
        }
    },

    /**
     * 预置击发: 把 T0 那一发 "排在中枢时钟上" (atHubMs 走中枢时间轴 —— 就是任务里的 fireAtEpochMs)。
     * 到点由中枢直接写常驻 shell (3ms 级), 不依赖 T0 那一瞬的网络往返。
     */
    armTap: function(x, y, atHubMs, tag, timeoutMs) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return { ok: false, reason: "无可达中枢" };
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/arm-tap",
                { x: Math.round(x), y: Math.round(y), atMs: Math.round(atHubMs), tag: String(tag || "arm") },
                { timeout: timeoutMs || 1500 });
            var ok = !!(res && res.statusCode === 200);
            if (res && res.body) { try { res.body.close(); } catch (eC) {} }
            return { ok: ok, reason: ok ? "" : ("HTTP " + (res ? res.statusCode : "无响应")) };
        } catch (e) {
            return { ok: false, reason: e.message };
        }
    },

    disarmTap: function(tag, timeoutMs) {
        if (!this.activeHubUrl) return { ok: false, reason: "无可达中枢" };
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/disarm-tap", { tag: String(tag || "") }, { timeout: timeoutMs || 1200 });
            var ok = !!(res && res.statusCode === 200);
            if (res && res.body) { try { res.body.close(); } catch (eD) {} }
            return { ok: ok };
        } catch (e) {
            return { ok: false, reason: e.message };
        }
    },

    /** 查预置击发的实际落点偏差 (中枢侧记录, 用于验收) */
    armStatus: function(tag, timeoutMs) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return null;
        try {
            var res = http.get(this.activeHubUrl + "/api/adb/arm-status?tag=" + encodeURIComponent(String(tag || "")), { timeout: timeoutMs || 1500 });
            if (!res || res.statusCode !== 200 || !res.body) return null;
            var txt = res.body.string();
            try { res.body.close(); } catch (eS) {}
            return JSON.parse(txt);
        } catch (e) {
            return null;
        }
    },
    /** 让中枢存一份诊断证据 (界面树 + 截图), 返回文件路径清单; 失败返回 null (不阻塞主流程) */
    diagSnapshot: function(tag, timeoutMs) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return null;
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/diag-snapshot", { tag: String(tag || "diag") }, { timeout: timeoutMs || 25000 });
            if (!res || res.statusCode !== 200 || !res.body) return null;
            var txt = res.body.string();
            try { res.body.close(); } catch (eC) {}
            return JSON.parse(txt);
        } catch (e) {
            return null;
        }
    },

    /** 本脚本文件路径 (自更新写入目标) */
    myScriptPath: function() {
        try {
            var src = engines.myEngine().source;
            if (src && String(src).slice(-3) === ".js" && files.exists(String(src))) return String(src);
        } catch (e1) {}
        return "/sdcard/qg-agent/main.js";
    },

    /** 本脚本体积 (字节; 上报给中枢做"是否最新"对账) */
    scriptSize: function() {
        if (this._scriptSize !== undefined) return this._scriptSize;
        try { this._scriptSize = files.size(this.myScriptPath()); } catch (e) { this._scriptSize = 0; }
        return this._scriptSize;
    },

    /**
     * 局域网自更新: 从中枢 GET /agent/main.js 覆盖本地脚本 (2026-10-09)
     * 免数据线 —— 手机只要能连到中枢(USB 反向或 WiFi)即可。
     */
    selfUpdate: function() {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return { ok: false, reason: "无可达中枢" };
        var url = this.activeHubUrl + "/agent/main.js";
        var target = this.myScriptPath();
        try {
            console.log("【自更新】下载 " + url);
            var res = http.get(url, { timeout: 40000 });
            if (!res || res.statusCode !== 200 || !res.body) {
                return { ok: false, reason: "HTTP " + (res ? res.statusCode : "无响应") };
            }
            var bytes = res.body.bytes();
            try { res.body.close(); } catch (eC) {}
            if (!bytes || !bytes.length) return { ok: false, reason: "下载内容为空" };
            files.writeBytes(target, bytes);
            var sz = 0;
            try { sz = files.size(target); } catch (eS) {}
            this._scriptSize = sz;
            console.log("【自更新】已写入 " + target + " (" + Math.round(sz / 1024) + " KB, 下载 " + Math.round(bytes.length / 1024) + " KB)");
            return { ok: sz > 1000, size: sz, path: target };
        } catch (e) {
            return { ok: false, reason: e.message };
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
     * 请求 PC 中枢用"深度链接"打开大麦商品页
     * (2026-10-09 真机实证: damai://detail + itemId extra → ProjectDetailActivity;
     *  原始分享链接 /shows/item.html 无法路由到 App, 由中枢统一改写并兜底多入口)
     * @returns {{ok:boolean, hit?:string, tried?:string[], error?:string}}
     */
    adbOpenItem: function(itemId) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return { ok: false, error: "中枢离线" };
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/open-item", { itemId: String(itemId) }, { timeout: 30000 });
            if (res && res.statusCode === 200) {
                var body = {};
                try { body = JSON.parse(res.body.string()); } catch (eB) {}
                return { ok: true, hit: body.hit || "", tried: body.tried || [] };
            }
            var msg = "";
            try { msg = JSON.parse(res.body.string()).error || ""; } catch (eM) {}
            return { ok: false, error: msg || ("HTTP " + (res ? res.statusCode : "?")) };
        } catch (e) {
            return { ok: false, error: String(e.message || e) };
        }
    },

    /**
     * 请求 PC 中枢连发点击 (连点链/提交风暴共用; fire-and-forget, 单次 HTTP 摊薄多枚 tap)
     * @param {{x:number,y:number,count?:number,gapMs?:number,jitter?:number,pressMs?:number}} opts
     */
    adbTapBurst: function(opts) {
        if (!this.activeHubUrl) this.detectHub();
        if (!this.activeHubUrl) return false;
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/tap-burst", {
                x: Math.round(opts.x),
                y: Math.round(opts.y),
                count: opts.count || 1,
                gapMs: opts.gapMs || 0,
                jitter: opts.jitter || 0,
                pressMs: opts.pressMs || 0
            }, { timeout: 2500 });
            return !!(res && res.statusCode === 200);
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
