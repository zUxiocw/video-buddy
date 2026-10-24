/*
 * Voice and reaction guards shared by the server and the extension.
 *
 * Only the parts that need no Node built-ins live here: the 喵 tail, the
 * maomao style pass, the ad reaction lines, and the neutral fallbacks. The
 * denylist and the full analyze pipeline stay in server/src/safety/guards.ts —
 * they depend on node modules and on server-only types, and the extension has
 * no use for them.
 *
 * Classic-script shape for the same reason as persona.js: MV3 content scripts
 * cannot use ES modules, and the project forbids a build step.
 */
(function (root) {
  'use strict';

  var NEUTRAL_BY_TONE = {
    maomao: '这段没看明白，你说说哪里最离谱喵',
    roaster: '这段我有点没看准，你先说说你的感觉？',
    cheerleader: '这段我还没太看清，你跟我讲讲好不好？',
    professor: '画面信息不太够，我先不急着下结论，你说说看？',
  };

  /**
   * Append the 「喵」 tail to one finished utterance.
   *
   * This is a verbal tic, not an emotion signal: it must never feed back into
   * emotion detection, so it is added only after the text has been styled and
   * clamped. A model that already ended with 喵 is deduped instead of doubled.
   */
  function withMaoSuffix(text) {
    var trimmed = String(text == null ? '' : text).trim();
    if (!trimmed) return '';

    // Split off the trailing punctuation so the tail lands *before* it:
    // "真的假的？" becomes "真的假的喵？", not "真的假的？喵".
    var match = /^([\s\S]*?)([。，,、！!？?~～\s]*)$/.exec(trimmed);
    var tail = (match && match[2]) || '';
    var head = ((match && match[1]) || '').replace(/喵+$/, '').replace(/[。，,、\s]+$/, '').trim();

    // A reply that is nothing but punctuation ("？", "？？") is a deliberate
    // beat, not an utterance: tagging it with 喵 would read as a glitch.
    if (!head) return trimmed;
    return head + '喵' + tail;
  }

  /**
   * Post-process the 「上头了喵喵」 voice: no exclamation marks, tildes,
   * "哈哈/呵" or trailing 语气词. Meaning-preserving edits only.
   */
  function applyMaomaoStyle(text) {
    return String(text == null ? '' : text)
      .replace(/[~～]+/g, '')
      .replace(/(哈哈+|呵呵+|hhh+|233+)/gi, '')
      .replace(/([？?])[!！]+/g, '$1')
      .replace(/[!！]+([？?])/g, '$1')
      .replace(/[!！]+/g, '。')
      .replace(/(呢|啦|哦|嘛|呀|噢|哟)(?=[。，,、？?\s]|$)/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      // Collapse runs of 。， down to the first one. Matches the server's
      // original `[。，]{2,}` exactly — 、 and , are left alone.
      .replace(/[。，]{2,}/g, function (match) { return match.charAt(0); })
      .replace(/^[，,。、\s]+/, '')
      .replace(/[，,、\s]+$/, '')
      .replace(/。$/, '')
      .trim();
  }

  /**
   * An ad gets one fixed reaction: the cat is annoyed at being sold to.
   *
   * Fixed rather than generated on purpose — a "please buy this" video can be
   * friendly, useful or funny, and a model asked to react to it would sometimes
   * play along. Anger at the interruption is the honest, consistent response,
   * and it keeps the ad from ever looking like a recommendation.
   */
  var AD_REACTIONS = {
    // Each line carries an anger marker the client's content detection can read
    // (过分 / 气人), so the avatar turns angry even if the mood never gets there.
    maomao: '又塞广告，太过分了喵',
    roaster: '又来一条广告，真够可以的',
    cheerleader: '又是广告，这可真有点气人',
    professor: '广告，跳过比分析它有用，太过分了',
  };

  function adReaction(tone) {
    return AD_REACTIONS[tone] || AD_REACTIONS.roaster;
  }

  function neutralReaction(tone) {
    return NEUTRAL_BY_TONE[tone] || NEUTRAL_BY_TONE.roaster;
  }

  var api = {
    NEUTRAL_BY_TONE: NEUTRAL_BY_TONE,
    AD_REACTIONS: AD_REACTIONS,
    withMaoSuffix: withMaoSuffix,
    applyMaomaoStyle: applyMaomaoStyle,
    adReaction: adReaction,
    neutralReaction: neutralReaction,
  };

  root.SmGuards = api;
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
