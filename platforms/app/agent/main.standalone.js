/**
 * =====================================================================
 * QG-Agent 移动端全功能免依赖抢购引擎 (AutoJs6 / AutoX 独立全功能单文件版)
 * 生成时间: 2026-10-09T19:09:01.419Z
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
     * 失败原因不再静默: press 通道不成功时立即降级 click 通道, 仍失败则明确告警
     * @returns {boolean}
     */
    fire: function() {
        if (this.cachedPoint && this.cachedPoint.x > 0 && this.cachedPoint.y > 0) {
            var jx = this.cachedPoint.x + Math.floor((Math.random() - 0.5) * 10);
            var jy = this.cachedPoint.y + Math.floor((Math.random() - 0.5) * 8);
            console.log("【击发出膛】注入物理坐标: (" + jx + ", " + jy + ")");
            try {
                if (typeof press === "function") {
                    var okP = press(jx, jy, 30);
                    // 严格判断: 只有明确返回 false 才视为未注入并降级; true/undefined 均按"已注入"处理
                    // (不确定返回语义时绝不重复点击 — 防双击 bug 回归)
                    if (okP !== false) return okP;
                    console.warn("【击发警告】press 通道明确未注入 (false), 立即降级 click 通道");
                }
            } catch (eP) {
                console.warn("【击发警告】press 注入异常: " + (eP ? (eP.message || eP) : "未知") + ", 降级 click 通道");
            }
            try {
                if (typeof click === "function") {
                    return click(jx, jy);
                }
            } catch (eC) {
                console.error("【击发失败】触摸注入失败: " + (eC ? (eC.message || eC) : "未知") + " — 需要人工接管!");
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
        // 局域网地址：由 hub.conf（PC 部署时写入）追加在后面（2026-10-09: 修掉"局域网被插到队首、
        // 结果插着数据线也永远走 WiFi"的问题 —— 现在按"有线优先, 没有才 WiFi"）
    ],
    USB_URL: "http://127.0.0.1:3120",
    USB_PROBE_TIMEOUT_MS: 1200,      // 探测超时短一点: 没插线就立刻回落, 不拖慢启动
    USB_PROBE_CACHE_MS: 15000,       // 探测结果缓存 15s, 避免频繁探测
    activeHubUrl: null,
    deviceId: null,
    hubChannel: null,            // 中枢自报的当前通道 (心跳/握手回带): {mode,usb,wifi,caps}
    heartbeatTimer: null,
    isPolling: false,
    consecutiveHeartbeatFailures: 0,
    taskState: "idle",
    currentTaskId: null,
    cancelRequestedTaskId: null, // 中枢请求取消的任务 (经心跳响应回带; 任务执行期间唯一可靠的下行通道)
    stopRequested: false,        // 中枢请求停止整个脚本 (由 runner 的 1s 控制 tick 消费)
    updateRequested: false,      // 中枢请求自更新脚本 (由 runner 的 1s 控制 tick 消费)

    /**
     * 统一通道判定 (2026-10-09)。
     *   问题: 手机只用 WiFi 连中枢时, adbTap / armTap / diagSnapshot 仍会照发 —— 每个请求白等
     *         一次超时 (首击重试 3 发 ≈ 2.4s 全浪费在等一个注定 503 的请求上)。
     *   口径: **USB(ADB) 优先 → 无 USB 时立刻转本地能力**, 不等超时。
     *   判据: 走的就是 USB 反向隧道 → 必有 adb; 否则看中枢心跳自报的 channel.usb。
     */
    remoteUsb: function() {
        if (this.activeHubUrl === this.USB_URL) return true;
        // 正在走局域网地址 = 手机必然不在 USB 反向隧道上 → 中枢的 ADB 注入轮不到这台手机, 立即转本地能力
        if (this.activeHubUrl) return false;
        if (this.hubChannel && typeof this.hubChannel.usb === "boolean") return this.hubChannel.usb;
        return true;   // 未知: 先按"有"试一次 (失败会立刻回落, 不会长期误判)
    },

    /** 当前通道名 (日志/上报用) */
    channelName: function() {
        if (this.activeHubUrl === this.USB_URL) return "usb";
        if (this.hubChannel && this.hubChannel.mode) return this.hubChannel.mode;
        return this.activeHubUrl ? "wifi" : "none";
    },

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

    /** Shizuku 状态快照 (上报中枢: 控制台据此显示"手机自主点击"能力; 详见 docs.autojs6.com/#/shizuku) */
    shizukuState: function () {
        try {
            if (typeof shizuku === "undefined") return "none";
            var st = shizuku.state;
            if (st && typeof st.isOperational === "boolean") return st.isOperational ? "active" : "inactive";
        } catch (e) {}
        return "unknown";
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
            var runtimeVer = "unknown";
            try {
                if (typeof app !== "undefined" && app.autojs && (app.autojs.versionName || app.autojs.version)) {
                    runtimeVer = String(app.autojs.versionName || app.autojs.version);
                }
            } catch (eV) {}
            var payload = {
                deviceId: this.deviceId,
                agentVersion: "1.2.0",   // 1.2.0: 修复 unknown_mode 上报/发件箱/统一锚点默认; 1.1.0 起支持 phone_op (中枢版本闸门 ≥1.1.0)
                autoX: runtimeVer,       // 实际运行时版本 (此前写死 7.2.4 是错误信息)
                screen: [sw, sh],
                accessibility: isAcc,
                battery: bat,
                shizuku: this.shizukuState(),   // 手机自主点击能力 (本地 input 注入, 免 PC)
                bootAt: java.lang.System.currentTimeMillis()
            };
            var res = http.postJson(this.activeHubUrl + "/api/device/hello", payload, { timeout: 4000 });
            if (res && res.statusCode === 200) {
                console.log("【握手成功】设备已在 Hub 登记: " + this.activeHubUrl);
                try { toast("⚡ 设备已成功连入电脑控制台！"); } catch(eT) {}
                this.hasRegistered = true;
                try { var hb = JSON.parse(res.body.string()); if (hb && hb.channel) this.hubChannel = hb.channel; } catch (eH0) {}
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
                shizuku: this.shizukuState(),   // 状态可能变化 (服务被杀/重启失效), 心跳随行
                scriptSize: this.scriptSize(),   // 本脚本体积: 中枢据此判断"手机脚本是否最新"
                ts: java.lang.System.currentTimeMillis()
            };
            var hbT0 = java.lang.System.currentTimeMillis();
            var res = http.postJson(this.activeHubUrl + "/api/device/heartbeat", payload, { timeout: 3000 });
            var ok = res && res.statusCode === 200;
            if (ok && res.body) {
                // 解析响应体: 中枢可能捎带「取消当前任务」指令 (任务执行期间唯一可靠下行通道)
                try {
                    var hbJson = JSON.parse(res.body.string());
                    // ★ 手机↔电脑时钟偏置 (证据用): serverTime - 请求往返中点。与大麦对时 offset 一起构成三源对时证据
                    if (hbJson && Number(hbJson.serverTime)) {
                        this.hubRttMs = java.lang.System.currentTimeMillis() - hbT0;
                        this.hubOffsetMs = Number(hbJson.serverTime) - (hbT0 + Math.floor(this.hubRttMs / 2));
                    }
                    if (hbJson && hbJson.channel) this.hubChannel = hbJson.channel;   // ★ 通道自报: 决定 ADB 类操作走中枢还是走本地
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
                        // USB 推送后的自重启 (2026-10-10: Agent 自己换引擎, 中枢绝不 force-stop 应用 → 不碰无障碍)
                        if (ctl.restartAgent && !this.restartRequested) {
                            this.restartRequested = true;
                            console.warn("【自重启】收到中枢「重启引擎」请求, 下次 tick 执行");
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
        // WiFi 通道: 中枢没有 ADB —— 直接判失败转本地手势, 不让首击的 3 发重试白等 ~2.4s
        if (!this.remoteUsb()) return false;
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
        if (!this.remoteUsb()) return { ok: false, reason: "WiFi 通道不支持中枢预置击发 (走本地击发)" };
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
        if (!this.remoteUsb()) return null;   // WiFi 下压根没预置过, 不必往返
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
        if (!this.remoteUsb()) return null;   // uiautomator dump / screencap 只能走 ADB
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

    /** 文件字节数 (java.io.File 直取 —— 实测 AutoJs6 无 files.size API, 调用会抛异常被吞成 0) */
    fileSizeBytes: function(p) {
        try { return Number(new java.io.File(String(p)).length()); } catch (e) { return 0; }
    },

    /** 本脚本文件路径 (自更新写入目标)。
     *  ★ 优先规范部署路径 /sdcard/qg-agent/main.js —— 中枢推送/自更新都写这里;
     *    实测踩坑: 经编辑器/某些方式启动的引擎, myEngine().source 可能指向过期副本,
     *    导致"换引擎加载的还是旧代码"+"scriptSize 对账永远失败"。 */
    myScriptPath: function() {
        var canonical = "/sdcard/qg-agent/main.js";
        try { if (files.exists(canonical) && this.fileSizeBytes(canonical) > 1000) return canonical; } catch (eC) {}
        try {
            var src = engines.myEngine().source;
            if (src && String(src).slice(-3) === ".js" && files.exists(String(src))) return String(src);
        } catch (e1) {}
        return canonical;
    },

    /** 本脚本体积 (字节; 上报给中枢做"是否最新"对账)。失败不缓存 —— 0 缓存会让"更新脚本对账"永远失败 */
    scriptSize: function() {
        if (this._scriptSize > 0) return this._scriptSize;
        var s = this.fileSizeBytes(this.myScriptPath());
        if (s > 0) this._scriptSize = s;
        return s;
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
            var sz = this.fileSizeBytes(target);
            this._scriptSize = sz > 0 ? sz : 0;
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
        if (!this.remoteUsb()) return false;   // WiFi: 中枢无法注入 swipe
        try {
            var res = http.postJson(this.activeHubUrl + "/api/adb/swipe", { x1: x1, y1: y1, x2: x2, y2: y2, ms: ms || 300 }, { timeout: 3000 });
            return res && res.statusCode === 200;
        } catch (e) {
            return false;
        }
    },

    /**
     * 等商品详情页落地 (本地打开 deep-link 后用)
     */
    waitForDetail: function(timeoutMs) {
        var t0 = Date.now();
        while (Date.now() - t0 < (timeoutMs || 6000)) {
            try {
                var act = String(currentActivity() || "");
                if (act.indexOf("ProjectDetail") >= 0) { sleep(400); return true; }
            } catch (eA) {}
            sleep(150);
        }
        return false;
    },

    /**
     * 本地 deep-link 打开大麦商品页 (2026-10-09 新增: WiFi 通道 = 无 ADB 时打开商品页的唯一办法)
     * 变体顺序与中枢 ADB 版本一致, 逐个试到 ProjectDetailActivity 落地为止。
     * @returns {{ok:boolean, hit?:string, tried?:string[], error?:string, via:string}}
     */
    openItemLocal: function(itemId) {
        var id = String(itemId || "").trim();
        if (!/^\d{6,}$/.test(id)) return { ok: false, error: "itemId 必须为纯数字", via: "local" };
        var variants = [
            { name: "damai://detail", action: "android.intent.action.VIEW", data: "damai://detail", extraKey: "itemId" },
            { name: "damai://trade/detail", action: "android.intent.action.VIEW", data: "damai://trade/detail", extraKey: "itemId" },
            { name: "damai://projectdetail", action: "android.intent.action.VIEW", data: "damai://projectdetail", extraKey: "itemId" },
            { name: "web-item", action: "android.intent.action.VIEW", data: "https://m.damai.cn/damai/perform/item.html?itemId=" + id, extraKey: null },
            { name: "PRO_DETAIL", action: "cn.damai.intent.action.PRO_DETAIL", data: null, extraKey: "itemId" }
        ];
        var tried = [];
        for (var i = 0; i < variants.length; i++) {
            var v = variants[i];
            tried.push(v.name);
            try {
                var opt = { packageName: "cn.damai", action: v.action, flags: ["activity_new_task"] };
                if (v.data) opt.data = v.data;
                if (v.extraKey) { opt.extras = {}; opt.extras[v.extraKey] = id; }
                app.startActivity(opt);
            } catch (eS) {
                console.log("【本地打开】" + v.name + " 拉起异常: " + (eS ? (eS.message || eS) : "?"));
                continue;
            }
            if (this.waitForDetail(6000)) return { ok: true, hit: v.name, tried: tried, via: "local" };
        }
        return { ok: false, error: "本地 deep-link 均未落到详情页", tried: tried, via: "local" };
    },

    /**
     * 打开大麦商品页 —— **统一通道入口**:
     *   USB(中枢有 ADB) → 请求中枢 am start (已验证的强通道)
     *   WiFi(无 ADB)     → 手机本地 app.startActivity (等价 deep-link, 免数据线)
     * 调用方 (grabLocate / 自动刷新 / phone_op) 无需关心走哪条。
     * @returns {{ok:boolean, hit?:string, tried?:string[], error?:string, via:string}}
     */
    openItem: function(itemId) {
        if (!this.activeHubUrl) this.detectHub();
        if (this.activeHubUrl && this.remoteUsb()) {
            var r = this.adbOpenItem(itemId);
            if (r && r.ok) return { ok: true, hit: r.hit || "", tried: r.tried || [], via: "usb" };
            console.warn("【就位】中枢 ADB 通道失败 (" + ((r && r.error) || "无回应") + ") → 转手机本地 deep-link");
        }
        return this.openItemLocal(itemId);
    },

    /**
     * 请求 PC 中枢用"深度链接"打开大麦商品页 (ADB 专用; 仅 USB 通道调用)
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
        if (!this.remoteUsb()) return false;   // WiFi: 中枢无法注入连发 tap
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
     * 上报任务结果 (带回执确认 + 本地发件箱兜底)
     * 中枢临时不可达时结果进发件箱, 由 runner 心跳 tick 冲刷 —— 控制台不会因一次网络抖动永远"执行中"。
     */
    sendResult: function(resultData) {
        if (!this.activeHubUrl) this.detectHub();
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
        if (!this.activeHubUrl) {
            this.enqueueOutbox(payload);
            return false;
        }
        try {
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
            console.error("【结果上报失败】" + e.message);
        }
        this.enqueueOutbox(payload);
        return false;
    },

    /** 结果发件箱 (最多 20 条, 满了丢最旧 —— 兜网络抖动, 不做持久化) */
    enqueueOutbox: function(payload) {
        if (!this._outbox) this._outbox = [];
        this._outbox.push(payload);
        if (this._outbox.length > 20) this._outbox.shift();
        console.warn("【结果发件箱】中枢暂不可达, 结果已入队 (共 " + this._outbox.length + " 条), 心跳时自动重发");
    },

    /** 冲刷发件箱 (runner 心跳 tick 调用) */
    flushOutbox: function() {
        if (!this._outbox || !this._outbox.length || !this.activeHubUrl) return;
        var rest = [];
        for (var i = 0; i < this._outbox.length; i++) {
            var sent = false;
            try {
                var res = http.postJson(this.activeHubUrl + "/api/device/result", this._outbox[i], { timeout: 4000 });
                sent = !!(res && res.statusCode === 200);
                if (res && res.body) { try { res.body.close(); } catch (e) {} }
            } catch (e) { sent = false; }
            if (!sent) rest.push(this._outbox[i]);
        }
        if (rest.length < this._outbox.length) {
            console.log("【结果发件箱】已补发 " + (this._outbox.length - rest.length) + " 条结果");
        }
        this._outbox = rest;
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
     * 是否收到针对该任务的手动终止指令 (指令经心跳回带, 见 transport.js)
     */
    _isCancelled: function(task) {
        return !!(typeof Transport !== "undefined" && Transport.cancelRequestedTaskId &&
                  Transport.cancelRequestedTaskId === task.taskId);
    },

    /**
     * 运行监控循环
     * @param {object} task 任务对象
     * @param {function} onStatusChange 状态变化回调
     */
    runLoop: function(task, onStatusChange) {
        console.log("【余票盯梢启动】开始监控大麦目标演出票务状态...");
        this.lastStatus = "unknown";   // ★ 每次任务重置: 实例级状态跨任务残留会吞掉首轮本应上报的跃迁
        var intervalMs = 15000; // 默认 15 秒低频轮询

        while (true) {
            if (this._isCancelled(task)) {
                console.log("【余票盯梢终止】收到手动终止指令, 退出监控循环");
                break;
            }

            var currentStatus = this.checkTicketStatus();
            console.log("【余票探测】当前状态: " + currentStatus);

            if (currentStatus !== this.lastStatus) {
                console.log("【状态跃迁】状态由 [" + this.lastStatus + "] 变为 [" + currentStatus + "]");
                this.lastStatus = currentStatus;
                if (typeof onStatusChange === "function") {
                    onStatusChange(currentStatus);
                }
            }

            // 遵守频率纪律，休眠; 分片 1 秒一片, 便于终止指令最快 1 秒内生效
            for (var s = 0; s < Math.ceil(intervalMs / 1000); s++) {
                if (this._isCancelled(task)) break;
                sleep(1000);
            }
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
 * - 返回 true=手势已注入; false=通道异常未注入 (异常不再静默, 打日志便于排查)
 */
function humanPress(cx, cy) {
    if (!(cx > 0 && cy > 0)) return false;
    var jx = Math.round(gaussianRandom(cx, 3.0));
    var jy = Math.round(gaussianRandom(cy, 2.6));
    var dwellTime = Math.round(gaussianRandom(45, 6));
    if (dwellTime < 32) dwellTime = 32;
    if (dwellTime > 58) dwellTime = 58;
    try {
        if (typeof press === "function") {
            var r1 = press(jx, jy, dwellTime);
            return r1 !== false; // 只有明确 false 才算未注入 (undefined/true 均按已注入)
        }
        console.warn("[手势] press 函数不存在, 尝试 click 通道");
    } catch (eP) {
        console.warn("[手势] press 注入失败: " + (eP ? (eP.message || eP) : "未知异常"));
    }
    try {
        if (typeof click === "function") {
            var r2 = click(jx, jy);
            return r2 !== false;
        }
    } catch (eC) {
        console.warn("[手势] click 注入失败: " + (eC ? (eC.message || eC) : "未知异常"));
    }
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
        if (typeof press === "function") {
            var r3 = press(jx, jy, 30);
            return r3 !== false;
        }
    } catch (eP) {
        console.warn("[手势] fastPress 注入失败: " + (eP ? (eP.message || eP) : "未知异常"));
    }
    try {
        if (typeof click === "function") {
            var r4 = click(jx, jy);
            return r4 !== false;
        }
    } catch (eC) {
        console.warn("[手势] fastPress click 注入失败: " + (eC ? (eC.message || eC) : "未知异常"));
    }
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
 * 查找控件但「立即返回」: 命中即给节点, 没有就立刻 null (不等待)。
 * 用于'先秒查一次, 没有再短超时兜底'的高频路径, 替代动辄 150~800ms 的 findOne(超时)。
 */
function quickFind(selector) {
    try { return selector.findOnce(); } catch (eQF) { return null; }
}

/**
 * 轮询等待助手: 条件命中立即返回 true (替代"死等固定时长"的核心提速手段)。
 * 超时上限保持原耐心预算 —— 页面慢时该等还是等, 只是不再浪费"命中后仍死等"的时间。
 * 每轮顺带检查手动终止标记 (被终止时提前返回 false, 由外层复核)。
 */
function waitUntil(cond, timeoutMs, pollMs, tid) {
    var t0 = now();
    var step = pollMs || 150;
    while (now() - t0 < timeoutMs) {
        if (isCancelled(tid)) return false;
        try { if (cond()) return true; } catch (eW) {}
        sleep(step);
    }
    return false;
}

/** 是否收到针对该任务的手动终止指令 (取消指令经心跳响应回带, 见 transport.js) */
function isCancelled(tid) {
    if (!tid) return false;
    return !!(typeof Transport !== "undefined" && Transport.cancelRequestedTaskId &&
              Transport.cancelRequestedTaskId === tid);
}

/**
 * 关键点击: PC-ADB 注入优先, 手机端手势兜底。
 * 2026-10-09 真机对照实证 (vivo V2405A + 大麦):
 *   大麦「立即预订/购买」等底栏主按钮为自绘控件 —— 手机端无障碍手势 (dispatchGesture)
 *   注入无任何效果 (press 返回 true 但界面零变化), 而同点位 PC-ADB (input tap) 注入
 *   立即生效 (实测: 打开了选票面板 NcovSkuActivity)。普通文字控件 (卡片/标签) 手势正常。
 *   故关键点击统一"ADB 优先" —— 又快 (省掉手势+等待的 1~2s) 又可靠;
 *   中枢离线时自动回退手机端手势 (普通控件仍可用)。
 * 通道顺序:
 *   ① PC-ADB 注入 (需中枢在线)
 *   ② 手机端无障碍手势 (中枢离线时的唯一通道)
 *   ③ ADB 补点一次 (偶发丢点)
 * 失败原因分三类上报, 不再含糊。
 * @param {function} verify 点击后的效果校验 (返回 true 表示生效)
 * @param {string} label 日志标签
 */
function criticalTap(cx, cy, verify, label, tid) {
    var tag = tid || "damai";
    var name = label || "点击";
    // 通道 1 (优先): PC-ADB 注入 —— 对自绘按钮唯一有效的通道
    var adbAvailable = Transport.adbTap(cx, cy);
    if (adbAvailable) {
        sleep(450);
        if (!verify || verify()) return true;
        sendLog(tag, "[点击] " + name + " ADB 注入后页面未变化, 尝试手机端手势通道 (" + cx + "," + cy + ")");
    } else {
        sendLog(tag, "[点击] " + name + " ADB 通道不可用 (中枢离线 / 当前为 WiFi 通道), 使用手机端手势通道 (" + cx + "," + cy + ")");
    }
    // 通道 2 (兜底): 手机端无障碍手势
    var injected = humanPress(cx, cy);
    if (injected) {
        sleep(450);
        if (verify && verify()) return true;
        sendLog(tag, "[点击] " + name + " 手势已注入但页面未变化 (疑似自绘控件拒绝手势)");
    } else {
        sendLog(tag, "[点击] " + name + " 手势未注入成功 (无障碍通道异常)");
    }
    // 通道 3: ADB 再补一枪 (偶发丢点; 仅当 ADB 通道此前可用)
    if (adbAvailable) {
        Transport.adbTap(cx, cy);
        sleep(500);
    }
    var finalOk = !verify || verify();
    if (!finalOk) {
        sendLog(tag, "[点击] ✘ " + name + " 双通道均未生效 (当前页面: " + (typeof currentActivity === "function" ? currentActivity() : "?") + ")");
    }
    return finalOk;
}

/* ================================================================
 * grab (链接抢购) 模块级工具 —— 2026-10-09 重写
 * ================================================================ */

/** 整数抖动 */
function jitterInt(base, amp) {
    return Math.round(base + (Math.random() * 2 - 1) * amp);
}

/** 当前 Activity 名 (安全版) */
function safeActivity() {
    try { return String(currentActivity() || ""); } catch (e) { return ""; }
}

/** 只读检查: 目标节点中心 (命中即返回, 零等待) */
function quickCenter(selector) {
    var n = quickFind(selector);
    if (n && n.bounds) {
        try {
            var b = n.bounds();
            return { x: Math.floor(b.centerX()), y: Math.floor(b.centerY()) };
        } catch (e) {}
    }
    return null;
}

/**
 * 读「开售可击发」信号 —— 突变检测的唯一判据（2026-10-09 17:17 实战失败后重做）。
 * 失败根因（预约态 dump 与开售后 dump 的差集实证）:
 *   底栏按钮是**自绘控件**, 无障碍树里只有一个静态占位容器
 *   (trade_project_detail_purchase_status_bar_container_fl), 开售前后它的
 *   childCount/text/desc/clickable/中心**完全不变**;
 *   tv_left_main_text / btn_buy / btn_buy_view 在详情页**根本不存在**。
 *   → 老信号(容器五属性 + 那三个 id)在两态下字符串一模一样, **永远不可能触发**。
 * 真正会变的是**页面结构**: 预约态的一整套「预约组件」在开售那一刻集体消失 ——
 *   6 个候选(全部经真机 dump 实证为"预约态独有"):
 *   id_new_project_normal_count_down_layout 倒计时整块 / id_project_count_sell_time 开抢时间文本 /
 *   id_project_ticket_remind_me 预约提醒 / id_project_count_down_remind_layout 提醒条 /
 *   id_project_count_down_layout 倒计时内层 / id_project_count_down_bg 倒计时背景
 *   (注: tour_city_select_bg / tour_city_name 虽在预约态出现, 但实测**开售后仍存在**, 故不作候选)
 * ⚠️ 干扰项: id_new_project_grab_tip_text 装的是"大麦全速护航中…"这类**滚动词条**,
 *   「预售 | 本商品为预售…」也是滚动提示 —— 绝不作为信号。
 * 出手判定见 signalChangedFrom(): 预约结构成片消失 = 开售。
 */
function readButtonSignal() {
    // ① 预约结构（开售那一刻集体消失）—— 主信号。候选放宽到 6 个, 只为"一定要识别到"：
    //    全部来自真机 dump 实证的"预约态独有"节点, 开售时成片消失。
    var pCd = 0, pSell = 0, pRemind = 0, pRemind2 = 0, pCd2 = 0, pTour = 0;
    var sellText = "-";
    try { pCd = id("cn.damai:id/id_new_project_normal_count_down_layout").findOnce() ? 1 : 0; } catch (eL1) {}
    try {
        var sn = id("cn.damai:id/id_project_count_sell_time").findOnce();
        if (sn) { pSell = 1; if (sn.text) sellText = String(sn.text()).slice(0, 20); }
    } catch (eL2) {}
    try { pRemind = id("cn.damai:id/id_project_ticket_remind_me").findOnce() ? 1 : 0; } catch (eL3) {}
    try { pRemind2 = id("cn.damai:id/id_project_count_down_remind_layout").findOnce() ? 1 : 0; } catch (eL4) {}
    try { pCd2 = id("cn.damai:id/id_project_count_down_layout").findOnce() ? 1 : 0; } catch (eL5) {}
    try { pTour = id("cn.damai:id/id_project_count_down_bg").findOnce() ? 1 : 0; } catch (eL6) {}   // 倒计时背景
    // 原 6 号候选 tour_city_select_bg 已剔除: 实测**开售后仍然存在**(非预约独有), 留着会误导。
    var presaleFlags = [pCd, pSell, pRemind, pRemind2, pCd2, pTour];

    // ② 底栏自绘容器（占位视图：只作日志与兜底，不是主信号）
    var tvText = "-";
    var tv = null;
    try { tv = id("cn.damai:id/tv_left_main_text").findOnce(); } catch (e1) {}
    if (tv && tv.text) { try { tvText = String(tv.text()); } catch (e2) {} }

    var hasContainer = false;
    var center = null;
    var cAttrs = "-";
    var c = null;
    try { c = id("cn.damai:id/trade_project_detail_purchase_status_bar_container_fl").findOnce(); } catch (e3) {}
    if (c) {
        hasContainer = true;
        var cc = 0, ct = "", cd = "", ck = false;
        try { cc = c.childCount ? c.childCount() : 0; } catch (e4) {}
        try { ct = c.text ? String(c.text()) : ""; } catch (e5) {}
        try { cd = c.contentDescription ? String(c.contentDescription()) : ""; } catch (e6) {}
        try { ck = c.clickable ? !!c.clickable() : false; } catch (e7) {}
        if (c.bounds) {
            try {
                var b = c.bounds();
                center = { x: Math.floor(b.centerX()), y: Math.floor(b.centerY()) };
            } catch (e8) {}
        }
        cAttrs = cc + ":" + ct + ":" + cd + ":" + (ck ? 1 : 0) + ":" + (center ? (center.x + "x" + center.y) : "-");
    }

    var buy = 0, buv = 0;
    try { buy = id("cn.damai:id/btn_buy").findOnce() ? 1 : 0; } catch (e9) {}
    try { buv = id("cn.damai:id/btn_buy_view").findOnce() ? 1 : 0; } catch (e10) {}

    return {
        sig: "presale=" + presaleFlags.join("") + "|sell=" + sellText +
             "|tv=" + tvText + "|c=" + cAttrs + "|buy=" + buy + "|buv=" + buv,
        presale: presaleFlags,
        hasContainer: hasContainer,
        cAttrs: cAttrs,
        center: center,
        tvText: tvText,
        buy: buy,
        buv: buv,
        sellText: sellText,
        cdOn: pCd,
        sellOn: pSell,
        remindOn: pRemind
    };
}

/**
 * 是否该出手。base = 锚定时刻的**信号快照对象**（不是字符串）。
 *   ① 预约结构成片消失（6 个候选里 ≥2 项 从有到无）= 开售的结构标志
 *   ② 底栏容器属性变化（兜底，别的页面变体可能靠它）
 *   ③ 无容器时：tv / btn_buy / btn_buy_view 出现
 * 若锚定时就没有预约结构（页面本就是开售态），①不成立，只能靠兜底（锚定阶段会打告警）。
 */
function signalChangedFrom(s, base) {
    if (!base) return false;
    var a = base.presale || [], b = s.presale || [];
    var baseCount = 0, gone = 0;
    for (var i = 0; i < a.length; i++) {
        if (a[i]) baseCount++;
        if (a[i] && !b[i]) gone++;
    }
    // 结构信号只在"页面确实还读到"(底栏容器在)时才算数 —— 否则整页读失败会伪装成"开售"
    if (s.hasContainer && gone >= 2) return true;
    if (s.hasContainer && baseCount === 1 && gone === 1) return true;
    if (s.hasContainer && base.cAttrs && base.cAttrs !== "-" && s.cAttrs !== base.cAttrs) return true;
    if (!s.hasContainer && (s.tvText !== "-" || s.buy || s.buv)) return true;
    return false;
}

/* ===== 本地注入通道 (2026-10-10 新增): 手机自主点击, 不依赖电脑 =====
 * 成熟方案 = AutoJs6 内置 shizuku 全局函数 (官方文档 docs.autojs6.com/#/shizuku, 6.4.0+):
 *   设备装 Shizuku App 并启动服务 (安卓 11+ 走无线调试配对, 免 PC) + AutoJs6 抽屉开启 Shizuku 开关,
 *   之后 shizuku('input tap x y') 以 ADB 特权**本地**注入 —— 与 PC-ADB input tap 完全同级,
 *   对大麦自绘控件同样有效 (无障碍手势点不动的按钮它能点动), 且断开电脑照常工作。
 * 已知限制: 手机重启后 Shizuku 服务失效, 需重新激活 (无线调试端口会变)。
 * 状态探测: shizuku.state.isOperational (6.7.0+); 旧版本回退试跑 echo; 失败自动降级手势。 */
var LocalInjector = {
    _probedAt: 0,
    _ok: false,
    /** 是否可用 (结果缓存 5s, 失败立即重探) */
    available: function () {
        var t = now();
        if (this._probedAt && (t - this._probedAt) < 5000) return this._ok;
        this._probedAt = t;
        this._ok = false;
        try {
            if (typeof shizuku === "undefined") return false;
            var st = (shizuku.state && typeof shizuku.state === "object") ? shizuku.state : null;
            if (st && typeof st.isOperational === "boolean") {
                this._ok = !!st.isOperational;
            } else {
                var r = shizuku("echo ok");          // 旧版本无 state: 试跑一条验证
                this._ok = !!(r && (r.code === undefined || r.code === 0));
            }
        } catch (eS) { this._ok = false; }
        if (this._ok) console.log("[本地注入] Shizuku 通道可用 (手机自主点击, 免 PC)");
        return this._ok;
    },
    /** 本地 input 注入一次点击; pressMs>=30 用同点 swipe 模拟按压时长 */
    tap: function (x, y, pressMs) {
        try {
            var r = (pressMs && pressMs >= 30)
                ? shizuku("input swipe " + x + " " + y + " " + x + " " + y + " " + Math.min(300, pressMs))
                : shizuku("input tap " + x + " " + y);
            var okr = !!(r && (r.code === undefined || r.code === 0));
            if (!okr) this._probedAt = 0;            // 失败立刻重探
            return okr;
        } catch (eT) { this._probedAt = 0; return false; }
    }
};

/** ADB 优先按击 (自绘控件只认 input 注入); 通道链:
 *  ① PC-ADB (USB, 最快) → ② 本地 Shizuku 注入 (免 PC, 同级能力) → ③ 手机无障碍手势 (最后兜底)。
 *  pressMs>=30 时用"同点按压"模拟人类按压时长 */
function adbPress(x, y, pressMs) {
    if (pressMs && pressMs >= 30) {
        // 抖动统一由调用方 (humanTap) 施加, 这里不再叠加, 否则 jitterPx 参数会失真
        if (Transport.adbTapBurst({ x: x, y: y, count: 1, pressMs: pressMs, jitter: 0 })) return true;
    } else if (Transport.adbTap(x, y)) {
        return true;
    }
    // ② 本地 Shizuku 注入 (WiFi/无 USB 时的"自主点击"通道; 与 PC-ADB 同级, 自绘按钮有效)
    if (LocalInjector.available() && LocalInjector.tap(x, y, pressMs)) return true;
    // ③ 无障碍手势兜底 (自绘控件可能无效 —— 只告警一次, 不静默, 也不假装成功)
    var local = false;
    try {
        if (pressMs && pressMs >= 30 && typeof press === "function") local = press(x, y, pressMs) !== false;
        else if (typeof press === "function") local = press(x, y, 30) !== false;
        else if (typeof click === "function") local = click(x, y) !== false;
    } catch (eLp) { local = false; }
    if (!local) local = fastPress(x, y);
    if (!adbPress._wifiWarned && typeof Transport !== "undefined" && Transport.remoteUsb && !Transport.remoteUsb()) {
        adbPress._wifiWarned = true;
        console.warn("[通道] 已退到无障碍手势 (自绘按钮可能无效; 建议启用 Shizuku 或插数据线)");
    }
    return local;
}

/* ===== 抢购点击参数 (控制台可下发; 未下发用默认) =====
 * 2026-10-09 用户口径: ① 首击只求"快且有效", 且**绝不盲点** ② 后续连点必须有抖动, 1 秒不超过 20 下
 * 前台只填"最少/最多 几下每秒", 间隔与按压由 deriveCadence() 反解 (见下)。 */
var CLICK_CFG = {
    rateMin: 8, rateMax: 12,          // 连点节拍 (击/秒), 硬上限 20
    rttMs: 40,                        // 手机↔电脑实测往返 (通道预检实测; 缺省 40)
    gapMinMs: 55, gapMaxMs: 85,       // 连点间隔抖动区间 (ms) —— 由 deriveCadence 反解
    pressMinMs: 38, pressMaxMs: 56,   // 按压时长抖动区间 (ms) —— 由 deriveCadence 反解
    jitterPx: 3,                      // 落点抖动 (px) —— 兼容旧字段: 未分轴时两轴都用它
    jitterXPx: 3,                     // 落点抖动 X 轴 (px)
    jitterYPx: 3,                     // 落点抖动 Y 轴 (px)
    chainMs: 12000,                   // 抖动连点链总时长 (ms)
    rehearsalMs: 4000,                // 彩排连点时长 (ms)
    watchHardCapMs: 60000,            // 盯梢兜底闸门 (ms, 1 分钟; 用户 2026-10-09 拍板): 只为防任务永久挂住, 不是"观察窗"
    autoRefresh: false,               // 【默认关】开售前自动刷新页面 (T-30s / T-12s 各一次), 解决"页面状态陈旧"
    firstTapTries: 3,                 // 首击最多发几发
    firstTapTimeoutMs: 700            // 首击单发超时 (ms)
};

/* ===== 统一锚点与「继续尝试」弹窗按钮 (2026-10-10 三截图实测标定, 标定分辨率 1080×2400) =====
 * 来源: 图2(SKU抽屉·确定) / 图3(确认页·立即提交) 程序化测边:
 *   确定     x[668,1015] y[2244,2375] 中心(841,2309)  348×131
 *   立即提交  x[628,1015] y[2245,2375] 中心(821,2310)  388×130
 *   立即预订  (无截图; 旧标定点 682,2305 落在同一区域, 右缘对齐 1015, 按三键交集处理)
 * 统一锚点 = 三键交集 x[668,1015]∩y[2250,2370] 的中心 → (841,2310)。
 * 「继续尝试」弹窗按钮 (图4 来自另一台设备, 只能跨设备推算, 取两条路径的**交集**保证落点):
 *   路径A 按提交键宽比例换算 → 中心 y≈1346, 按钮 y[1284,1408]
 *   路径B 弹窗垂直居中(图4实测 712≈718✓) + 同宽高比换算 → 中心 y≈1418, 按钮 y[1355,1480]
 *   两路径交集 y[1361,1402] → 取 y=1382 (再留 ±18 抖动余量); x 两路径都=屏幕中心(弹窗按钮居中) → x=540。
 *   ⚠ 侧车优先点**节点中心**(无跨设备误差), 此坐标仅是节点读不到 bounds 时的兜底。 */
var GRAB_POINTS = {
    calib: { w: 1080, h: 2400 },
    anchor: { x: 841, y: 2310 },       // 统一锚点: 一个点通吃 立即预订/确定/立即提交
    jitterCap: { x: 100, y: 40 },      // 锚点抖动上限 (超过必出按钮; 推荐 X 20~40, Y 8~16)
    popup: { x: 540, y: 1382, jitterX: 80, jitterY: 18, delayMs: 300, pollMs: 60 },
    popupFromSubmit: { dx: -301, dy: -928 }   // 无 popup 配置时: 提交锚点 + 此偏移 推算弹窗按钮
};

/**
 * 弹窗多信号探测 (2026-10-10) —— 三级信号, 全部基于无障碍可读节点:
 *   ① 按钮 text 节点 (最准; 弹窗按钮大概率是原生 TextView, 与底栏自绘主按钮不同类)
 *   ② textContains 宽匹配
 *   ③ 正文关键词节点 ("别放弃"/"抢票人数") —— 按钮自绘但正文可读时, 用正文 x + 推算 y
 * 三层都落空 (整窗自绘) → 本轮不点击, 等下一轮探测 (用户裁决: 移除盲点兜底层)。
 * @param {number} fallbackY 兜底 Y (调用方传入已按本机分辨率换算的推算值; 缺省用标定原值)
 */
function popupProbe(fallbackY) {
    var cand = null;
    try { cand = text("继续尝试").findOnce(); } catch (e1) {}
    if (!cand) { try { cand = textContains("继续尝试").findOnce(); } catch (e2) {} }
    if (cand && cand.bounds) {
        try {
            var b = cand.bounds();
            if (b && b.width() > 40 && b.height() > 12) return { x: b.centerX(), y: b.centerY(), via: "node" };
        } catch (e3) {}
    }
    var body = null;
    try { body = textContains("别放弃").findOnce() || textContains("抢票人数").findOnce(); } catch (e4) {}
    if (body && body.bounds) {
        try {
            var bb = body.bounds();
            var fy = (fallbackY && fallbackY > 0) ? fallbackY : GRAB_POINTS.popup.y;
            if (bb && bb.width() > 40) return { x: bb.centerX(), y: fy, via: "body-text" };
        } catch (e5) {}
    }
    return null;
}

/** 击发间距 (全局): 主链与弹窗侧车共用, 任意两击(不分流)间隔 ≥50ms → 合计 ≤20 击/秒 */
var TAP_SPACING = { lastAt: 0 };
function markTapFired() { TAP_SPACING.lastAt = now(); }
function waitTapSlot(minGapMs) {
    var gap = minGapMs || 50;
    var wait = (TAP_SPACING.lastAt + gap) - now();
    if (wait > 0) sleep(wait);
    markTapFired();
}

/** 连点链旁路控制: 主链热路径只认这个布尔, 识别/看护全在侧车线程 */
var CHAIN_CTL = { stop: false, stopReason: "", sidecarDone: false, popupClicks: 0, lastPopupVia: "" };
function chainReset() { CHAIN_CTL.stop = false; CHAIN_CTL.stopReason = ""; CHAIN_CTL.sidecarDone = false; CHAIN_CTL.popupClicks = 0; CHAIN_CTL.lastPopupVia = ""; }

/**
 * 第三重兜底：页面文案扫描（2026-10-09 加入）
 * ================================================================
 * 为什么需要它: 结构信号盯的是"预约组件集体消失", 万一哪天大麦把结构改了(换 id/改布局),
 *   结构信号会失效; 而"页面文案"是最贴近用户肉眼判断的东西(主流开源脚本也正是盯按钮/文案)。
 * 怎么做到便宜: **一次遍历**取全部 TextView 文本(约 10~40ms), 在 JS 里做字符串匹配,
 *   不是每个关键词查一次(那样 7 次要几百 ms)。因此它**降频跑**(每 ~100ms 一次), 只当兜底。
 * 判据(必须"变化方向"正确, 否则会误报):
 *   · 正向: 开售后才该出现的字样 **从无到有**（立即购买/立即预订/立即抢购/选座购买/缺货登记/已售罄/无票）
 *   · 反向: 预约态才有的字样（"…开抢"）**从有到无**
 *   注意: 「预售 | 本商品为预售…」「大麦全速护航中…」这类**滚动词条已排除**, 不作判据。
 */
var LIVE_POS_TEXTS = [];   // ★ 真机实测(2026-10-09, 开售后页): 立即购买/立即预订/缺货登记 等**一个都读不到**
                           //   —— 它们和按钮一样是画在画布上的。故此处留空: 不再依赖未实证的判据。
var LIVE_NEG_TEXTS = ["开抢"];   // 反方向(有实证): 预约态那行"…开抢"开售后从可读文本里消失
                                 // 注: 它与第一重的 sell 节点是同一条证据, 但**按文字找、不按 id 找** —— 改版换 id 时仍有效

function scanTexts() {
    var joined = "";
    try {
        var list = className("android.widget.TextView").find();
        if (list) {
            var parts = [];
            for (var i = 0; i < list.length; i++) {
                try { var t = list[i].text(); if (t) parts.push(String(t)); } catch (eI) {}
            }
            joined = parts.join(" | ");
        }
    } catch (eF) {}
    var pos = 0, neg = 0;
    for (var p = 0; p < LIVE_POS_TEXTS.length; p++) { if (joined.indexOf(LIVE_POS_TEXTS[p]) >= 0) pos++; }
    for (var n = 0; n < LIVE_NEG_TEXTS.length; n++) { if (joined.indexOf(LIVE_NEG_TEXTS[n]) >= 0) neg++; }
    return { pos: pos, neg: neg, sample: joined.slice(0, 100) };
}

/** 文案是否"朝开售方向"变了 (正向字样出现 / 开抢字样消失) */
function textSignalFired(cur, base) {
    if (!base) return false;
    return (cur.pos > base.pos) || (cur.neg < base.neg);
}

function cfgInt(v, lo, hi, dft) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dft;
    return Math.max(lo, Math.min(hi, n));
}

/**
 * 节拍反解: 由"目标击数/秒"算出间隔与按压 (纯函数, 单测直取)。
 *   单发路径每击墙钟 = max(间隔 + 往返, 按压 + input进程开销)
 *   → press = clamp(min(56, T-30), 6, 56); gap = max(0, T - rtt)   (T = 1000/目标)
 * @returns {{gapMinMs,gapMaxMs,pressMinMs,pressMaxMs,estPerSec,ceilingPerSec}}
 */
function deriveCadence(rateMin, rateMax, rttMs) {
    var OVERHEAD = 30;                       // 设备端 input 进程开销经验值 (ms)
    var rMin = cfgInt(rateMin, 1, 20, 8);
    var rMax = Math.max(rMin, cfgInt(rateMax, 1, 20, 12));
    var rtt = cfgInt(rttMs, 0, 2000, 40);
    var Tmax = 1000 / rMax;                  // 最快时的每击预算
    var Tmin = 1000 / rMin;                  // 最慢时的每击预算
    var pressMax = Math.max(6, Math.min(56, Math.floor(Tmax - OVERHEAD)));
    var pressMin = Math.max(6, pressMax - 18);
    var pAvg = (pressMin + pressMax) / 2;
    var gapMin = Math.max(0, Math.floor(Tmax - rtt));
    var gapMax = Math.max(gapMin, Math.floor(Tmin - rtt));
    var cycle = Math.max(gapMin + rtt, pAvg + OVERHEAD);
    return {
        gapMinMs: gapMin,
        gapMaxMs: gapMax,
        pressMinMs: pressMin,
        pressMaxMs: pressMax,
        estPerSec: Math.max(1, Math.round(1000 / Math.max(1, cycle))),
        ceilingPerSec: Math.floor(1000 / Math.max(1, rtt))
    };
}

/** 用任务里的 grab 参数覆盖默认 (每个任务开始前调一次); rttMs 为实测往返 (可选) */
function applyClickCfg(g, rttMs) {
    if (!g) return;
    if (rttMs && rttMs > 0) CLICK_CFG.rttMs = cfgInt(rttMs, 0, 2000, CLICK_CFG.rttMs);
    CLICK_CFG.jitterXPx = cfgInt(g.jitterXPx !== undefined ? g.jitterXPx : g.jitterPx, 0, 24, CLICK_CFG.jitterXPx);
    CLICK_CFG.jitterYPx = cfgInt(g.jitterYPx !== undefined ? g.jitterYPx : g.jitterPx, 0, 24, CLICK_CFG.jitterYPx);
    CLICK_CFG.jitterPx = Math.max(CLICK_CFG.jitterXPx, CLICK_CFG.jitterYPx);   // 旧字段保持"最大轴"语义
    CLICK_CFG.chainMs = cfgInt(g.chainMs, 3000, 60000, CLICK_CFG.chainMs);
    CLICK_CFG.rehearsalMs = cfgInt(g.rehearsalMs, 1000, 60000, CLICK_CFG.rehearsalMs);
    CLICK_CFG.firstTapTries = cfgInt(g.firstTapTries, 1, 5, CLICK_CFG.firstTapTries);
    CLICK_CFG.firstTapTimeoutMs = cfgInt(g.firstTapTimeoutMs, 200, 3000, CLICK_CFG.firstTapTimeoutMs);
    CLICK_CFG.autoRefresh = !!g.autoRefresh;   // 开售前自动刷新 (默认关)
    // 节拍: 优先用"击数/秒"反解; 未提供才退回旧的 gap/press 显式值 (兼容回滚)
    if (g.rateMin || g.rateMax) {
        var cad = deriveCadence(g.rateMin, g.rateMax, CLICK_CFG.rttMs);
        CLICK_CFG.gapMinMs = cad.gapMinMs;
        CLICK_CFG.gapMaxMs = cad.gapMaxMs;
        CLICK_CFG.pressMinMs = cad.pressMinMs;
        CLICK_CFG.pressMaxMs = cad.pressMaxMs;
    } else {
        CLICK_CFG.gapMinMs = cfgInt(g.gapMinMs, 0, 1000, CLICK_CFG.gapMinMs);
        CLICK_CFG.gapMaxMs = Math.max(CLICK_CFG.gapMinMs, cfgInt(g.gapMaxMs, 0, 2000, CLICK_CFG.gapMaxMs));
        CLICK_CFG.pressMinMs = cfgInt(g.pressMinMs, 0, 300, CLICK_CFG.pressMinMs);
        CLICK_CFG.pressMaxMs = Math.max(CLICK_CFG.pressMinMs, cfgInt(g.pressMaxMs, 0, 400, CLICK_CFG.pressMaxMs));
    }
    // 抖动上限保护 (2026-10-10): 统一锚点的有效抖动空间 = 三按钮交集 (X ±100 / Y ±40), 超界必出按钮
    CLICK_CFG.jitterXPx = Math.min(CLICK_CFG.jitterXPx, GRAB_POINTS.jitterCap.x);
    CLICK_CFG.jitterYPx = Math.min(CLICK_CFG.jitterYPx, GRAB_POINTS.jitterCap.y);
}

/**
 * 「继续尝试」弹窗按钮落点 (2026-10-10):
 *   ① 控制台下发的 grab.popup (标定坐标) 最优先
 *   ② 否则 提交锚点 + 实测偏移 (popupFromSubmit) 推算 —— 用户口径"根据立即提交坐标推算"
 *   ③ 都没有 → 内置标定点 GRAB_POINTS.popup
 * 全部经 scaleToDevice 适配真机分辨率。
 */
function popupPointFor(task) {
    var p = task && task.grab && task.grab.popup;
    if (p && p.x > 0 && p.y > 0) return scaleToDevice({ x: p.x, y: p.y }, task);
    var base = (task && task.grab && task.grab.submit) ? task.grab.submit : GRAB_POINTS.anchor;
    var cand = scaleToDevice({ x: base.x + GRAB_POINTS.popupFromSubmit.dx, y: base.y + GRAB_POINTS.popupFromSubmit.dy }, task);
    if (cand && cand.x > 0 && cand.y > 0) return cand;
    return scaleToDevice({ x: GRAB_POINTS.popup.x, y: GRAB_POINTS.popup.y }, task);
}

/**
 * 连点链侧车线程 (2026-10-10 新增) —— 与主链并行、互不阻塞:
 *   主链热路径 = 纯无脑击发 (零识别); 本线程负责两件"不赶时间"的事:
 *   ① 「继续尝试」弹窗处置: 首次点击 300ms 后开始探测 (text=继续尝试), 命中即点
 *      (优先节点中心, 取不到 bounds 才用推算坐标), 直到弹窗消失。弹窗不在时**一击不发**,
 *      因此不会误碰确认页上的观演人行 —— 这是"两处同时高频、互不影响"的落地方式。
 *   ② 终态看护 (每 ~600ms): 支付页/售罄/滑块/页面漂移 → 置 CHAIN_CTL.stop, 主链下一击前收工。
 *   节拍: 与主链共享 TAP_SPACING (任意两击间隔 ≥50ms, 合计 ≤20 击/秒)。
 */
function startChainSidecar(task, anchor, tid, endAt) {
    var popupPt = popupPointFor(task);
    var lastWatch = 0;
    var viewerTried = 0;
    var lastViewerAt = 0;
    threads.start(function () {
        var startedAt = now();
        try {
            Transport.sendEvent(tid, "sidecar_start", {
                popupPoint: popupPt, delayMs: GRAB_POINTS.popup.delayMs, pollMs: GRAB_POINTS.popup.pollMs,
                shizuku: LocalInjector.available()
            });
        } catch (eE) {}
        while (now() < endAt && !CHAIN_CTL.sidecarDone) {
            if (isCancelled(tid)) break;
            // ① 弹窗处置 (首次点击 300ms 后才开始 —— 弹窗只会在点提交之后出现)
            //    三级信号探测, 全落空则本轮不点 (无盲点层, 2026-10-10 用户裁决)
            if (now() - startedAt >= GRAB_POINTS.popup.delayMs) {
                var hit = null;
                try { hit = popupProbe(popupPt.y); } catch (ePr) {}
                if (hit) {
                    var px = hit.x, py = hit.y, via = hit.via;
                    waitTapSlot(60);   // 与主链错开, 合计 ≤20 击/秒
                    adbPress(jitterInt(px, via === "node" ? 12 : GRAB_POINTS.popup.jitterX),
                             jitterInt(py, via === "node" ? 8 : GRAB_POINTS.popup.jitterY), 42);
                    CHAIN_CTL.popupClicks++;
                    CHAIN_CTL.lastPopupVia = via;
                    if (CHAIN_CTL.popupClicks <= 3 || CHAIN_CTL.popupClicks % 5 === 0) {
                        sendLog(tid, "[弹窗] 继续尝试 第" + CHAIN_CTL.popupClicks + " 击 (" + px + "," + py + " via=" + via + ")");
                        try { Transport.sendEvent(tid, "popup_retry_click", { n: CHAIN_CTL.popupClicks, x: px, y: py, via: via }); } catch (eP) {}
                    }
                }
            }
            // ② 终态看护 (每 ~600ms; 识别不进主链热路径)
            if (now() - lastWatch > 600) {
                lastWatch = now();
                try {
                    if (safeTextMatches(/选择支付方式|微信支付|支付宝|待付款|订单提交成功|支付剩余时间|排队中/).exists()) {
                        CHAIN_CTL.stop = true; CHAIN_CTL.stopReason = "ordered"; break;
                    }
                    var act = safeActivity();
                    var onDetail = act.indexOf("ProjectDetailActivity") >= 0;
                    if (!onDetail && !DamaiAdapter.isInSkuDrawer() && !DamaiAdapter.isInOrderConfirmPage()) {
                        CHAIN_CTL.stop = true; CHAIN_CTL.stopReason = "page_shifted"; break;
                    }
                    if (onDetail && safeTextMatches(/已售罄|无票|缺货登记/).exists()) {
                        CHAIN_CTL.stop = true; CHAIN_CTL.stopReason = "no_stock"; break;
                    }
                    if (id("cn.damai:id/puzzle-captcha-btn-icon").exists()) {
                        CHAIN_CTL.stop = true; CHAIN_CTL.stopReason = "captcha"; break;
                    }
                    // 观演人装配兜底 (平移到侧车; 最多 3 次, 间隔 ≥2.5s —— 兜住盲点误勾观演人的自愈)
                    if (viewerTried < 3 && now() - lastViewerAt > 2500
                        && DamaiAdapter.isInOrderConfirmPage() && safeTextMatches(/请选择.*位观演人|仅需选择.*位/).exists()) {
                        viewerTried++; lastViewerAt = now();
                        sendLog(tid, "[侧车] 检测到需选观演人, 尝试装配 (第 " + viewerTried + " 次)");
                        var vs = [];
                        if (task.target && task.target.viewers && task.target.viewers.length) vs = task.target.viewers;
                        else if (task.target && task.target.viewer) vs = [task.target.viewer];
                        DamaiAdapter.assembleViewers(vs, (task.target && task.target.count) || 1, tid);
                    }
                } catch (eW) {}
            }
            sleep(GRAB_POINTS.popup.pollMs);
        }
        CHAIN_CTL.sidecarDone = true;
    });
}

/** 坐标按标定分辨率换算到本机 (保底坐标才是写死的; 自动锚定取实时容器中心, 与分辨率无关) */
function scaleToDevice(pt, task) {
    if (!pt) return pt;
    var cal = task && task.grab ? task.grab.calibScreen : null;
    if (!cal || !(cal.w > 0) || !(cal.h > 0)) return pt;
    var dw = 0, dh = 0;
    try { dw = device.width || 0; dh = device.height || 0; } catch (eD) { return pt; }
    if (!(dw > 0) || !(dh > 0) || (cal.w === dw && cal.h === dh)) return pt;
    return {
        x: Math.round(pt.x * dw / cal.w),
        y: Math.round(pt.y * dh / cal.h),
        scaledFrom: cal.w + "x" + cal.h + " -> " + dw + "x" + dh
    };
}

/**
 * 拟人单点: 落点抖动 ±jitterPx + 按压时长在 [pressMinMs, pressMaxMs] 内抖动, 只发 1 枚。
 * 节拍由调用方用 humanGapMs() 控制 —— 关键约束: 1 秒内不超过 20 下。
 */
function humanTap(x, y, ampX, ampY) {
    var ax = (ampX === undefined) ? CLICK_CFG.jitterXPx : ampX;
    var ay = (ampY === undefined) ? CLICK_CFG.jitterYPx : ampY;
    var span = CLICK_CFG.pressMaxMs - CLICK_CFG.pressMinMs;
    var press = CLICK_CFG.pressMinMs + (span > 0 ? Math.floor(Math.random() * (span + 1)) : 0);
    return adbPress(jitterInt(x, ax), jitterInt(y, ay), press);
}

/** 连点节拍 (抖动间隔): [gapMinMs, gapMaxMs]; gapMinMs 下限 50ms 即 20 击/秒的硬上限 */
function humanGapMs() {
    var span = CLICK_CFG.gapMaxMs - CLICK_CFG.gapMinMs;
    return CLICK_CFG.gapMinMs + (span > 0 ? Math.floor(Math.random() * (span + 1)) : 0);
}

/**
 * 最近 1 秒窗口内的最大击数 (连点节拍合规证据)
 */
function peakPerSec(stamps) {
    var peak = 0;
    for (var i = 0; i < stamps.length; i++) {
        var c = 0;
        for (var j = i; j < stamps.length && stamps[j] - stamps[i] < 1000; j++) c++;
        if (c > peak) peak = c;
    }
    return peak;
}

var DamaiAdapter = {
    packageName: "cn.damai",

    /** 应用控制台下发的点击参数 (runner 在任务开始时调一次; rttMs = 通道实测往返, 用于节拍反解) */
    applyClickCfg: function(g, rttMs) { applyClickCfg(g, rttMs); },

    /* ================================================================
     * 0. 弹窗与广告自愈 (开屏广告 / 首页弹窗 / 须知 / 权限 / 努力刷新)
     * ================================================================ */
    dismissPopups: function() {
        var handled = false;
        try {
            // 1. 开屏广告 (GKD 真机快照实证 id)
            var adSkip = quickFind(id("cn.damai:id/homepage_advert_pb"));
            if (adSkip) {
                console.log("[弹窗自愈] 关闭开屏广告");
                humanClick(adSkip);
                sleep(300);
                handled = true;
            }
            // 2. 首页弹窗广告
            var popupClose = quickFind(id("cn.damai:id/homepage_popup_window_close_btn"));
            if (popupClose) {
                console.log("[弹窗自愈] 关闭首页弹窗广告");
                humanClick(popupClose);
                sleep(300);
                handled = true;
            }
            // 3. 业务提示/须知弹窗 (确定/我知道了/知道啦/好的)
            var btnNotice = quickFind(id("cn.damai:id/damai_theme_dialog_confirm_btn")) ||
                            quickFind(safeTextMatches(/^(确定|我知道了|知道啦|好的|知道了)$/));
            if (btnNotice) {
                console.log("[弹窗自愈] 确认业务提示弹窗");
                humanClick(btnNotice);
                sleep(300);
                handled = true;
            }
            // 4. 系统权限弹窗
            var btnPerm = quickFind(text("允许")) || quickFind(text("本次使用时允许")) || quickFind(text("始终允许"));
            if (btnPerm) {
                console.log("[弹窗自愈] 允许系统权限请求");
                humanClick(btnPerm);
                sleep(250);
                handled = true;
            }
            // 5. 加载失败「努力刷新」
            var refresh = quickFind(safeTextMatches(/努力刷新/));
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

        // 等待回到前台 (最多 8s, 命中即走)
        var self = this;
        var backFront = waitUntil(function() { return self.isDamaiForeground(); }, 8000, 300, tid);
        if (backFront) {
            sleep(400);
            this.dismissPopupsLoop(2);
            var st2 = this.detectPage();
            sendLog(tid, "[唤起] 大麦已回前台, 页面: " + st2.page);
            return true;
        }
        sendLog(tid, "[唤起] 警告: 大麦未能回到前台 (可能被系统限制), 再试 launchApp");
        try { app.launch(this.packageName); } catch (e3) {}
        var backFront2 = waitUntil(function() { return self.isDamaiForeground(); }, 5000, 300, tid);
        if (backFront2) {
            sleep(600);
            this.dismissPopupsLoop(3); // 冷启动后可能有开屏广告+弹窗
            return true;
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
        if (isCancelled(tid)) return false;
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
                        sleep(800);
                    } catch (eH) {}
                    this.dismissPopupsLoop(2);
                }
            }
            // 确保在「首页」Tab (大麦 Tab 状态跨启动保留, 可能停在「我的」)
            var homeTab = quickFind(text("首页")) || quickFind(id("cn.damai:id/tab_text").text("首页"));
            if (homeTab && homeTab.bounds) {
                var htb = homeTab.bounds();
                if (htb.top > device.height * 0.8) { // 底部 Tab 栏才点
                    humanClick(homeTab);
                    sleep(400);
                    this.dismissPopups();
                }
            }
            // 2. 点击首页搜索入口 (多代 id 兜底, 2026-10 实测: pioneer_homepage_header_search_btn)
            //    轮询式查找: 任一选择器命中立即继续 (替代 6 段串行 findOne 最长 5.4s)
            var searchEntry = null;
            waitUntil(function() {
                searchEntry = quickFind(id("cn.damai:id/pioneer_homepage_header_search_btn")) ||
                              quickFind(id("cn.damai:id/homepage_header_search_layout")) ||
                              quickFind(id("cn.damai:id/search_text")) ||
                              quickFind(id("cn.damai:id/channel_search_text")) ||
                              quickFind(id("cn.damai:id/homepage_header_search_btn")) ||
                              quickFind(text("搜索"));
                return !!searchEntry;
            }, 5000, 250, tid);
            if (!searchEntry) {
                sendLog(tid, "[搜索] 未找到首页搜索入口");
                return false;
            }
            humanClick(searchEntry);
            // 等待搜索页输入框出现 (命中即走)
            waitUntil(function() {
                return !!(quickFind(id("cn.damai:id/header_search_v2_input")) || quickFind(className("android.widget.EditText")));
            }, 2500, 200, tid);
        }

        // 3. 输入关键字 (必须走 IME input() 路径: setText 不触发联想建议)
        var inputEt = quickFind(id("cn.damai:id/header_search_v2_input")) ||
                      quickFind(className("android.widget.EditText")) ||
                      id("cn.damai:id/header_search_v2_input").findOne(600) ||
                      className("android.widget.EditText").findOne(400);
        if (!inputEt) {
            sendLog(tid, "[搜索] 未找到搜索输入框");
            return false;
        }
        // 清空已有内容
        try {
            var delBtn = quickFind(id("cn.damai:id/header_search_v2_input_delete"));
            if (delBtn) humanClick(delBtn);
        } catch (eD) {}
        try { inputEt.setText(""); } catch (eC) {}
        humanClick(inputEt); // 聚焦唤起输入法
        sleep(400);
        try { input(hints.keyword); } catch (eI) {
            try { inputEt.setText(hints.keyword); } catch (eS) {}
        }

        // 4. 点击匹配的搜索建议 (tv_word), 否则第一条; 等建议出现即可, 不等满
        var clicked = false;
        var suggNodes = [];
        var suggReady = waitUntil(function() {
            suggNodes = id("cn.damai:id/tv_word").find();
            return suggNodes && suggNodes.length > 0;
        }, 1500, 200, tid);
        if (suggReady && suggNodes && suggNodes.length > 0) {
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
        // 等待结果页出现 (命中即走, 替代固定 2s)
        waitUntil(function() {
            return DamaiAdapter.detectPage().page === "detail" ||
                   !!quickFind(id("cn.damai:id/tv_city")) ||
                   !!quickFind(id("cn.damai:id/ll_search_item")) ||
                   !!quickFind(id("cn.damai:id/ll_project_right"));
        }, 2200, 250, tid);
        this.dismissPopups();

        // 5. 结果页: 城市卡 (巡演) 或 普通结果项 → 进入详情
        for (var w = 0; w < 8; w++) {
            if (isCancelled(tid)) {
                sendLog(tid, "[搜索] 收到终止指令, 中止搜索");
                return false;
            }
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
                // 等待详情页出现 (命中即走, 替代固定 2.2s)
                waitUntil(function() { return DamaiAdapter.detectPage().page === "detail"; }, 2200, 250, tid);
                this.dismissPopups();
                if (this.detectPage().page === "detail") {
                    sendLog(tid, "[搜索] ✔ 已进入目标城市演出详情页");
                    return true;
                }
                continue;
            }
            // 5b. 普通结果项 (秒查 + 短兜底)
            var item = quickFind(id("cn.damai:id/ll_search_item")) ||
                       quickFind(id("cn.damai:id/ll_project_right")) ||
                       quickFind(id("cn.damai:id/tv_project_tourName")) ||
                       id("cn.damai:id/ll_search_item").findOne(400) ||
                       id("cn.damai:id/ll_project_right").findOne(300);
            if (item) {
                sendLog(tid, "[搜索] 点击搜索结果项");
                clickAncestor(item, 3);
                waitUntil(function() { return DamaiAdapter.detectPage().page === "detail"; }, 1800, 250, tid);
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

        // 等待详情页加载完成 (骨架屏消失, 最多 6.4s, 一消失就继续)
        waitUntil(function() { return !id("cn.damai:id/id_new_skeleton").exists(); }, 6400, 300, tid);
        this.dismissPopups();

        // 验证抽屉就位 (点击 → 排队/验证码处理 → 重试)
        // 轮数 4: 实测 1 次正确点击即可打开选票面板; 保留少量重试容错, 缺货/未开售场景快速失败
        for (var w = 0; w < 4; w++) {
            if (isCancelled(tid)) {
                sendLog(tid, "[开抽屉] 收到终止指令, 停止重试");
                sendStep(tid, "open_sku", "failed", "手动终止");
                return false;
            }
            this.dismissPopups();

            // 排队/加载失败态: 点击「努力刷新」
            var retryBtn = quickFind(id("cn.damai:id/state_view_retry_btn")) ||
                           quickFind(safeTextMatches(/努力刷新/));
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

            // 每轮点击底栏购买入口; 坐标来源 (2026-10-09 真机实测校准):
            //   购票状态栏容器 (trade_project_detail_purchase_status_bar_container_fl) 的中心
            //   = 底栏主按钮 (立即预订/购票/缺货登记, 自绘控件) 的中心 —— 实测该点位可打开选票面板
            var container = quickFind(id("cn.damai:id/trade_project_detail_purchase_status_bar_container_fl")) ||
                            id("cn.damai:id/trade_project_detail_purchase_status_bar_container_fl").findOne(400);
            var cx, cy;
            if (container && container.bounds) {
                var cb = container.bounds();
                cx = Math.floor(cb.centerX());
                cy = Math.floor(cb.centerY());
            } else {
                var btnBuy = quickFind(id("cn.damai:id/tv_left_main_text"));
                if (btnBuy && btnBuy.bounds) {
                    var bb = btnBuy.bounds();
                    cx = Math.floor(bb.centerX());
                    cy = Math.floor(bb.centerY());
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
            // 点击后响应式等待: 抽屉一就位立即返回, 不浪费整轮重试
            if (waitUntil(function() {
                    return DamaiAdapter.isInSkuDrawer() || DamaiAdapter.isInOrderConfirmPage();
                }, 1000, 200, tid)) {
                sendLog(tid, "[开抽屉] 选票页已就位 (第 " + (w + 1) + " 轮点击后命中)");
                sendStep(tid, "open_sku", "done");
                return true;
            }
        }
        var soldOutHint = "";
        try {
            if (text("缺货").exists() || textContains("缺货登记").exists()) {
                soldOutHint = " —— 页面含「缺货」标识, 该场次当前无票, 没有选票面板可开 (属正常状态, 非点击故障)";
            }
        } catch (eSO) {}
        sendStep(tid, "open_sku", "failed", "选票面板未出现" + (soldOutHint ? " (场次缺货)" : ""));
        sendLog(tid, "[开抽屉] 未出现选票面板 (已尝试点击购买入口 4 轮)。当前: " + this.detectPage().activity + soldOutHint);
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
        if (isCancelled(tid)) return false;
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
            if (isCancelled(tid)) break;
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
            if (isCancelled(tid)) break;
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
        var btn;
        if (urgent) {
            // 抢购热路径: 保持原保守查找节奏不动 (T0 毫秒级关键动作)
            btn = id("cn.damai:id/btn_buy").findOne(300) ||
                  id("cn.damai:id/btn_buy_view").findOne(300) ||
                  text("确定").findOne(300) ||
                  desc("确定").findOne(300);
        } else {
            // 演练/普通路径: 秒查优先, 命中即用; 全落空再短兜底
            btn = quickFind(id("cn.damai:id/btn_buy")) ||
                  quickFind(id("cn.damai:id/btn_buy_view")) ||
                  quickFind(text("确定")) ||
                  quickFind(desc("确定")) ||
                  id("cn.damai:id/btn_buy").findOne(600) ||
                  id("cn.damai:id/btn_buy_view").findOne(400);
        }
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

        // 等待订单页 (总预算 6s 不变, 200ms 细粒度: 取消指令响应更快)
        var reached = false;
        for (var t = 0; t < 30; t++) {
            if (isCancelled(tid)) {
                sendStep(tid, "order_confirm", "failed", "手动终止");
                return null;
            }
            if (this.isInOrderConfirmPage()) { reached = true; break; }
            this.checkCaptcha();
            sleep(200);
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
        var tipNode = quickFind(safeTextMatches(/仅需选择.*位|请选择.*位观演人/)) ||
                      safeTextMatches(/仅需选择.*位|请选择.*位观演人/).findOne(400);
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
        // 提交前最后一道终止闸: 收到手动终止指令则放弃提交 (已提交成功的单子无法撤回, 这里尽力拦截)
        var submitBtn = null;
        for (var r = 0; r < 5 && !submitBtn; r++) {
            if (isCancelled(tid)) {
                sendLog(tid, "[提交] 收到终止指令, 放弃提交");
                sendStep(tid, "submit", "failed", "提交前被手动终止");
                return { outcome: "cancelled", reason: "manual_abort", evidence: "提交前被手动终止, 未下单" };
            }
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
        // 等待观演人列表渲染 (网络加载偶发慢; 300ms 细粒度轮询命中即走, 中途轻推列表触发渲染)
        for (var w = 0; w < 36; w++) {
            if (isCancelled(tid)) return [];
            if (id("cn.damai:id/text_name").find().length > 0) break;
            if (w === 10 || w === 22) {
                try {
                    var rv = id("cn.damai:id/recycler_main").findOne(300);
                    if (rv && rv.scrollForward) rv.scrollForward();
                } catch (eS) {}
            }
            sleep(300);
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
        for (var d0 = selected.length - 1; d0 >= 0; d0--) {   // ★ 倒序遍历: 正序 + splice 会跳过下一项 (连续多个非目标预选时漏取消)
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
            if (isCancelled(tid)) break;
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
            if (isCancelled(tid)) break;
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
                    return false;   // ★ 已通过: 必须回报"无验证码", 否则 readResult 会把成功单误报成 risk_challenge
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
            // 注: 真实订单号在支付页深层, 抓取成本高且易误读 —— 不伪造; 时间戳仅作证据留痕, 不冒充单号
            return {
                outcome: "ordered",
                evidence: "成功进入收银台/订单提交成功",
                data: { orderedAtMs: now() }
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

    /* ================================================================
     * 13. 链接抢购 (grab) —— 2026-10-09 重写 (替代旧 watchAndFireOnDetail)
     *     链接就位 → 页面核对 → 信号锚定 → 对时 → 低频预监视
     *     → T0-1s 高频突变检测 → 瞬间首击(纯ADB) → 拟人连点链 → 提交风暴
     * ================================================================ */

    /** 当前是否已在大麦商品详情页 */
    grabOnDetailPage: function() {
        if (safeActivity().indexOf("ProjectDetailActivity") >= 0) return true;
        return !!quickFind(id("cn.damai:id/trade_project_detail_purchase_status_bar_container_fl"));
    },

    /** 读详情页标题文本 —— 页面身份的唯一权威（标题里同时含城市与站名，如"…- 贵阳站"） */
    grabReadTitle: function() {
        var ids = ["cn.damai:id/info_v2_title_tv1", "cn.damai:id/info_v2_title_tv"];
        for (var i = 0; i < ids.length; i++) {
            try {
                var n = id(ids[i]).findOnce();
                if (n && n.text) { var t = String(n.text()).trim(); if (t) return t; }
            } catch (e) {}
        }
        return null;
    },

    /**
     * 页面核对: 「目标站名 + 关键词」必须命中**标题**。
     * ★ 2026-10-09 修掉一个会点错商品的 bug: 原来是全页搜字(textContains) —— 但巡演站选择器里
     *   列着**所有**站名(如"厦门站"), 于是"给厦门站布防、手机却还停在贵阳站页面"也能通过核对,
     *   脚本就不会跳转、直接在错误商品上蹲守。
     *   现在只在标题节点里比对; 标题读不到才退化为全页搜字, 并明确上报告警(不再静默)。
     */
    grabKeywordsOk: function(task) {
        var title = this.grabReadTitle();
        var station = String((task && task.target && task.target.session) || "").trim();
        var kws = (task && task.target && task.target.expectKeywords) || [];
        if (title) {
            // 站名是强判据: 目标站名不在标题里 = 跑错站, 直接否决
            if (station && title.indexOf(station) < 0) return false;
            for (var i = 0; i < kws.length; i++) {
                var kw = String(kws[i] || "").trim();
                if (!kw) continue;
                if (title.indexOf(kw) < 0) return false;
            }
            return true;
        }
        // 退化路径: 标题节点读不到 → 全页搜字(弱校验), 但必须留痕
        try { Transport.sendEvent(task && task.taskId, "page_id_degraded", { reason: "标题节点读不到, 退回全页搜字(弱校验)" }); } catch (eE) {}
        if (station) { try { if (!textContains(station).findOnce()) return false; } catch (e2) { return false; } }
        for (var j = 0; j < kws.length; j++) {
            var kw2 = String(kws[j] || "").trim();
            if (!kw2) continue;
            try { if (!textContains(kw2).findOnce()) return false; } catch (e3) { return false; }
        }
        return true;
    },

    /** 读详情页 "X月X日 HH:MM开抢" 文本 (交叉核对 T0 用, 可选) */
    grabReadSellTime: function() {
        try {
            var n = id("cn.damai:id/id_project_count_sell_time").findOnce();
            if (n && n.text) return String(n.text());
        } catch (e) {}
        return null;
    },

    /** 阶段0: 链接就位 —— 已在目标页则复用; 否则请求中枢深度链接打开 */
    grabLocate: function(task, tid) {
        sendStep(tid, "item_open", "start");
        var itemId = (task && task.target && task.target.itemId) ? String(task.target.itemId) : "";
        if (!/^\d{6,}$/.test(itemId)) {
            sendStep(tid, "item_open", "failed", "itemId 非法");
            return { ok: false, reason: "itemId 非法" };
        }
        if (this.grabOnDetailPage() && this.grabKeywordsOk(task)) {
            sendLog(tid, "[就位] 已停留在目标商品页, 跳过打开");
            sendStep(tid, "item_open", "done", "已在目标页");
            return { ok: true, via: "already" };
        }
        var r = Transport.openItem(itemId);   // ★ 统一通道: USB→中枢ADB, WiFi→手机本地 deep-link
        if (!r || !r.ok) {
            var why = (r && r.error) ? r.error : "中枢离线或 ADB 不可用";
            sendLog(tid, "[就位] ✘ 链接直达失败: " + why);
            sendStep(tid, "item_open", "failed", why);
            Transport.sendEvent(tid, "item_open_fail", { itemId: itemId, reason: why });
            return { ok: false, reason: why };
        }
        var ok = waitUntil(function() { return DamaiAdapter.grabOnDetailPage(); }, 6000, 150, tid);
        sendStep(tid, "item_open", ok ? "done" : "failed", (r.hit || "") + (ok ? "" : " (打开后未检测到详情页)"));
        Transport.sendEvent(tid, "item_open_ok", { itemId: itemId, hit: r.hit || "", landed: ok, tried: r.tried || [] });
        return { ok: ok, via: "deeplink", reason: ok ? "" : "打开后未检测到详情页" };
    },

    /** 巡演切站救援 (2026-10-10 真机实证): 大麦 deep-link 对巡演项目只能落到"默认/上次站",
     *  目标是其他城市站时必须点页面上的站点选择卡切换 —— 否则页面核对必然拒绝 (抢错站防线)。
     *  三级尝试: ①站点卡 (精确 text → textContains, 找不到先上滑露出站点区再找)
     *           ②搜索直达 (searchAndEnter, 已验证的可靠路径, 较慢但兜底) */
    grabSwitchStation: function(task, tid) {
        var station = String((task.target && task.target.session) || "").trim();
        if (!station) return false;
        var devW = 1080, devH = 2400;
        try { devW = device.width || 1080; devH = device.height || 2400; } catch (eD) {}
        var tryClickCard = function () {
            var cands = [];
            try { cands = text(station).find(); } catch (e1) {}
            if (!cands || !cands.length) { try { cands = textContains(station).find(); } catch (e2) {} }
            for (var i = 0; cands && i < cands.length; i++) {
                var n = cands[i];
                try {
                    var b = n.bounds();
                    if (!b || b.width() < 40 || b.width() > devW * 0.6) continue;   // 排除标题等长文本
                    sendLog(tid, "[切站] 点击站点卡: " + station + " (" + Math.floor(b.centerX()) + "," + Math.floor(b.centerY()) + ")");
                    Transport.sendEvent(tid, "station_switch", { station: station, x: Math.floor(b.centerX()), y: Math.floor(b.centerY()) });
                    clickAncestor(n, 3);
                    sleep(2400);   // 站点切换后页面整体刷新
                    DamaiAdapter.dismissPopups();
                    sleep(600);
                    return true;
                } catch (eC) {}
            }
            return false;
        };
        // ① 站点卡 (当前视口)
        if (tryClickCard()) return true;
        // ② 站点区可能被滚出屏幕: 上滑回顶部再找 (两轮)
        for (var s = 0; s < 2; s++) {
            try {
                swipe(Math.floor(devW / 2), Math.floor(devH * 0.35), Math.floor(devW / 2), Math.floor(devH * 0.8), 350);
                sleep(900);
            } catch (eS) {}
            if (tryClickCard()) return true;
        }
        // ③ 搜索直达兜底 (tv_city 城市卡, 已验证的可靠路径)
        var fullName = String((task.target && task.target.name) || "").trim();
        if (fullName) {
            sendLog(tid, "[切站] 站点卡未找到, 走搜索直达: " + fullName);
            try {
                if (this.searchAndEnter(fullName, tid)) {
                    sleep(800);
                    return true;
                }
            } catch (eSe) {}
        }
        sendLog(tid, "[切站] 全部路径未能切到「" + station + "」");
        return false;
    },

    /** 阶段1: 页面核对闸门 (对不上 → 不动作 + 报警)
     *  ★ 2026-10-10 修复: 深链重开后页面常在加载中 (骨架屏/标题未渲染), 立即读关键词必空 →
     *    误判"核对失败"直接废任务。改为: 详情页就位时给内容最多 6s 渲染时间, 期间反复核对。 */
    grabVerify: function(task, tid) {
        sendStep(tid, "page_verify", "start");
        var act = safeActivity();
        var onDetail = act.indexOf("ProjectDetailActivity") >= 0;
        if (!onDetail) {
            // 非详情页 (例如深链还在路由): 轮询等 6s 落位
            var landed = waitUntil(function () {
                return safeActivity().indexOf("ProjectDetailActivity") >= 0;
            }, 6000, 300, tid);
            if (landed) { onDetail = true; act = safeActivity(); }
        }
        var kwOk = false;
        var sellText = null;
        if (onDetail) {
            var t0 = now();
            while (now() - t0 < 6000) {
                if (isCancelled(tid)) break;
                kwOk = this.grabKeywordsOk(task);
                if (kwOk) { sellText = this.grabReadSellTime(); break; }
                sleep(400);   // 标题/文案还在渲染, 稍后重读
            }
        }
        if (!(onDetail && kwOk)) {
            sendLog(tid, "[核对] ✘ 页面核对失败 (activity=" + act + ", 关键词=" + (kwOk ? "命中" : "未命中") + ")");
            sendStep(tid, "page_verify", "failed", "非目标页或关键词未命中");
            Transport.sendEvent(tid, "page_verify_fail", { act: act, kwOk: kwOk });
            try { device.vibrate(400); } catch (eV) {}
            return { ok: false };
        }
        sendStep(tid, "page_verify", "done", sellText || "已核对");
        Transport.sendEvent(tid, "page_verify_ok", { act: act, sellText: sellText });
        return { ok: true, sellText: sellText };
    },

    /** 阶段2: 锚定 —— 基线信号 + 按钮坐标 (全部预取, 热路径零查找)
     *  坐标优先级 (2026-10-10 修正):
     *    ① 控制台显式配置的 button 坐标 (用户标定值, 按 calibScreen 换算)
     *    ② 统一锚点 GRAB_POINTS.anchor (841,2310 = 立即预订/确定/立即提交 三键交集中心,
     *       真机三截图程序化测边标定) —— 真机分辨率与标定一致 或 控制台带了 calibScreen 时生效
     *    ③ 底栏容器实读中心 (兜底: 分辨率未知且无标定时, 实读自适应)
     *  此前 ② 缺失: 默认落到 ③ (实测中心 682,2305), 距「确定」键左缘仅 14px, 抖动余量几乎为零。 */
    grabAnchor: function(task, verifyInfo, tid) {
        sendStep(tid, "anchor", "start");
        var st = readButtonSignal();
        var pt = null;
        var ptSrc = "none";
        if (task && task.grab && task.grab.button) {
            pt = scaleToDevice({ x: task.grab.button.x, y: task.grab.button.y }, task);
            ptSrc = "console";
        }
        if (!pt) {
            var dev = { w: 0, h: 0 };
            try { dev.w = device.width || 0; dev.h = device.height || 0; } catch (eD) {}
            var cal = (task && task.grab) ? task.grab.calibScreen : null;
            var unifiedOk = (dev.w === GRAB_POINTS.calib.w && dev.h === GRAB_POINTS.calib.h) ||
                            !!(cal && cal.w === dev.w && cal.h === dev.h);
            if (unifiedOk && dev.w > 0) {
                pt = scaleToDevice({ x: GRAB_POINTS.anchor.x, y: GRAB_POINTS.anchor.y }, task);
                ptSrc = "unified";
            }
        }
        if (!pt && st.center) {
            pt = st.center;
            ptSrc = "container";
        }
        if (!pt) {
            sendStep(tid, "anchor", "failed", "无按钮坐标 (容器缺失且未配置)");
            return { ok: false };
        }
        var mode = (st.hasContainer ? "smart" : "blind") + "/" + ptSrc;
        if (ptSrc === "container") {
            Transport.sendEvent(tid, "anchor_degraded", { sig: st.sig, reason: "分辨率未标定, 用底栏容器实读中心 (距按钮左缘余量小)" });
            sendLog(tid, "[锚定] ⚠ 分辨率未标定, 用容器实读中心 (" + pt.x + "," + pt.y + ") —— 建议在控制台填主按钮坐标");
        }
        sendStep(tid, "anchor", "done", mode + " (" + pt.x + "," + pt.y + ")");
        var baseTexts = scanTexts();
        Transport.sendEvent(tid, "anchor_ok", {
            mode: mode, src: ptSrc, sig: st.sig, x: pt.x, y: pt.y,
            presale: st.presale.join("") + " (6 项: 倒计时块/开抢时间/预约提醒/提醒条/倒计时内层/倒计时背景)",
            texts: baseTexts,
            sellText: (verifyInfo && verifyInfo.sellText) || this.grabReadSellTime()
        });
        if (!(st.cdOn || st.sellOn || st.remindOn)) {
            sendLog(tid, "[锚定] ⚠ 页面此刻没有预约结构(倒计时/开抢时间/预约提醒), 只能靠兜底信号判断开售");
            Transport.sendEvent(tid, "anchor_no_presale", { sig: st.sig });
        }
        return {
            ok: true, mode: mode, src: ptSrc, sig: st.sig, cx: pt.x, cy: pt.y, hasContainer: st.hasContainer,
            // 基线快照：出手判定用（预约结构 + 容器属性 + 文案）
            presale: st.presale, cAttrs: st.cAttrs, texts: baseTexts
        };
    },

    /**
     * 开售前自动刷新页面并重新锚定（默认关的开关, 控制台可开）
     * 为什么: 页面可能"状态陈旧"(开着很久不刷新), 开售时按钮/文案不会自己变新 → 结构信号等不到变化。
     * 怎么做: 用已验证的深链重开商品页(会重新拉取详情) → 等回到详情页 → 重新核对 → 重新锚定并更新基线。
     * 失败就保持原页面继续盯梢(不打断), 刷新期间不做出手判定。
     */
    grabRefreshAndReanchor: function(task, tid, label) {
        var itemId = (task && task.target && task.target.itemId) ? String(task.target.itemId) : "";
        sendStep(tid, "refresh", "start", label);
        sendLog(tid, "[" + label + "] 自动刷新页面(深链重开) —— 让开售状态变新");
        var r = Transport.openItem(itemId);   // ★ 统一通道 (USB→中枢ADB / WiFi→本地 deep-link)
        if (!r || !r.ok) {
            sendLog(tid, "[" + label + "] ✘ 刷新失败: " + ((r && r.error) || "无回应") + " → 继续用原页面盯梢");
            sendStep(tid, "refresh", "failed", "刷新失败");
            return null;
        }
        var ok = waitUntil(function () { return DamaiAdapter.grabOnDetailPage(); }, 7000, 200, tid);
        if (!ok) {
            sendLog(tid, "[" + label + "] ✘ 刷新后未回到详情页 → 继续用原页面");
            sendStep(tid, "refresh", "failed", "未回到详情页");
            return null;
        }
        var v = this.grabVerify(task, tid);
        if (!v.ok) { sendLog(tid, "[" + label + "] ✘ 刷新后页面核对未通过 → 继续用原页面"); sendStep(tid, "refresh", "failed", "核对未通过"); return null; }
        var a = this.grabAnchor(task, v, tid);
        if (!a.ok) { sendLog(tid, "[" + label + "] ✘ 刷新后锚定失败 → 继续用原页面"); sendStep(tid, "refresh", "failed", "锚定失败"); return null; }
        sendLog(tid, "[" + label + "] ✓ 已刷新并重新锚定: " + a.sig);
        sendStep(tid, "refresh", "done", label + " 已刷新");
        Transport.sendEvent(tid, "page_refreshed", { label: label, sig: a.sig });
        return a;
    },

    /** 瞬间首击: 通道链 PC-ADB(USB) → 本地 Shizuku → 手势兜底; 失败短超时重试, 不静默降级 */
    emitFirstTap: function(anchor, tid, fireAt, offset, cause) {
        var jx = jitterInt(anchor.cx, CLICK_CFG.jitterXPx);
        var jy = jitterInt(anchor.cy, CLICK_CFG.jitterYPx);
        var t0 = now();
        var viaName = "";
        var tries = 0;
        var cmdMs = 0;
        // 首击是全场最关键的一下 —— 网络抖动时不能默默降级成手机手势 (手势对自绘按钮无效)。
        // ① PC-ADB: 先短超时出手; 打不通立刻重试 (最多 N 发)
        while (tries < CLICK_CFG.firstTapTries && !viaName) {
            tries++;
            var ts = now();
            if (Transport.adbTap(jx, jy, tries === 1 ? CLICK_CFG.firstTapTimeoutMs : (CLICK_CFG.firstTapTimeoutMs + 200))) viaName = "persist";
            cmdMs += now() - ts;
        }
        // ② 本地 Shizuku 注入 (与 PC-ADB 同级, 自绘按钮有效; USB 不通/Wi-Fi 时手机自主出膛)
        if (!viaName && LocalInjector.available() && LocalInjector.tap(jx, jy, 40)) {
            viaName = "shizuku";
            tries++;
        }
        var t1 = now();
        // ③ 手势兜底 (对自绘按钮通常无效, 普通控件可用), 明确告警
        if (!viaName) {
            fastPress(jx, jy);
            viaName = "gesture(告警)";
            try { device.vibrate(600); } catch (eVib) {}
            Transport.sendEvent(tid, "first_tap_degraded", { x: jx, y: jy, tries: tries, cmdMs: t1 - t0 });
        }
        var deltaMs = (t0 + offset) - fireAt;
        sendLog(tid, "[首击] cause=" + cause + " (" + jx + "," + jy + ") via=" + viaName
            + " 第" + tries + "发 ΔT0=" + deltaMs + "ms cmd=" + cmdMs + "ms");
        Transport.sendEvent(tid, "first_tap_sent", { x: jx, y: jy, cause: cause, via: viaName !== "gesture(告警)", viaName: viaName, tries: tries, deltaMs: deltaMs, cmdMs: cmdMs });
        return { cause: cause, at: t0, deltaMs: deltaMs, via: viaName !== "gesture(告警)", viaName: viaName, tries: tries };
    },

    /** 微瞄准: 优先 "确定/提交" 实节点中心(便宜), 找不到回退锚点 (首击之后才用, 不影响首击延迟) */
    grabAimRefresh: function(anchor, task) {
        var p = quickCenter(id("cn.damai:id/btn_buy_view")) ||
                quickCenter(text("确定")) ||
                quickCenter(text("提交订单")) ||
                quickCenter(text("立即提交"));
        if (p && p.y > 1200) return p;
        if (task && task.grab && task.grab.submit) return scaleToDevice({ x: task.grab.submit.x, y: task.grab.submit.y }, task);
        return { x: anchor.cx, y: anchor.cy };
    },

    /**
     * 阶段3-5: 低频预监视 → T0-1s 高频突变检测 → 瞬间首击 / 保底盲点
     * @param {boolean} dryRun 彩排模式: 只检测不点击
     * @returns {{fired:boolean, cancelled?:boolean, late?:boolean, detected?:boolean, cause?:string, deltaMs?:number}}
     */
    grabWatchAndFire: function(task, anchor, tid, dryRun) {
        var fireAt = (task.timing && task.timing.fireAtEpochMs) || 0;
        var offset = TimeSync.cachedOffset || 0;
        var hotLead = (task.timing && task.timing.highFreqLeadMs) || 1000;
        var fireLocal = fireAt - offset;
        var hotStartLocal = fireLocal - hotLead;

        // 迟到保护: 已过开抢时刻 5 秒以上则拒绝 (防误点)
        if (now() > fireLocal + 5000) {
            sendStep(tid, "prewatch", "failed", "已过开抢时刻超过 5 秒, 拒绝盲点");
            return { fired: false, late: true };
        }

        // ================= 彩排分支 (2026-10-09 用户口径 v2) =================
        // 彩排的目的不是"等按钮变化" —— 假时间点按钮本来就不会变, 检测必然空转。
        // 改为: 不做任何变化检测, 到点直接真打 —— 极速首击 → 立刻接超高频连点,
        //       只验证「到点能否极速出手」+「连点通道能否接上并跑出速率」。
        // 不跑提交风暴的状态看护/微瞄准/装配观演人, 连点固定打在锚点上 (可预期、可回收)。
        if (dryRun) {
            sendStep(tid, "prewatch", "done", "彩排: 跳过变化检测");
            var waitBeat = now();
            var rehWarm = false;
            var rehArmed = false;
            while (now() < fireLocal) {
                if (isCancelled(tid)) {
                    // ★ 取消时必须撤掉已预置的那一发 —— 否则人到不了场, 中枢时钟到点仍会把这发打出去
                    if (rehArmed) { try { Transport.disarmTap(tid); } catch (eDis) {} }
                    return { fired: false, cancelled: true };
                }
                if (!rehWarm && fireLocal - now() <= 2500) {
                    rehWarm = true;
                    var wReh = Transport.warmChannel();
                    sendLog(tid, "[彩排] 通道预检 " + (wReh.ok ? ("✓ " + wReh.ms + "ms") : ("✘ " + wReh.reason)));
                    var aReh = Transport.armTap(anchor.cx, anchor.cy, fireAt, tid);
                    rehArmed = !!aReh.ok;
                    sendLog(tid, "[彩排] 预置击发 " + (rehArmed ? ("✓ 已排在中枢 T0 (剩 " + Math.round(fireLocal - now()) + "ms)") : ("✘ " + aReh.reason + " → 回落请求通道")));
                }
                if (now() - waitBeat > 5000) {
                    waitBeat = now();
                    sendLog(tid, "[彩排] 静默等待 T0, 剩余约 " + Math.round((fireLocal - now()) / 1000) + "s (不检测按钮变化)");
                }
                sleep(Math.min(1000, Math.max(5, fireLocal - now())));
            }

            // ① 到点极速首击: 优先取中枢侧预置击发结果 (那一发不经 T0 网络), 没回执才回落请求通道
            var rFirst = null;
            if (rehArmed) {
                sleep(Math.max(0, (fireLocal + 220) - now()));
                var stReh = Transport.armStatus(tid);
                var recReh = stReh && stReh.results ? stReh.results[tid] : null;
                if (recReh && recReh.via !== "fail") {
                    rFirst = { cause: "rehearsal_deadline", deltaMs: recReh.deltaMs, via: true, tries: 1, hubArmed: true };
                    sendLog(tid, "[首击] 中枢预置击发 ΔT0=" + recReh.deltaMs + "ms via=" + recReh.via + " 落点(" + recReh.x + "," + recReh.y + ")");
                    Transport.sendEvent(tid, "first_tap_sent", { x: recReh.x, y: recReh.y, cause: "rehearsal_deadline", via: true, hubArmed: true, tries: 1, deltaMs: recReh.deltaMs, cmdMs: 0 });
                } else {
                    Transport.sendEvent(tid, "channel_warn", { phase: "rehearsal", reason: "预置击发无回执" });
                    sendLog(tid, "[首击] ⚠ 预置击发无回执, 回落请求通道");
                }
            }
            if (!rFirst) rFirst = this.emitFirstTap(anchor, tid, fireAt, offset, "rehearsal_deadline");
            sendStep(tid, "first_tap", "done", "ΔT0 " + rFirst.deltaMs + "ms via=" + (rFirst.via ? "persist" : "gesture(告警)") + (rFirst.hubArmed ? " · 中枢预置" : " · 请求通道"));

            // ② 立刻接拟人连点 (固定锚点, 不做微瞄准/状态看护 —— 彩排不打提交)
            //    节拍: 抖动间隔, 硬上限 20 击/秒 (防超频风控)
            var REH_MS = CLICK_CFG.rehearsalMs;
            sendStep(tid, "tap_chain", "start", "彩排拟人连点 " + REH_MS + "ms (≤20 击/秒)");
            var rehTaps = 0, rehFail = 0, rehStart = now();
            var rehStamps = [];
            while (now() - rehStart < REH_MS) {
                if (isCancelled(tid)) { sendStep(tid, "tap_chain", "failed", "手动终止"); return { fired: true, cancelled: true, cause: "rehearsal_deadline", deltaMs: rFirst.deltaMs, taps: rehTaps }; }
                var okReh = humanTap(anchor.cx, anchor.cy);
                if (!okReh) { rehFail++; if (rehFail >= 3) break; } else { rehFail = 0; rehTaps++; rehStamps.push(now()); }
                waitTapSlot(Math.max(50, humanGapMs()));   // 全局 ≥50ms/击: 硬上限 20 击/秒
            }
            var rehMs = now() - rehStart;
            var rehPerSec = Math.round(rehTaps / Math.max(0.001, rehMs / 1000));
            var rehPeak = peakPerSec(rehStamps);
            Transport.sendEvent(tid, "rehearsal_tap_result", {
                firstDeltaMs: rFirst.deltaMs, firstVia: rFirst.via ? "persist" : "gesture", firstTries: rFirst.tries,
                taps: rehTaps, burstMs: rehMs, tapsPerSec: rehPerSec, peakPerSec: rehPeak,
                x: anchor.cx, y: anchor.cy
            });
            sendStep(tid, "tap_chain", "done", "彩排连点 " + rehTaps + " 击 / " + rehMs + "ms = " + rehPerSec + " 击/秒 (峰值 " + rehPeak + "/秒)");
            sendLog(tid, "[彩排] 首击 ΔT0=" + rFirst.deltaMs + "ms (第" + rFirst.tries + "发), 连点 " + rehTaps + " 击 ("
                + rehMs + "ms, 均 " + rehPerSec + " 击/秒, 峰值 " + rehPeak + " 击/秒), 落点 (" + anchor.cx + "," + anchor.cy + ")");
            return {
                fired: true, cause: "rehearsal_deadline", deltaMs: rFirst.deltaMs,
                taps: rehTaps, tapsPerSec: rehPerSec, peakPerSec: rehPeak, burstMs: rehMs
            };
        }

        // —— 低频预监视 (只观察记录, 不动作) ——
        sendStep(tid, "prewatch", "start", "T0 前低频观察");
        var preChanges = [];
        var lastBeat = now();
        var chanWarmed = false;
        var refreshed30 = false, refreshed12 = false;
        while (now() < hotStartLocal) {
            if (isCancelled(tid)) {
                sendStep(tid, "prewatch", "failed", "手动终止");
                return { fired: false, cancelled: true };
            }
            var rem = hotStartLocal - now();
            if (rem > 4000) {
                // 开售前自动刷新（默认关的开关）: T-30s 与 T-12s 各一次, 刷新后重新锚定并换基线
                if (CLICK_CFG.autoRefresh) {
                    var refA = null;
                    if (!refreshed30 && rem <= 31000) { refreshed30 = true; refA = this.grabRefreshAndReanchor(task, tid, "T-30s"); }
                    else if (!refreshed12 && rem <= 13000) { refreshed12 = true; refA = this.grabRefreshAndReanchor(task, tid, "T-12s"); }
                    if (refA) { anchor = refA; preChanges.length = 0; }
                }
                if (now() - lastBeat > 30000) {
                    lastBeat = now();
                    sendLog(tid, "[预监视] 距高频窗口约 " + Math.round(rem / 1000) + "s, 按钮基线: " + anchor.sig);
                }
                sleep(Math.min(1500, rem - 3000));
            } else {
                if (!chanWarmed && rem <= 2500) {
                    chanWarmed = true;
                    // 通道预检: 探路 + 焐热 + 顺带拿到实测往返 (给节拍换算用)
                    var wArm = Transport.warmChannel();
                    if (wArm.ok && wArm.ms > 0) CLICK_CFG.rttMs = Math.max(1, wArm.ms);
                    sendLog(tid, "[通道] 预检 " + (wArm.ok ? ("✓ " + wArm.ms + "ms (往返实测已用于节拍换算)") : ("✘ " + wArm.reason)));
                    if (!wArm.ok) Transport.sendEvent(tid, "channel_warn", { phase: "prewatch", reason: wArm.reason });
                    // 注: 实战分支**不做任何预置击发** —— 到点盲点会打在还没刷新的「已预约」上, 已被明确否决。
                }
                var s0 = readButtonSignal();
                if (signalChangedFrom(s0, anchor)) {
                    preChanges.push({ deltaMs: now() + offset - fireAt, sig: s0.sig });
                    Transport.sendEvent(tid, "prewatch_change", { deltaMs: now() + offset - fireAt, sig: s0.sig });
                }
                sleep(300);
            }
        }
        sendStep(tid, "prewatch", "done", preChanges.length ? ("预监视期变化 " + preChanges.length + " 次") : "基线稳定");

        // —— 高频窗口 ——
        var pollMs = 10;
        sendStep(tid, "mutation", "start", "poll=" + pollMs + "ms");

        // (彩排分支已上移到"迟到保护"之后: 不做变化检测, 到点直接真打)

        // 实时首击: 每轮读信号与基线比对 —— 一变即发 (双读确认防单次读异常)
        var fired = null;
        var firstCheck = true;
        var invalidStreak = 0;
        var anomalyLogged = false;
        var hotLastLog = 0;
        var pollCount = 0;
        while (true) {
            if (isCancelled(tid)) {
                sendStep(tid, "mutation", "failed", "手动终止 (未击发)");
                return { fired: false, cancelled: true };
            }
            var s = readButtonSignal();
            if (s.hasContainer) {
                invalidStreak = 0;
            } else if (s.tvText === "-" && !s.buy && !s.buv) {
                invalidStreak++;
                if (invalidStreak === 40 && !anomalyLogged) {
                    anomalyLogged = true;
                    Transport.sendEvent(tid, "signal_anomaly", { sig: s.sig });
                    sendLog(tid, "[高频] ⚠ 按钮容器暂时不可读 (连续 " + invalidStreak + " 次), 继续盯梢");
                }
            }
            if (signalChangedFrom(s, anchor)) {
                sleep(80);
                var s2 = readButtonSignal();
                if (signalChangedFrom(s2, anchor)) {
                    var cause = (firstCheck && preChanges.length > 0) ? "mutation_prewatch_persisted" : "mutation";
                    fired = this.emitFirstTap(anchor, tid, fireAt, offset, cause);
                    break;
                }
            }
            firstCheck = false;
            // 第三重兜底: 文案扫描（每 ~100ms 一次, 一次遍历取全部文本, 便宜）
            pollCount++;
            if (pollCount % 10 === 0) {
                var tcur = scanTexts();
                if (textSignalFired(tcur, anchor.texts)) {
                    sleep(80);
                    var tcur2 = scanTexts();
                    if (textSignalFired(tcur2, anchor.texts)) {
                        sendLog(tid, "[首击] 文案兜底命中(开售后字样出现/开抢字样消失): " + tcur.sample);
                        Transport.sendEvent(tid, "text_signal_fire", { base: anchor.texts, now: tcur, sig: s.sig });
                        fired = this.emitFirstTap(anchor, tid, fireAt, offset, "text_signal");
                        break;
                    }
                }
            }
            if (now() > fireLocal + CLICK_CFG.watchHardCapMs) {
                // 兜底闸门（**不是观察窗**，2026-10-09 用户拍板移除观察窗, 闸门上限 1 分钟）:
                //   作用只是防任务永久挂住, 绝不提前放弃 —— 正常开售几秒内就会命中结构变化。
                Transport.sendEvent(tid, "watch_timeout", { waitedMs: CLICK_CFG.watchHardCapMs, sig: s.sig, presale: s.presale });
                sendLog(tid, "[首击] ⏱ 已连续盯梢 " + Math.round(CLICK_CFG.watchHardCapMs / 1000) + " 秒仍未检测到结构变化, 收工防挂死");
                // 留证据: 界面树 + 截图 (事后复盘"为什么没识别到")
                var diag = Transport.diagSnapshot("timeout-" + tid);
                if (diag && diag.files && diag.files.length) {
                    sendLog(tid, "[诊断] 已存证据 " + diag.files.map(function (f) { return f.split(/[\\/]/).pop(); }).join(" + "));
                    Transport.sendEvent(tid, "diag_saved", { files: diag.files, sig: s.sig });
                } else {
                    sendLog(tid, "[诊断] 证据保存失败(不影响结果): " + ((diag && (diag.dumpError || diag.shotError)) || "无回应"));
                }
                try { device.vibrate(400); } catch (eNV) {}
                sendStep(tid, "mutation", "failed", "盯梢超时(兜底闸门), 未点击");
                return { fired: false, watchTimeout: true, waitedMs: CLICK_CFG.watchHardCapMs };
            }
            if (now() - hotLastLog > 3000) {
                hotLastLog = now();
                sendLog(tid, "[高频] 盯梢中: " + s.sig + " (已盯 " + Math.round((now() - fireLocal) / 1000) + "s, 一有变化立即出手)");
            }
            sleep(pollMs);
        }
        sendStep(tid, "mutation", "done", "cause=" + fired.cause + " ΔT0=" + fired.deltaMs + "ms");
        sendStep(tid, "first_tap", "done", "ΔT0 " + fired.deltaMs + "ms via=" + (fired.via ? "persist" : "exec"));
        return { fired: true, cause: fired.cause, deltaMs: fired.deltaMs, cancelled: false };
    },

    /**
     * 抖动连点链 (2026-10-09 合并: 原「拟人连点 + 提交风暴」两段合一)
     * 一条循环打到底: 按页面状态自动切换瞄准目标 ——
     *   还在详情页 → 瞄底栏主按钮(锚点); 已跳进选票/订单页 → 瞄「确定 / 提交订单」实节点。
     * 节拍统一走 humanTap + humanGapMs (间隔/按压/落点全抖动, ≤20 击/秒)。
     * 终止: 出支付页 / 售罄 / 滑块 / 页面异常切换 / 总时长到 / 连续 3 次注入失败 / 手动终止。
     */
    grabChain: function(task, anchor, tid) {
        var grab = (task && task.grab) || {};
        var hammer = !!grab.hammer;
        var end = now() + CLICK_CFG.chainMs;
        var clicks = 0;
        var endReason = "";
        var failStreak = 0;
        var stamps = [];
        var peak = 0;
        // 2026-10-10 用户口径: **只有首击检测按钮变化; 连点链全程无脑高频, 不做任何识别判断**。
        //   瞄准 = 统一锚点 (立即预订/确定/立即提交 三键交集中心, 一个点通吃三个按钮), 热路径零树读取;
        //   识别全部挪去侧车线程 (弹窗处置 + 终态看护), 主链只认 CHAIN_CTL.stop 布尔。
        var aim = { x: anchor.cx, y: anchor.cy };
        if (grab.submit && !grab.button) {
            var sp = scaleToDevice(grab.submit, task);
            if (sp && sp.x > 0) aim = { x: sp.x, y: sp.y };
        }
        var jx = Math.min(CLICK_CFG.jitterXPx, GRAB_POINTS.jitterCap.x);
        var jy = Math.min(CLICK_CFG.jitterYPx, GRAB_POINTS.jitterCap.y);
        chainReset();
        startChainSidecar(task, anchor, tid, end);
        sendStep(tid, "tap_chain", "start", "无脑高频连点 " + CLICK_CFG.chainMs + "ms (锚点 " + aim.x + "," + aim.y
            + " 抖动 ≤" + jx + "/" + jy + "px, 侧车盯弹窗+终态)");
        if (hammer) Transport.sendEvent(tid, "grab_blind_mode", { clicks: 0, reason: "配置为无脑高频模式" });

        while (now() < end) {
            if (isCancelled(tid)) { CHAIN_CTL.sidecarDone = true; sendStep(tid, "tap_chain", "failed", "手动终止"); return { cancelled: true, clicks: clicks }; }
            if (CHAIN_CTL.stop) { endReason = CHAIN_CTL.stopReason; break; }

            var okTap = humanTap(aim.x, aim.y, jx, jy);
            markTapFired();
            if (!okTap) {
                failStreak++;
                if (failStreak >= 3) { endReason = "adb_down"; break; }
            } else {
                failStreak = 0;
            }
            clicks++;
            stamps.push(now());
            if (stamps.length > 40) stamps.shift();
            var pk = peakPerSec(stamps);
            if (pk > peak) peak = pk;
            // ★ 全局击发间距: 与侧车共享 TAP_SPACING, 任意两击 ≥50ms → 合计硬上限 20 击/秒 (防超频风控)
            waitTapSlot(Math.max(50, humanGapMs()));
        }
        CHAIN_CTL.sidecarDone = true;
        if (!endReason) endReason = "timeout";
        Transport.sendEvent(tid, "submit_tap_loop", {
            stormClicks: clicks, totalClicks: clicks, endReason: endReason, peakPerSec: peak,
            popupClicks: CHAIN_CTL.popupClicks, aim: aim, jitter: { x: jx, y: jy }
        });
        if (endReason === "ordered") {
            sendStep(tid, "tap_chain", "done", "已进入支付/成功页 (" + clicks + " 击, 峰值 " + peak + "/秒, 弹窗补击 " + CHAIN_CTL.popupClicks + ")");
        } else if (endReason === "captcha") {
            sendStep(tid, "tap_chain", "failed", "出现滑块验证码, 需人工介入 (" + clicks + " 击)");
            try { device.vibrate(500); } catch (eVB) {}
        } else if (endReason === "no_stock") {
            sendStep(tid, "tap_chain", "failed", "已售罄/无票 (" + clicks + " 击)");
        } else {
            sendStep(tid, "tap_chain", "failed", "连点结束: " + endReason + " (" + clicks + " 击, 峰值 " + peak + "/秒, 弹窗补击 " + CHAIN_CTL.popupClicks + ")");
        }
        return { cancelled: false, clicks: clicks, endReason: endReason, peakPerSec: peak };
    },

    /**
     * 检测通道自测 (布防前验证"变化必被发现"):
     *   1) 按钮区域基线稳定性采样 3 秒 (同时统计读取速率)
     *   2) 触发一次真实变化 (底栏「想看」↔「已想看」), 测发现延迟, 测完自动还原
     */
    grabSelfTest: function(task, anchor, tid) {
        sendStep(tid, "selftest", "start");
        var base = readButtonSignal().sig;
        var t0 = now();
        var reads = 0;
        var changes = 0;
        while (now() - t0 < 3000) {
            if (isCancelled(tid)) break;
            if (readButtonSignal().sig !== base) changes++;
            reads++;
            sleep(8);
        }
        var readsPerSec = Math.round(reads / Math.max(0.001, (now() - t0) / 1000));

        var detectMs = -1;
        var before = null, after = null;
        try {
            var node = quickFind(id("cn.damai:id/project_item_bottom_follow_text_tv_concert_type"));
            before = node && node.text ? String(node.text()) : null;
            var fl = quickFind(id("cn.damai:id/project_item_bottom_want_to_see_fl"));
            if (fl && fl.bounds && before) {
                var fb = fl.bounds();
                var fx = Math.floor(fb.centerX()), fy = Math.floor(fb.centerY());
                var tTap = now();
                adbPress(fx, fy, 40);   // ★ 统一通道: ADB 优先, WiFi 回落本地手势 (不再直接调 adbTap 卡死自测)
                var dl = now() + 3000;
                while (now() < dl) {
                    if (isCancelled(tid)) break;
                    var n2 = quickFind(id("cn.damai:id/project_item_bottom_follow_text_tv_concert_type"));
                    var cur = n2 && n2.text ? String(n2.text()) : null;
                    if (cur && cur !== before) { detectMs = now() - tTap; after = cur; break; }
                    sleep(6);
                }
                if (detectMs >= 0) adbPress(fx, fy, 40); // 还原想看状态
            }
        } catch (eST) {}

        var payload = { baselineChanges: changes, readsPerSec: readsPerSec, detectMs: detectMs, before: before, after: after };
        Transport.sendEvent(tid, "selftest_result", payload);
        sendStep(tid, "selftest", "done", "基线变化 " + changes + " 次 · 读取 " + readsPerSec + " 次/秒 · 发现延迟 " + detectMs + "ms");
        return payload;
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
    //    顺带: ① 重挂屏幕常亮 (keepScreenOn 只保 1 小时, 长时间布防会悄悄到期 → 手机锁屏读不到界面)
    //          ② 冲刷结果发件箱 (中枢临时不可达时, 任务结果落地重发, 控制台不再永远"执行中")
    setInterval(function() {
        try { if (typeof device !== "undefined" && device.keepScreenOn) device.keepScreenOn(3600 * 1000); } catch (eK) {}
        try { Transport.sendHeartbeat(Transport.taskState || "idle", Transport.currentTaskId || null); } catch (eH) {}
        try { Transport.flushOutbox(); } catch (eO) {}
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
        if (Transport.restartRequested) { Transport.restartRequested = false; restartEngine("收到中枢重启指令 (脚本已由 USB 推送)"); }
        if (Transport.stopRequested) { Transport.stopRequested = false; stopAgentNow(); }
    } catch (e) {
        console.error("【控制】指令消费异常: " + (e ? (e.message || e) : "?"));
    }
}

/**
 * 引擎级自重启 (2026-10-10): 只重启脚本引擎, **绝不 force-stop 应用** → 无障碍永不被触碰。
 * 用于 USB 更新脚本后加载新代码 (文件已由中枢推好, 无需再下载)。
 * ★ 入口一律用规范部署路径 /sdcard/qg-agent/main.js —— 实测踩坑: 经编辑器等方式启动的引擎,
 *   myEngine().source 可能指向过期副本, 换引擎后跑的还是旧代码 (version/体积对账永远失败)。
 */
function scriptEntry() {
    var canonical = "/sdcard/qg-agent/main.js";
    try { if (files.exists(canonical) && Transport.fileSizeBytes(canonical) > 1000) return canonical; } catch (eC) {}
    try {
        var src = String(engines.myEngine().source);
        if (src.slice(-3) === ".js" && files.exists(src)) return src;
    } catch (e0) {}
    return canonical;
}

function restartEngine(reason) {
    console.log("【自重启】" + reason + ", 换引擎加载最新脚本…");
    try { Transport.sendEvent(null, "log", { msg: "【自重启】" + reason + ", 换引擎加载最新脚本" }); } catch (e0) {}
    try {
        engines.execScriptFile(scriptEntry());   // 先起新引擎 (新代码先跑起来)
        sleep(600);
        engines.myEngine().forceStop();          // 再停旧引擎
    } catch (e1) {
        console.warn("【自重启】失败, 请手动重开脚本: " + (e1 ? (e1.message || e1) : "?"));
        try { Transport.sendEvent(null, "log", { msg: "【自重启】失败, 请手动重开脚本: " + (e1 ? (e1.message || e1) : "?") }); } catch (e2) {}
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
        engines.execScriptFile(scriptEntry());   // 先起新引擎 (新代码先跑起来)
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
            } else if (mode === "test" || mode === "dryrun" || mode === "buy") {
                // 安全演练 / 立即购买 (直通流; 旧 rush 全自动流程已下线)
                executeDamaiRush(task);
            } else {
                // ★ 2026-10-10 修复: 未知模式**绝不兜成演练** —— 旧版会掉进 executeDamaiRush,
                //   导致"打开商品页(phone_op)被当成一键安全演练整条跑出来"的低级事故
                console.error("【拒绝任务】未知任务模式: " + mode + " (手机脚本与中枢版本不匹配? 请更新手机脚本)");
                Transport.sendResult({
                    taskId: task.taskId,
                    platform: "damai",
                    outcome: "failed",
                    reason: "unknown_mode",
                    evidence: "未知任务模式: " + mode + " — 手机脚本过旧, 请在控制台「更新手机脚本并重启」"
                });
            }
        } else {
            console.warn("暂未实现的平台适配器: " + platform);
            // 未实现平台也必须回结果 —— 否则中枢侧该任务永远显示"执行中"
            Transport.sendResult({
                taskId: task.taskId,
                platform: platform,
                outcome: "failed",
                reason: "unsupported_platform",
                evidence: "手机端暂未实现平台适配器: " + platform
            });
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
    //    巡演切站救援: deep-link 只能落默认站, 核对失败且任务是巡演子站 → 点站点卡切换后重核 (2026-10-10)
    var verify = DamaiAdapter.grabVerify(task, tid);
    if (!verify.ok && task.target && String(task.target.session || "").trim()) {
        console.log("[核对] 未通过, 尝试巡演切站救援 (目标站: " + task.target.session + ")");
        try { Transport.sendEvent(tid, "log", { msg: "[核对] 未通过, 尝试巡演切站救援 (目标站: " + task.target.session + ")" }); } catch (eL) {}
        if (DamaiAdapter.grabSwitchStation(task, tid)) {
            verify = DamaiAdapter.grabVerify(task, tid);
        }
    }
    if (!verify.ok) {
        Transport.sendResult({ taskId: tid, platform: "damai", outcome: "failed", reason: "page_verify_fail", evidence: "页面核对不通过 (含切站救援), 已拒绝操作" });
        return;
    }

    // 3. 信号锚定 (基线 + 按钮坐标, 热路径零查找)
    var anchor = DamaiAdapter.grabAnchor(task, verify, tid);
    if (!anchor.ok) {
        Transport.sendResult({ taskId: tid, platform: "damai", outcome: "failed", reason: "anchor_failed", evidence: "无法锚定按钮坐标 (容器缺失且未配置)" });
        return;
    }

    // 4. 服务器对时 + T0 三源交叉核对 (证据埋点: 手机↔大麦 / 手机↔电脑 / 页面开售文案 vs 填写的开抢时间)
    var sync = TimeSync.syncDamai();
    var syncEvidence = {
        damaiOffsetMs: sync.offset, damaiRttMs: sync.rtt,
        hubOffsetMs: (typeof Transport.hubOffsetMs === "number") ? Transport.hubOffsetMs : null,
        hubRttMs: (typeof Transport.hubRttMs === "number") ? Transport.hubRttMs : null
    };
    // 页面 "X月X日 HH:MM开抢" 与任务 T0 的交叉核对 (差 > 60s 告警 —— 防止用户填错时间/抢错批次)
    try {
        var sellText = DamaiAdapter.grabReadSellTime();
        if (sellText) {
            var mSell = String(sellText).match(/(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
            if (mSell) {
                var dSell = new Date();
                dSell.setMonth(parseInt(mSell[1], 10) - 1, parseInt(mSell[2], 10));
                dSell.setHours(parseInt(mSell[3], 10), parseInt(mSell[4], 10), 0, 0);
                var driftMs = dSell.getTime() - (task.timing.fireAtEpochMs - sync.offset);
                syncEvidence.pageSellText = sellText;
                syncEvidence.pageVsT0Ms = driftMs;
                if (Math.abs(driftMs) > 60000) {
                    console.warn("【对时核对】⚠ 页面开售时间与填写的开抢时间相差 " + Math.round(driftMs / 1000) + "s, 请确认抢的是不是同一场!");
                    Transport.sendEvent(tid, "t0_mismatch", { sellText: sellText, driftMs: driftMs });
                }
            }
        }
    } catch (eSell) {}
    Transport.sendEvent(tid, "timesync_done", syncEvidence);
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
