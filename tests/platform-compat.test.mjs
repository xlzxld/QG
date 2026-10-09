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

  it('5. Windows .bat 启动脚本：CRLF 换行 + 编码安全（纯 ASCII 或 GBK+chcp 936）', () => {
    const bats = [
      '启动.bat',
      '停止服务.bat',
      '重启服务.bat',
      '启动-手机中枢.bat',
      '停止抢购中枢.bat',
      '自检-Windows环境.bat',
      '今早抢购-手动武装.bat',
      path.join('tools', 'mobile', 'prepare-device.bat'),
    ];
    for (const file of bats) {
      const fullPath = path.join(ROOT, file);
      expect(fs.existsSync(fullPath), `${file} 应存在`).toBe(true);
      const buf = fs.readFileSync(fullPath);
      const raw = buf.toString('latin1'); // 逐字节透明视图

      // 1) 不允许裸 LF —— 必须 CRLF
      expect(/(?<!\r)\n/.test(raw), `${file} 存在单独的 LF，应统一为 CRLF`).toBe(false);

      // 2) 不允许 UTF-8 BOM（会顶掉第一行 @echo off）
      const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      expect(hasBom, `${file} 不应带 UTF-8 BOM`).toBe(false);

      // 3) 非 ASCII 内容 ⇒ 必须 GBK 可解码 + chcp 936，且不得 chcp 65001
      const hasNonAscii = /[^\x00-\x7f]/.test(raw);
      if (hasNonAscii) {
        let decodable = true;
        try {
          new TextDecoder('gbk', { fatal: true }).decode(buf);
        } catch {
          decodable = false;
        }
        expect(decodable, `${file} 含非 ASCII 但非合法 GBK —— 疑似 UTF-8 中文陷阱`).toBe(true);
        expect(raw).toContain('chcp 936');
        expect(raw).not.toContain('chcp 65001');
      }
    }
  });
});
