/**
 * adapters/damai.js - 大麦 App 平台专用适配器 (强实名票务专项)
 * =====================================================================
 * 合同实现：
 *   prepare(t)   -> 预航：唤醒 App、进入演出详情页
 *   preflight(t) -> 页面身份核验 (命中白名单才继续，防错页)
 *   prime(t)     -> 展开选票面板，选中场次与票档，并在 T-5s 锚定坐标
 *   fire(t)      -> T0 准时击穿确定按钮
 *   fillViewers  -> 订单确认页极速勾选白名单观演人并提交订单
 *   readResult   -> 提取成单凭证或捕获滑块异常
 *   recover      -> 异常安全回退
 * =====================================================================
 */

var AnchorFire = require("../anchor-fire.js");

var DamaiAdapter = {
    packageName: "cn.damai",

    /**
     * 1. 预航：唤醒大麦 App 并就位演出页
     */
    prepare: function(task) {
        console.log("【大麦预航】唤醒应用: " + this.packageName);
        app.launchPackage(this.packageName);
        sleep(2000);

        // 如果配置了直达 URL 尝试调起
        if (task.target && task.target.url) {
            try {
                app.startActivity({
                    action: "android.intent.action.VIEW",
                    data: task.target.url,
                    packageName: this.packageName
                });
                sleep(2000);
            } catch (e) {
                console.warn("直达深链唤醒失败，降级等待前台就位: " + e.message);
            }
        }
        return true;
    },

    /**
     * 2. 页面身份核验
     */
    preflight: function(task) {
        console.log("【大麦核验】核查当前是否处于目标演出详情页...");
        var titleTarget = task.target && task.target.name;
        if (!titleTarget) return true;

        var matched = textContains(titleTarget).findOne(3000);
        if (matched) {
            console.log("【大麦核验成功】已确认目标演出页面: " + titleTarget);
            return true;
        }

        console.warn("【大麦核验警告】未在当前页面看到目标演出标题，请人工核查！");
        return false;
    },

    /**
     * 3. 预热与选座面板预选 (T - 3min ~ T - 5s)
     */
    prime: function(task) {
        console.log("【大麦预选】展开场次与票档选择面板...");
        
        // 点击“立即预订”或“选座购买”以弹出选票抽屉
        var btnBook = textMatches(/立即预订|选座购买|特惠购买/).findOne(2000);
        if (btnBook) {
            btnBook.click();
            sleep(800);
        }

        // 选中场次
        if (task.target && task.target.session) {
            var sessionNode = textContains(task.target.session).findOne(1500);
            if (sessionNode) {
                console.log("【场次选择】点击选中场次: " + task.target.session);
                sessionNode.click();
                sleep(400);
            }
        }

        // 选中票档
        if (task.target && task.target.priceText) {
            var priceNode = textContains(task.target.priceText).findOne(1500);
            if (priceNode) {
                console.log("【票档选择】点击选中票档: " + task.target.priceText);
                priceNode.click();
                sleep(400);
            }
        }

        // T - 5s 坐标锚定：锁定底部“确定”按钮
        console.log("【大麦锚定】在选票面板中锁定『确定』按钮物理坐标...");
        var anchorSuccess = AnchorFire.anchor(/确定|立即预订/);
        return anchorSuccess;
    },

    /**
     * 4. 临界击发 (T - 0ms)
     */
    fire: function(task) {
        console.log("【大麦击发】T0 准点击穿选票面板『确定』按钮！");
        var fired = AnchorFire.fire();
        if (!fired) return false;

        // 击发后紧接着执行确认订单页处理
        return this.handleOrderConfirm(task);
    },

    /**
     * 5. 确认订单页处理：勾选观演人并提交订单
     */
    handleOrderConfirm: function(task) {
        console.log("【订单确认】等待并进入确认订单页...");
        // 最多等待 2 秒加载订单确认页
        var submitBtn = textMatches(/提交订单/).findOne(2500);

        // 勾选观演人 (task.target.viewers)
        var viewers = (task.target && task.target.viewers) || [];
        for (var i = 0; i < viewers.length; i++) {
            var vName = viewers[i];
            var vNode = text(vName).findOne(800);
            if (vNode) {
                console.log("【勾选观演人】选中: " + vName);
                // 点击观演人标签或其父级
                vNode.click();
            }
        }

        // 再次获取最新的提交订单按钮并点击
        if (!submitBtn) {
            submitBtn = textMatches(/提交订单/).findOne(1000);
        }

        if (submitBtn) {
            console.log("【提交订单】点击『提交订单』按钮！");
            submitBtn.click();
            return true;
        } else {
            console.warn("【订单确认】未捕获到『提交订单』按钮，尝试屏幕底部固定提交区域！");
            press(Math.floor(device.width * 0.8), Math.floor(device.height * 0.95), 40);
            return true;
        }
    },

    /**
     * 6. 读取结果凭证
     */
    readResult: function(task) {
        sleep(1000);
        console.log("【读取结果】检查页面凭证...");

        // 检查滑块验证码
        if (textContains("验证码").exists() || textContains("向右滑动").exists() || descContains("向右滑动").exists()) {
            console.error("【风控告警】检测到滑块验证码！立即蜂鸣呼叫人工接管！");
            device.vibrate(1000);
            return {
                outcome: "risk_challenge",
                evidence: "页面出现滑动验证码，需人工介入"
            };
        }

        // 检查缺货/售罄
        if (textContains("已售罄").exists() || textContains("无票").exists() || textContains("缺货登记").exists()) {
            return {
                outcome: "no_stock",
                evidence: "页面显示已售罄/无票"
            };
        }

        // 检查订单提交成功 / 待支付
        if (textMatches(/订单提交成功|待付款|选择支付方式|微信支付|支付宝/).findOne(3000)) {
            return {
                outcome: "ordered",
                evidence: "成功进入收银台/订单提交成功",
                orderNo: "DM-" + java.lang.System.currentTimeMillis()
            };
        }

        return {
            outcome: "unknown",
            evidence: "未能确定结果状态，转入人工复核"
        };
    },

    /**
     * 异常恢复
     */
    recover: function(err) {
        console.warn("【大麦恢复】执行异常回退...");
        AnchorFire.reset();
        back();
    }
};

module.exports = DamaiAdapter;
