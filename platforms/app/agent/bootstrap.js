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

module.exports = Bootstrap;
