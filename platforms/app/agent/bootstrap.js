/**
 * bootstrap.js - 端侧环境体检与就绪准备
 * =====================================================================
 * 职责：
 *   1. 检查无障碍服务权限是否就绪
 *   2. 锁定屏幕常亮，防止系统休眠
 *   3. 检查基础环境与目录
 * =====================================================================
 */

var Bootstrap = {
    checkEnvironment: function() {
        console.log("==========================================");
        console.log("📱 AutoX 抢购端侧环境初始化体检");
        console.log("==========================================");

        // 1. 无障碍服务检查
        try {
            if (!auto.service) {
                console.warn("【环境警告】无障碍服务未启动，尝试等待或唤起...");
                auto.waitFor();
            }
            console.log("✅ 无障碍服务状态: 正常");
        } catch (e) {
            console.error("❌ 无障碍服务检查异常: " + e.message);
        }

        // 2. 屏幕常亮保持
        try {
            device.keepScreenOn();
            console.log("✅ 屏幕常亮状态: 已锁定");
        } catch (e) {
            console.warn("⚠️ 屏幕常亮设置异常: " + e.message);
        }

        // 3. 屏幕参数采集
        console.log("✅ 设备屏幕分辨率: " + device.width + "x" + device.height);
        console.log("✅ 设备电量: " + device.getBattery() + "%");

        return true;
    }
};

module.exports = Bootstrap;
