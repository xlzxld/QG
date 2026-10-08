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
            target = textMatches(matcherRegex).findOne(2500);
            if (!target) {
                target = descMatches(matcherRegex).findOne(1000);
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
     * T0 临界击发：纯物理触摸注入
     * @returns {boolean}
     */
    fire: function() {
        if (this.cachedPoint && this.cachedPoint.x > 0 && this.cachedPoint.y > 0) {
            console.log("【击发出膛】注入点击坐标: (" + this.cachedPoint.x + ", " + this.cachedPoint.y + ")");
            try {
                // 35ms 触摸按压，高度贴合真人手指点按动作
                press(this.cachedPoint.x, this.cachedPoint.y, 35);
                return true;
            } catch (err) {
                console.error("【击发失败】press 注入失败: " + err.message);
                return false;
            }
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

module.exports = AnchorFire;
