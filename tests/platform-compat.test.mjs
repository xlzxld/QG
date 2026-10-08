import { describe, it, expect } from 'vitest';
import { getChromePath } from '../core/cdp-core.mjs';
import { killByPort, openBrowserUrl } from '../core/grab-launcher.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

describe('跨平台 (macOS Darwin / Windows Win32) 兼容性测试', () => {
  it('1. getChromePath 在各操作系统平台返回正确规范路径', () => {
    // macOS
    const macPath = getChromePath('darwin');
    expect(macPath).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

    // Windows
    const winPath = getChromePath('win32');
    expect(winPath).toMatch(/Chrome\\Application\\chrome\.exe$/i);

    // Linux
    const linuxPath = getChromePath('linux');
    expect(linuxPath).toBe('/usr/bin/google-chrome');
  });

  it('2. grab-launcher.mjs 导出了跨平台进程与浏览器助手', () => {
    expect(typeof killByPort).toBe('function');
    expect(typeof openBrowserUrl).toBe('function');
  });

  it('3. 验证所有 macOS 启动脚本与 .command 文件存在且格式规范', () => {
    const scripts = [
      'start.sh',
      '启动.command',
      'start-device-hub.sh',
      '启动-手机中枢.command',
      'stop.sh',
      '停止服务.command',
      path.join('tools', 'mobile', 'prepare-device.sh'),
      path.join('tools', 'mobile', 'prepare-device.command')
    ];

    for (const file of scripts) {
      const fullPath = path.join(ROOT, file);
      expect(fs.existsSync(fullPath)).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf8');
      expect(content.startsWith('#!/usr/bin/env bash')).toBe(true);
      expect(content).toContain('/opt/homebrew/bin');
    }
  });

  it('4. 验证核心配置文件和槽位文件路径拼接无 Windows 反斜杠硬编码', () => {
    const restartScript = fs.readFileSync(path.join(ROOT, 'tools', 'restart-slot-windows.mjs'), 'utf8');
    expect(restartScript).not.toContain("ROOT + 'data\\\\grab\\\\'");
    expect(restartScript).toContain("path.join(ROOT, 'data', 'grab'");
  });
});
