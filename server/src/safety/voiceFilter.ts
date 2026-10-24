import { applyMaomaoStyle, withMaoSuffix } from './guards.js';

/**
 * Streaming-safe version of `applyMaomaoStyle`.
 *
 * Real models stream token by token, so forbidden patterns can straddle two
 * deltas ("哈哈" split as "哈" + "哈"). We hold back the last few characters
 * and only emit text that is old enough to be decided on.
 */
const HOLD = 4;

function cleanChunk(text: string): string {
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

export interface VoiceFilter {
  push(chunk: string): string;
  flush(): string;
}

// 刷子喵喵 is the previous name: models warmed on the old persona sometimes
// still self-label with it, so both are stripped.
const SPEAKER_LABEL = /^\s*(上头了喵喵|刷子喵喵|喵喵|maomao)\s*[：:]\s*/i;
const LABEL_NAMES = ['上头了喵喵', '刷子喵喵', '喵喵', 'maomao'];

/** True while the buffered text could still become a "上头了喵喵：" label. */
function mightBeLabel(text: string): boolean {
  const head = text.trimStart().toLowerCase();
  if (!head) return true;
  if (/[：:]/.test(head)) return false;
  return LABEL_NAMES.some((name) => name.startsWith(head) || head.startsWith(name));
}

export function createMaomaoStreamFilter(): VoiceFilter {
  let buffer = '';
  let started = false;
  // The tail end of everything already emitted. Needed by flush(): if the
  // model ended on characters we strip (e.g. "可爱~~~!!"), the final chunk is
  // empty and the 喵 has nowhere to attach, so it is sent on its own.
  let emitted = '';

  return {
    push(chunk: string): string {
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
      const head = buffer.slice(0, buffer.length - HOLD);
      buffer = buffer.slice(buffer.length - HOLD);
      const out = cleanChunk(head);
      if (out) emitted = out;
      return out;
    },
    flush(): string {
      const rest = buffer.replace(SPEAKER_LABEL, '');
      buffer = '';
      started = true;
      // flush() is the final slice of the reply, so the 喵 tail is safe to add
      // here: it lands once, at the end, after all forbidden patterns have
      // been cleaned out.
      const styled = applyMaomaoStyle(cleanChunk(rest));
      if (styled) return withMaoSuffix(styled);
      // Nothing survived the cleanup, but the reply did have a body. Attach
      // the tail to what was already sent rather than dropping it.
      return emitted ? '喵' : '';
    },
  };
}
