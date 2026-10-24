/* Keyboard isolation for the chat panel.
 *
 * The panel lives in an open shadow root. Page shortcuts registered with
 * `document.addEventListener('keydown', fn, true)` run before the shadow root
 * can stop them, and shadow retargeting makes `event.target` look like our host
 * div instead of the input. This guard runs on `window` in the capture phase,
 * installed at document_start, so it is ahead of page listeners.
 *
 * It only intercepts events whose composed path contains our panel and whose
 * real target is editable. Stopping propagation here does not cancel the
 * browser's default text input; Enter/Escape are forwarded to the panel.
 */
(function () {
  'use strict';

  if (window.__smKeyboardGuard) return;

  var PANEL_HOST_ID = 'sm-buddy-panel-host';
  var handlers = { enter: null, escape: null };

  function editableTarget(event) {
    var host = document.getElementById(PANEL_HOST_ID);
    if (!host) return null;

    var path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.indexOf(host) === -1) return null;

    var target = path[0] || event.target;
    if (!target || !target.tagName) return null;

    var tag = target.tagName;
    if (tag === 'TEXTAREA') return target;
    if (tag === 'INPUT') {
      var type = String(target.type || 'text').toLowerCase();
      return /^(text|search|url|tel|email|password|number)$/.test(type) ? target : null;
    }
    return target.isContentEditable ? target : null;
  }

  function onKey(event) {
    var target = editableTarget(event);
    if (!target) return;

    if (event.type === 'keydown') {
      if (event.key === 'Escape' && !event.isComposing) {
        if (handlers.escape) handlers.escape();
        event.preventDefault();
      } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        if (handlers.enter) handlers.enter();
        event.preventDefault();
      }
    }

    // Stop page capture/bubble listeners. Do not preventDefault for ordinary
    // typing: the browser still inserts the character into the focused input.
    event.stopImmediatePropagation();
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('keypress', onKey, true);

  window.__smKeyboardGuard = {
    setHandlers: function (next) {
      if (!next) return;
      if (typeof next.enter === 'function') handlers.enter = next.enter;
      if (typeof next.escape === 'function') handlers.escape = next.escape;
    },
    clearHandlers: function () {
      handlers.enter = null;
      handlers.escape = null;
    },
  };
})();
