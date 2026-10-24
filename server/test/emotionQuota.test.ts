import { describe, expect, it } from 'vitest';
import { pickChatEmotion } from '../src/prompts/zh.js';
import type { ChatInput } from '../src/types.js';

/**
 * Build a chat turn whose message carries no emotion of its own, so the quota
 * is what decides the colour.
 */
function neutral(tally: Record<string, number> = {}, requestId = 'req-neutral'): ChatInput {
  return {
    requestId,
    sessionId: 'session-001',
    tone: 'maomao',
    message: '接着聊',
    context: {},
    history: [],
    trendCandidates: [],
    slangCandidates: [],
    privacyTextOnly: true,
    emotionTally: tally,
  };
}

const ALL = ['sad', 'happy', 'annoyed', 'angry', 'laugh', 'excited', 'greet', 'confused', 'shocked'];

describe('emotion quota', () => {
  it('can reach all nine emotions on a neutral message', () => {
    const seen = new Set<string>();
    // Turn by turn, feed back what was chosen: the quota must walk the whole
    // palette instead of circling the same few faces.
    const tally: Record<string, number> = {};
    for (let turn = 0; turn < 40; turn += 1) {
      const picked = pickChatEmotion(neutral({ ...tally }, `req-${turn}`))!;
      expect(ALL).toContain(picked);
      seen.add(picked);
      tally[picked] = (tally[picked] ?? 0) + 1;
    }
    expect([...seen].sort()).toEqual([...ALL].sort());
  });

  it('picks the least-shown emotion, not a random one', () => {
    // Eight emotions already used once; only `excited` is at zero.
    const tally: Record<string, number> = {};
    for (const id of ALL.filter((id) => id !== 'excited')) tally[id] = 1;
    for (let turn = 0; turn < 5; turn += 1) {
      expect(pickChatEmotion(neutral({ ...tally }, `req-${turn}`))).toBe('excited');
    }
  });

  it('keeps the distribution even when the quota drives every turn', () => {
    const tally: Record<string, number> = {};
    const counts: Record<string, number> = {};
    for (let turn = 0; turn < 90; turn += 1) {
      const picked = pickChatEmotion(neutral({ ...tally, ...counts }, `req-${turn}`))!;
      counts[picked] = (counts[picked] ?? 0) + 1;
    }
    // 90 turns over 9 emotions: every face appears exactly ten times.
    for (const id of ALL) expect(counts[id]).toBe(10);
  });

  it('still lets content win over the quota', () => {
    // Every emotion is at zero except `sad`, which is wildly overused. The
    // user says something clearly funny, so the turn must still be 被逗乐.
    const tally: Record<string, number> = { sad: 99 };
    const input = { ...neutral(tally, 'req-content'), message: '笑死我了这猫' };
    expect(pickChatEmotion(input)).toBe('laugh');

    const annoyed = { ...neutral(tally, 'req-content-2'), message: '这也太离谱了' };
    expect(pickChatEmotion(annoyed)).toBe('annoyed');
  });

  it('does not treat an already-matched message as a quota turn', () => {
    // A message that matches nothing is a quota turn; one that matches is not.
    const matched = { ...neutral({}, 'req-a'), message: '你好' };
    expect(pickChatEmotion(matched)).toBe('greet');
    expect(pickChatEmotion({ ...matched, message: '顺手点个关注' })).not.toBeNull();
  });

  it('reaches excited through an enthusiasm message', () => {
    const input = { ...neutral({}, 'req-excited'), message: '这个我种草了' };
    expect(pickChatEmotion(input)).toBe('excited');
  });

  it('returns null for non-maomao tones', () => {
    expect(pickChatEmotion({ ...neutral({}), tone: 'roaster' })).toBeNull();
  });

  it('survives a malformed tally', () => {
    const junk = {
      ...neutral({}, 'req-junk'),
      emotionTally: { sad: -5, laugh: Number.NaN, happy: 'many', bogus: 3 } as unknown as Record<string, number>,
    };
    const picked = pickChatEmotion(junk);
    expect(picked).not.toBeNull();
    expect(ALL).toContain(picked);
  });

  it('is deterministic for the same request', () => {
    const a = pickChatEmotion(neutral({ laugh: 3 }, 'req-same'));
    const b = pickChatEmotion(neutral({ laugh: 3 }, 'req-same'));
    expect(a).toBe(b);
  });
});
