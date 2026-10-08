// ==UserScript==
// @name         TM 诊断（华为页专用·报告油猴为什么没执行）
// @namespace    qp.diag
// @version      1.0.0
// @description  在页面左上角打印「油猴是否执行了我」以及 GM_* / 跨域请求是否可用，用来定位脚本不生效的真正原因。
// @match        https://item.vmall.com/*
// @match        https://www.vmall.com/*
// @match        https://m.vmall.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/* 这个脚本存在的意义：
   上一轮 huawei.user.js 面板完全不出现，而脚本体本身零报错。
   本脚本把「油猴执行了没」「GM_* 有没有」「能不能连本机桥接」
   三件事分开报，从而定位是哪一层出问题。 */

(function () {
  'use strict';

  const rows = [];
  const add = (k, v, ok) => rows.push({ k, v, ok });

  add('油猴执行了本脚本', 'YES（你看到这行就说明油猴正常工作）', true);

  // GM_* 是否真的存在（取决于 @grant 是否声明正确）
  add('GM_getValue', typeof GM_getValue, typeof GM_getValue === 'function');
  add('GM_setValue', typeof GM_setValue, typeof GM_setValue === 'function');
  add('GM_xmlhttpRequest', typeof GM_xmlhttpRequest, typeof GM_xmlhttpRequest === 'function');

  // 存储读写往返测试
  try {
    GM_setValue('__diag', 'ok');
    const v = GM_getValue('__diag');
    add('GM 存储往返', `写入后读回 = ${JSON.stringify(v)}`, v === 'ok');
  } catch (e) {
    add('GM 存储往返', '抛错: ' + e.message, false);
  }

  // 渲染面板。用 document.body || document.documentElement 兜底：
  // body 未就绪时直接 appendChild 会抛错，脚本静默死掉，什么都看不到。
  const box = document.createElement('div');
  box.id = 'tm-diag';
  box.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:2147483647;max-width:640px;' +
    'background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;' +
    'padding:10px 12px;font:12px/1.6 ui-monospace,Consolas,monospace;';
  (document.body || document.documentElement).appendChild(box);

  const render = () => {
    box.innerHTML =
      '<b style="color:#58a6ff">TM 诊断</b>' +
      '<div style="color:#8b949e">' + location.href + '</div>' +
      rows
        .map(
          (r) =>
            `<div style="color:${r.ok ? '#3fb950' : '#f85149'}">` +
            `${r.ok ? '✓' : '✗'} ${r.k}: ${r.v}</div>`,
        )
        .join('');
  };

  // 连本机桥接 —— 这是最容易出问题的一环
  const BRIDGE = 'http://127.0.0.1:3100';
  const pending = { done: false };

  const timer = setTimeout(() => {
    if (!pending.done) {
      add('连桥接 ' + BRIDGE, '8 秒无响应（被拦截或服务未启动）', false);
      render();
    }
  }, 8000);

  try {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${BRIDGE}/health`,
      timeout: 7000,
      onload: (res) => {
        pending.done = true;
        clearTimeout(timer);
        add('连桥接 ' + BRIDGE, `HTTP ${res.status}`, res.status === 200);
        render();
      },
      onerror: () => {
        pending.done = true;
        clearTimeout(timer);
        add('连桥接 ' + BRIDGE, 'onerror（跨域被拦 / 服务未启动 / 混合内容）', false);
        render();
      },
      ontimeout: () => {
        pending.done = true;
        clearTimeout(timer);
        add('连桥接 ' + BRIDGE, 'ontimeout（超时）', false);
        render();
      },
    });
  } catch (e) {
    clearTimeout(timer);
    add('连桥接 ' + BRIDGE, '同步抛错: ' + e.message, false);
  }

  render();
  console.log('[TM-DIAG] rows=', JSON.stringify(rows));
})();
