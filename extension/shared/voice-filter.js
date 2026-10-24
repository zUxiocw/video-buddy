/*
 * Streaming-safe version of `applyMaomaoStyle`.
 *
 * Real models stream token by token, so forbidden patterns can straddle two
 * deltas ("哈哈" split as "哈" + "哈"). We hold back the last few characters
 * and only emit text that is old enough to be decided on.
 *
 * Depends on guards-core.js being loaded first (it reads globalThis.SmGuards).
 * In the extension that ordering is guaranteed by this file only being needed
 * on the server; the lazy lookup below keeps it correct either way.
 */
(function (root) {
  'use strict';

  var HOLD = 4;

  function guards() {
    var api = root.SmGuards;
    if (!api) throw new Error('voice-filter.js requires guards-core.js to be loaded first');
    return api;
  }

  function cleanChunk(text) {
    return text
      .replace(/[~～]+/g, '')
      .replace(/(哈哈+|呵呵+|hhh+|233+)/gi, '')
      .replace(/[`*]+/g, '')
      .replace(/\r?\n+/g, ' ')
      .replace(/([？?])[!！]+/g, '$1')
      .replace(/[!！]+([？?])/g, '$1')
      .replace(/[!！]+/g, '。')
      // No `$` here: the buffer end is not the reply end mid-stream.
      .replace(/(呢|啦|哦|嘛|呀|噢|哟)(?=[。，,、？?\s])/g, '')
      .replace(/[ \t]{2,}/g, ' ');
  }

  // 刷子喵喵 is the previous name: models warmed on the old persona sometimes
  // still self-label with it, so both are stripped.
  var SPEAKER_LABEL = /^\s*(上头了喵喵|刷子喵喵|喵喵|maomao)\s*[：:]\s*/i;
  var LABEL_NAMES = ['上头了喵喵', '刷子喵喵', '喵喵', 'maomao'];

  /** True while the buffered text could still become a "上头了喵喵：" label. */
  function mightBeLabel(text) {
    var head = text.trimStart().toLowerCase();
    if (!head) return true;
    if (/[：:]/.test(head)) return false;
    return LABEL_NAMES.some(function (name) {
      return name.startsWith(head) || head.startsWith(name);
    });
  }

  function createMaomaoStreamFilter() {
    var buffer = '';
    var started = false;
    // The tail end of everything already emitted. Needed by flush(): if the
    // model ended on characters we strip (e.g. "可爱~~~!!"), the final chunk is
    // empty and the 喵 has nowhere to attach, so it is sent on its own.
    var emitted = '';

    return {
      push: function (chunk) {
        buffer += chunk;

        if (!started) {
          // Hold briefly when the reply might start with "上头了喵喵：" so the
          // label is not emitted as content. Ordinary replies starting with 上
          // stop being ambiguous as soon as the second character differs.
          if (buffer.trim().length < 12 && mightBeLabel(buffer)) return '';
          buffer = buffer.replace(SPEAKER_LABEL, '');
          started = true;
        }

        if (buffer.length <= HOLD) return '';
        var head = buffer.slice(0, buffer.length - HOLD);
        buffer = buffer.slice(buffer.length - HOLD);
        var out = cleanChunk(head);
        if (out) emitted = out;
        return out;
      },
      flush: function () {
        var g = guards();
        var rest = buffer.replace(SPEAKER_LABEL, '');
        buffer = '';
        started = true;
        // flush() is the final slice of the reply, so the 喵 tail is safe to add
        // here: it lands once, at the end, after all forbidden patterns have
        // been cleaned out.
        var styled = g.applyMaomaoStyle(cleanChunk(rest));
        if (styled) return g.withMaoSuffix(styled);
        // Nothing survived the cleanup, but the reply did have a body. Attach
        // the tail to what was already sent rather than dropping it.
        return emitted ? '喵' : '';
      },
    };
  }

  var api = { createMaomaoStreamFilter: createMaomaoStreamFilter };

  root.SmVoiceFilter = api;
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
