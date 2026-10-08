// ==UserScript==
// @name         TM 自检（华为页专用）
// @namespace    qp.selftest
// @version      1.0.0
// @description  最小自检：只在页面左上角留一个红字标记，不碰网络、不用 GM_*。用来判断油猴到底有没有执行脚本。
// @match        https://item.vmall.com/*
// @match        https://www.vmall.com/*
// @match        https://m.vmall.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* 上一次的教训：
   1) 这个文件漏写了 ==UserScript== metadata 块 → 油猴判「无效 / URL 不匹配」。
   2) 直接 document.body.appendChild 在 body 未就绪时会抛
      "Cannot read properties of null (reading 'appendChild')"，
      脚本静默死掉，页面上什么也看不到。
   下面两处都用 document.body || document.documentElement 兜底。 */

(function () {
  'use strict';
  const tag = document.createElement('div');
  tag.id = 'tm-selftest';
  tag.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:2147483647;' +
    'background:#c00;color:#fff;font:14px/1.6 monospace;padding:6px 10px;';
  tag.textContent = 'TM 自检: 已执行 @ ' + new Date().toLocaleTimeString();
  (document.body || document.documentElement).appendChild(tag);
  console.log('[TM-SELFTEST] executed, url=', location.href);
})();
