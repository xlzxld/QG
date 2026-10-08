/**
 * core/dom-engine.mjs
 * =====================================================================
 * 通用弹性降级 DOM 交互引擎 (Universal Resilient DOM Engine)
 *
 * 核心设计思想（沉淀自各类抢购与自动化实战经验）：
 *   1. 优先级候选队列 (Candidate Fallback Queue)：按数组顺序尝试多组选择器/文本，
 *      首个可见即可交互的元素胜出，消除前端样式或文案微调导致的脚本中断。
 *   2. 三级级联降级策略 (Cascade 3-Tier Selection)：
 *      - 第一级：精准结构化类选择器（最快、最准）
 *      - 第二级：容器内文本/正则模糊搜索（抵御类名 hash/混淆）
 *      - 第三级：首项可用项兜底（防止缺省项漏选）
 *   3. 抗噪文本正则 (Noise-Tolerant Text Matching)：
 *      自动为中文关键字注入空白容忍正则（如 "确\s*定"），抵御前端样式插值。
 *   4. 幂等状态控制 (Idempotent Control)：
 *      对 checkbox 采用“先读状态再决定是否操作”的幂等机制，杜绝二次点击反向取消。
 *   5. 步进器保护 (Safe Stepper Control)：
 *      按差额增量点击，异常或已达上限即刻跳出。
 *
 * 适用场景：
 *   - 通过 CDP Runtime.evaluate 注入到页面执行；
 *   - 编译/复制到油猴脚本中作为底层 DOM 工具集；
 *   - 通用于华为商城、秀动、大麦、苹果等所有 Web 项目。
 * =====================================================================
 */

/**
 * 默认抗噪正则生成器：将连续字符转为抗任意空白符的正则表达式
 * 例: "确定" -> /确[\s\u00a0]*定/
 */
export function buildFuzzyRegex(text) {
  if (!text || typeof text !== 'string') return /(?:)/;
  const escaped = text.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('[\\s\\u00a0]*'));
}

/**
 * 注入到浏览器环境的通用 DOM 辅助工具库代码（纯原生 JS，零外部依赖）
 */
export const BROWSER_DOM_HELPERS = `
var QG_DOM = (function() {
  function clean(s) {
    return (s || '').replace(/[\\s\\u00a0]+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    if (el.hasAttribute('disabled')) return false;
    if (typeof el.className === 'string' && /disabled|is-disabled|btn-disabled/i.test(el.className)) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  function getLeafText(el) {
    if (!el) return '';
    return clean(el.innerText || el.textContent || '');
  }

  function findByCandidate(candidate, root) {
    root = root || document;
    if (!candidate) return null;

    // 1. 若为 CSS 选择器
    if (typeof candidate === 'string' && (candidate.startsWith('.') || candidate.startsWith('#') || candidate.startsWith('[') || candidate.includes(' '))) {
      try {
        var matches = root.querySelectorAll(candidate);
        for (var i = 0; i < matches.length; i++) {
          if (isVisible(matches[i])) return matches[i];
        }
      } catch (e) {}
    }

    // 2. 若为文本关键字或常规标签选择器
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var node = all[j];
      if (!isVisible(node)) continue;
      var text = getLeafText(node);
      if (!text) continue;

      if (typeof candidate === 'string' && (text === candidate || text.includes(candidate))) {
        // 优先叶子节点或文字紧凑的容器
        if (node.children.length <= 1) return node;
      }
    }
    return null;
  }

  function clickFirst(candidates, root) {
    if (!Array.isArray(candidates)) candidates = [candidates];
    for (var i = 0; i < candidates.length; i++) {
      var hit = findByCandidate(candidates[i], root);
      if (hit) {
        try {
          hit.scrollIntoView({ block: 'center', inline: 'center' });
        } catch (e) {}
        hit.click();
        return { success: true, matched: candidates[i] };
      }
    }
    return { success: false, matched: null };
  }

  function cascadeSelect(options) {
    options = options || {};
    var root = options.container ? document.querySelector(options.container) : document;
    if (!root) return { success: false, tier: null };

    // 1级：精准选择器
    if (options.exactSelector) {
      try {
        var exacts = root.querySelectorAll(options.exactSelector);
        for (var i = 0; i < exacts.length; i++) {
          if (isVisible(exacts[i])) {
            exacts[i].click();
            return { success: true, tier: 1 };
          }
        }
      } catch (e) {}
    }

    // 2级：容器内文本模糊搜索
    if (options.textKeyword) {
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (!isVisible(el) || el.children.length > 1) continue;
        var t = getLeafText(el);
        if (t && t.includes(options.textKeyword)) {
          el.click();
          return { success: true, tier: 2 };
        }
      }
    }

    // 3级：首项可用项兜底
    if (options.fallbackSelector) {
      try {
        var def = root.querySelector(options.fallbackSelector);
        if (def && isVisible(def)) {
          def.click();
          return { success: true, tier: 3 };
        }
      } catch (e) {}
    }

    return { success: false, tier: null };
  }

  function ensureCheckbox(candidate, targetChecked) {
    if (targetChecked === undefined) targetChecked = true;
    var el = findByCandidate(candidate);
    if (!el) return { success: false, error: 'NOT_FOUND' };

    var box = el.tagName === 'INPUT' && el.type === 'checkbox' ? el : el.querySelector('input[type="checkbox"]');
    if (box) {
      if (box.checked !== targetChecked) {
        box.click();
        return { success: true, changed: true };
      }
      return { success: true, changed: false };
    }

    // 若无 input，直接点击包裹元素（如 label）
    el.click();
    return { success: true, changed: true };
  }

  function stepCounter(plusCandidate, targetCount, currentCount) {
    targetCount = Math.max(1, parseInt(targetCount, 10) || 1);
    currentCount = Math.max(1, parseInt(currentCount, 10) || 1);
    var diff = targetCount - currentCount;
    if (diff <= 0) return { success: true, clicks: 0 };

    var plusBtn = findByCandidate(plusCandidate);
    if (!plusBtn) return { success: false, clicks: 0, error: 'PLUS_NOT_FOUND' };

    var clicked = 0;
    for (var i = 0; i < diff; i++) {
      try {
        plusBtn.click();
        clicked++;
      } catch (e) { break; }
    }
    return { success: true, clicks: clicked };
  }

  return {
    clean: clean,
    isVisible: isVisible,
    findByCandidate: findByCandidate,
    clickFirst: clickFirst,
    cascadeSelect: cascadeSelect,
    ensureCheckbox: ensureCheckbox,
    stepCounter: stepCounter
  };
})();
`;

/**
 * 组合生成带 QG_DOM 运行时的 CDP 评估执行脚本
 * @param {string} userFunctionBody 自定义执行逻辑（内部可直接访问 QG_DOM）
 * @returns {string} 可传给 cdp.eval() 的自执行脚本
 */
export function buildDomEvalScript(userFunctionBody) {
  return `(() => {
    ${BROWSER_DOM_HELPERS}
    try {
      return (${userFunctionBody})(QG_DOM);
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  })()`;
}
