/*
 * Text helpers shared by the server and the extension.
 *
 * These used to live in server/src/lib/text.ts. The BYOK path assembles
 * prompts in the browser, so it needs the exact same clamping and sanitising
 * rules; keeping two copies would let the client and server send prompts that
 * differ in ways nobody would notice until the model behaved oddly.
 *
 * Only the pure helpers are here. `hashShort` stays on the server because it
 * uses node:crypto and is only used for device keys and idempotency keys, which
 * never leave the server. The browser gets `seed()` instead, an FNV-1a fold
 * used for nothing but picking among tied emotions.
 */
(function (root) {
  'use strict';

  /** Collapse control characters and whitespace, then hard-truncate. */
  function clampText(value, maxLength) {
    if (typeof value !== 'string') return '';
    var cleaned = value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.slice(0, maxLength).trimEnd();
  }

  /**
   * Screen text is untrusted data. Strip angle brackets so it cannot escape
   * the <ocr> delimiters in prompts, and cap the length.
   */
  function sanitizeUntrusted(value, maxLength) {
    return clampText(value, maxLength).replace(/</g, '‹').replace(/>/g, '›');
  }

  function dedupeStrings(values, maxItems) {
    var seen = new Set();
    var out = [];
    var list = Array.isArray(values) ? values : [];
    for (var i = 0; i < list.length; i += 1) {
      var text = clampText(list[i], 40);
      if (!text) continue;
      var key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= maxItems) break;
    }
    return out;
  }

  /** Lowercase, keep CJK + letters + digits only. */
  function normalizeForMatch(value) {
    return String(value == null ? '' : value)
      .toLocaleLowerCase('zh-CN')
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  /** Character bigrams over normalized CJK/alphanumeric text. */
  function bigrams(value) {
    var chars = Array.from(normalizeForMatch(value));
    var grams = new Set();
    for (var i = 0; i < chars.length - 1; i += 1) {
      grams.add(chars[i] + chars[i + 1]);
    }
    return grams;
  }

  function overlapCount(a, b) {
    var count = 0;
    var small = a.size <= b.size ? a : b;
    var large = a.size <= b.size ? b : a;
    small.forEach(function (gram) {
      if (large.has(gram)) count += 1;
    });
    return count;
  }

  /**
   * Stable non-negative integer from a string.
   *
   * Deliberately not a cryptographic hash: it only breaks ties between equally
   * shown emotions, and it has to run synchronously in a service worker where
   * WebCrypto is promise-only. FNV-1a is enough to stop a two-way tie from
   * always resolving the same way within one conversation.
   */
  function seed(value) {
    var hash = 0x811c9dc5;
    var text = String(value == null ? '' : value);
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  var api = {
    clampText: clampText,
    sanitizeUntrusted: sanitizeUntrusted,
    dedupeStrings: dedupeStrings,
    normalizeForMatch: normalizeForMatch,
    bigrams: bigrams,
    overlapCount: overlapCount,
    seed: seed,
  };

  root.SmText = api;
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
