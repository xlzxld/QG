import { describe, it, expect, vi } from 'vitest';
import {
  blockHeavyResources,
  DEFAULT_BLOCKED_RESOURCE_PATTERNS
} from '../../core/cdp-core.mjs';
import {
  buildFuzzyRegex,
  buildDomEvalScript,
  BROWSER_DOM_HELPERS
} from '../../core/dom-engine.mjs';

describe('通用 Web 能力：重资源过滤与弹性级联 DOM 引擎', () => {
  describe('精华 3 通用化：CDP 重资源极速拦截 (blockHeavyResources)', () => {
    it('1. 默认包含图片、字体、音视频等核心重资源通配符', () => {
      expect(DEFAULT_BLOCKED_RESOURCE_PATTERNS).toContain('*.png');
      expect(DEFAULT_BLOCKED_RESOURCE_PATTERNS).toContain('*.jpg');
      expect(DEFAULT_BLOCKED_RESOURCE_PATTERNS).toContain('*.woff2');
      expect(DEFAULT_BLOCKED_RESOURCE_PATTERNS).toContain('*.mp4');
    });

    it('2. 正确向 CDP 发送 Network.setBlockedURLs 并支持扩展自定义规则', async () => {
      const calls = [];
      const mockCdp = {
        send: vi.fn(async (method, params) => {
          calls.push({ method, params });
          return {};
        })
      };

      await blockHeavyResources(mockCdp, ['*.banner_ad', '*analytics*']);

      expect(mockCdp.send).toHaveBeenCalledWith('Network.enable');
      expect(mockCdp.send).toHaveBeenCalledWith('Network.setBlockedURLs', {
        urls: expect.arrayContaining([
          ...DEFAULT_BLOCKED_RESOURCE_PATTERNS,
          '*.banner_ad',
          '*analytics*'
        ])
      });
    });
  });

  describe('精华 1 通用化：弹性级联 DOM 交互引擎 (dom-engine.mjs)', () => {
    it('1. buildFuzzyRegex 生成抗空格抗空白的中文正则', () => {
      const regConfirm = buildFuzzyRegex('确定');
      expect(regConfirm.test('确定')).toBe(true);
      expect(regConfirm.test('确 定')).toBe(true);
      expect(regConfirm.test('确\u00a0定')).toBe(true);
      expect(regConfirm.test('取消')).toBe(false);

      const regBuy = buildFuzzyRegex('立即购买');
      expect(regBuy.test('立即购买')).toBe(true);
      expect(regBuy.test('立 即 购 买')).toBe(true);
    });

    it('2. buildDomEvalScript 生成语法完备的可自执行浏览器代码', () => {
      const script = buildDomEvalScript(`(dom) => {
        return dom.clean('   hello   world   ');
      }`);

      expect(typeof script).toBe('string');
      // 验证脚本没有语法错误
      expect(() => new Function(script)).not.toThrow();

      // 在模拟简易 window/document 环境下执行验证
      const fakeGlobal = {
        window: { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) },
        document: { querySelectorAll: () => [] }
      };
      const runFn = new Function('window', 'document', `
        ${BROWSER_DOM_HELPERS};
        return QG_DOM.clean('   测试   多余 空白   ');
      `);
      const result = runFn(fakeGlobal.window, fakeGlobal.document);
      expect(result).toBe('测试 多余 空白');
    });

    it('3. QG_DOM 辅助函数定义完整', () => {
      expect(BROWSER_DOM_HELPERS).toContain('clickFirst');
      expect(BROWSER_DOM_HELPERS).toContain('cascadeSelect');
      expect(BROWSER_DOM_HELPERS).toContain('ensureCheckbox');
      expect(BROWSER_DOM_HELPERS).toContain('stepCounter');
    });
  });
});
