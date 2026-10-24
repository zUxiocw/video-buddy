import { describe, expect, it } from 'vitest';
import type { AnalyzeResult, ChatInput } from '../src/types.js';
import { applyMaomaoStyle, finalizeAnalyzeResult } from '../src/safety/guards.js';
import { buildAnalyzeMessages, buildChatMessages } from '../src/prompts/zh.js';
import { MockProvider } from '../src/providers/MockProvider.js';
import { personaFor } from '../src/prompts/persona.js';

const rawResult: AnalyzeResult = {
  summary: '一只猫在拆家',
  keywords: ['猫', '拆家'],
  mood: '搞笑',
  isAd: false,
  isLive: false,
  risk: 'ok',
  reaction: '这猫是真把自己当主子了哈哈哈！',
  memeUsed: null,
  confidence: 0.9,
};

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of iterable) out += chunk;
  return out;
}

describe('喵喵陪你刷 persona', () => {
  it('is registered as the default-facing cat girl with an adult-friend voice', () => {
    const persona = personaFor('maomao');
    expect(persona.label).toBe('喵喵陪你刷');
    expect(persona.rules).toContain('猫娘');
    expect(persona.rules).toContain('不是主仆');
    expect(persona.rules).toContain('感叹号');
  });

  it('strips exclamation marks, 哈哈 and trailing 语气词 from reactions', () => {
    expect(applyMaomaoStyle('笑死我了哈哈！')).toBe('笑死我了');
    expect(applyMaomaoStyle('这猫好可爱哦')).toBe('这猫好可爱');
    expect(applyMaomaoStyle('你不是吧？！')).toBe('你不是吧？');
    expect(applyMaomaoStyle('？？')).toBe('？？');
    expect(applyMaomaoStyle('别看了。')).toBe('别看了');
  });

  it('applies the style only to reactions, and keeps blocked content empty', () => {
    const styled = finalizeAnalyzeResult(rawResult, [], [], 'maomao');
    expect(styled.reaction).toBe('这猫是真把自己当主子了喵');
    expect(styled.risk).toBe('ok');

    const other = finalizeAnalyzeResult(rawResult, [], [], 'roaster');
    expect(other.reaction).toContain('哈哈');

    const blocked = finalizeAnalyzeResult(
      { ...rawResult, reaction: '这场地震太惨了' },
      [],
      [],
      'maomao',
    );
    expect(blocked.risk).toBe('blocked');
    expect(blocked.reaction).toBe('');
  });

  it('writes the voice rules into both prompts', () => {
    const chatInput: ChatInput = {
      requestId: 'p-001',
      sessionId: 's-001',
      tone: 'maomao',
      message: '这拍的啥',
      context: { summary: '猫在拆家', keywords: ['猫'], caption: '猫主子拆家' },
      history: [],
      trendCandidates: [],
      slangCandidates: [],
      privacyTextOnly: true,
    };
    const chat = buildChatMessages(chatInput);
    const system = chat[0]!.content as string;
    expect(system).toContain('喵喵陪你刷');
    expect(system).toContain('感叹号');
    expect(system).not.toContain('礼貌拒绝');
    // The tail is appended server-side; the model must not write its own, or
    // replies come out as "喵喵" or with the tail mid-sentence.
    expect(system).toContain('喵');

    const refine = buildAnalyzeMessages(
      {
        requestId: 'p-002',
        app: 'douyin',
        tone: 'maomao',
        dwellMs: 8000,
        ocr: { text: '', caption: '猫主子拆家', hashtags: ['猫'] },
        images: [],
        recentReactions: [],
        trendCandidates: [],
        slangCandidates: [],
      },
      'high',
    );
    const analyzeSystem = refine[0]!.content as string;
    expect(analyzeSystem).toContain('喵喵陪你刷');
    expect(analyzeSystem).toContain('不说「我不能」');
    expect(analyzeSystem).toContain('不要出现感叹号');
  });

  it('answers like a blunt friend in mock mode', async () => {
    const provider = new MockProvider();
    const reply = await collect(
      provider.streamChat(
        {
          requestId: 'p-003',
          sessionId: 's-003',
          tone: 'maomao',
          message: '这视频讲了啥',
          context: { summary: '猫在拆家', keywords: ['猫'], caption: '猫主子拆家' },
          history: [],
          trendCandidates: [],
          slangCandidates: [],
          privacyTextOnly: true,
        },
        new AbortController().signal,
      ),
    );
    expect(reply).toContain('猫在拆家');
    expect(reply).not.toContain('！');
    expect(reply).not.toContain('~');
  });

  it('injects video anchor and recent-reply anti-repeat rules into chat prompt', () => {
    const chatInput: ChatInput = {
      requestId: 'p-anti-repeat',
      sessionId: 's-anti-repeat',
      tone: 'maomao',
      message: '这猫怎么又拆家',
      context: { summary: '猫在拆家', keywords: ['猫', '拆家'], caption: '猫主子又拆家了' },
      history: [
        { role: 'user', content: '在吗' },
        { role: 'assistant', content: '这猫真把自己当主子了' },
      ],
      trendCandidates: [],
      slangCandidates: [],
      privacyTextOnly: true,
    };
    const system = buildChatMessages(chatInput)[0]!.content as string;
    expect(system).toContain('本视频可用的具体锚点');
    expect(system).toContain('不要复用这些开头');
    expect(system).toContain('这一轮只做这个表达动作');
    expect(system).toContain('这一轮的情绪底色');
    expect(system).toContain('这猫真把自己当主子了');
    // The old rule said 「不要每轮提“八秒”」, which put the very number in front
    // of the model every turn. Nothing in the prompt may mention a duration.
    expect(system).not.toContain('八秒');
    expect(system).not.toContain('毫秒');
    expect(system).not.toMatch(/\d+\s*秒/);
  });

  it('warns the model off an angle its recent lines already used', () => {
    const base: ChatInput = {
      requestId: 'p-angle',
      sessionId: 's-angle',
      tone: 'maomao',
      message: '这猫怎么又拆家',
      context: { summary: '猫在拆家', keywords: ['猫'], caption: '猫主子又拆家了' },
      history: [],
      trendCandidates: [],
      slangCandidates: [],
      privacyTextOnly: true,
    };

    // Recent lines leaned on how long the user watched: say so.
    const timed = buildChatMessages({
      ...base,
      history: [
        { role: 'user', content: '在吗' },
        { role: 'assistant', content: '这猫看八秒，你比它还有耐心' },
      ],
    })[0]!.content as string;
    expect(timed).toContain('最近这几句已经用过这些角度');
    expect(timed).toContain('停留时长');

    // A recent line about the picture leaves no angle warning behind.
    const fresh = buildChatMessages({
      ...base,
      history: [
        { role: 'user', content: '在吗' },
        { role: 'assistant', content: '这猫的表情很到位' },
      ],
    })[0]!.content as string;
    expect(fresh).not.toContain('最近这几句已经用过这些角度');
  });

  it('does not mistake video comments for the user leaving or being sad', async () => {
    const provider = new MockProvider();
    const base: ChatInput = {
      requestId: 'p-intent',
      sessionId: 's-intent',
      tone: 'maomao',
      message: '',
      context: { summary: '猫在拆家', keywords: ['猫', '拆家'], caption: '猫主子拆家' },
      history: [],
      trendCandidates: [],
      slangCandidates: [],
      privacyTextOnly: true,
    };
    const leaving = ['行，手指总算停了', '睡吧，视频又不会跑', '撤吧，明天再刷', '好，今天到这儿'];
    const lowMood = ['先别刷，怎么了', '视频先放一边，说', '你这状态不适合继续刷，停一下', '怎么了，谁惹你了', '先别刷，跟我说说', '视频先停，别一个人憋着', '这状态还刷什么，说', '停一下，先处理你的事'];

    for (const text of ['为什么猫这么困', '这猫一直停不下来', '它走了之后呢', '这视频停下来看有点意思']) {
      const reply = await collect(provider.streamChat({ ...base, requestId: `p-intent-${text}`, message: text }, new AbortController().signal));
      expect(leaving, `"${text}" should not be treated as leaving`).not.toContain(reply);
    }
    for (const text of ['这有点麻烦', '这视频拍得挺累人的']) {
      const reply = await collect(provider.streamChat({ ...base, requestId: `p-intent-${text}`, message: text }, new AbortController().signal));
      expect(lowMood, `"${text}" should not be treated as low mood`).not.toContain(reply);
    }

    // Real goodbye / low-mood messages still reach the right branch.
    const bye = await collect(provider.streamChat({ ...base, requestId: 'p-intent-bye', message: '我不刷了' }, new AbortController().signal));
    expect(leaving).toContain(bye);
    const sad = await collect(provider.streamChat({ ...base, requestId: 'p-intent-sad', message: '我有点烦' }, new AbortController().signal));
    expect(lowMood).toContain(sad);
  });

  it('does not read hashtags back to the user', async () => {
    const provider = new MockProvider();
    const reply = await collect(
      provider.streamChat(
        {
          requestId: 'p-hashtag',
          sessionId: 's-hashtag',
          tone: 'maomao',
          message: '这视频讲了啥',
          context: {
            summary: '猫主子又开始拆家了 #萌宠 #猫猫',
            keywords: ['猫主子又开始拆家了', '萌宠', '猫猫'],
            caption: '猫主子又开始拆家了 #萌宠 #猫猫',
          },
          history: [],
          trendCandidates: [],
          slangCandidates: [],
          privacyTextOnly: true,
        },
        new AbortController().signal,
      ),
    );
    expect(reply).not.toContain('#');
    expect(reply).toContain('猫主子又开始拆家了');
  });

  it('prefers caption words over hashtags when choosing a reaction anchor', async () => {
    const provider = new MockProvider();
    const result = await provider.analyze(
      {
        requestId: 'p-anchor',
        app: 'douyin',
        tone: 'maomao',
        dwellMs: 8000,
        ocr: { text: '', caption: '猫主子又开始拆家了 #萌宠 #猫猫', hashtags: ['萌宠', '猫猫'] },
        images: [],
        recentReactions: [],
        trendCandidates: [],
        slangCandidates: [],
      },
      new AbortController().signal,
    );
    expect(result.keywords[0]).toBe('猫主子又开始拆家了');
    expect(result.reaction).toContain('猫主子又开始拆家了');
  });

  it('never emits blacklisted cliches from the mock pools', async () => {
    const provider = new MockProvider();
    const captions = ['猫主子又开始拆家了', '深夜食堂的老板娘', '狗子学会了开冰箱', '这个收纳技巧绝了'];
    for (const caption of captions) {
      let recent: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const result = await provider.analyze(
          {
            requestId: `p-cliche-${caption}-${i}`,
            app: 'douyin',
            tone: 'maomao',
            dwellMs: 8000,
            ocr: { text: '', caption, hashtags: [] },
            images: [],
            recentReactions: recent,
            trendCandidates: [],
            slangCandidates: [],
          },
          new AbortController().signal,
        );
        expect(result.reaction).not.toMatch(/有点东西|确实|说实话|这波|你懂的/);
        recent = [result.reaction, ...recent].slice(0, 2);
      }
    }
  });

  it('varies mock chat replies instead of returning the same template', async () => {
    const provider = new MockProvider();
    const base: ChatInput = {
      requestId: 'p-vary',
      sessionId: 's-vary-0',
      tone: 'maomao',
      message: '这视频讲了啥',
      context: { summary: '猫在拆家', keywords: ['猫'], caption: '猫主子拆家' },
      history: [],
      trendCandidates: [],
      slangCandidates: [],
      privacyTextOnly: true,
    };
    const replies = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const reply = await collect(
        provider.streamChat({ ...base, sessionId: `s-vary-${i}` }, new AbortController().signal),
      );
      expect(reply).toContain('猫在拆家');
      expect(reply).not.toMatch(/[！~]|哈哈|呵/);
      replies.add(reply);
    }
    expect(replies.size).toBeGreaterThan(1);

    const first = [...replies][0]!;
    const repeat = await collect(
      provider.streamChat(
        {
          ...base,
          sessionId: 's-vary-0',
          history: [{ role: 'assistant', content: first }],
        },
        new AbortController().signal,
      ),
    );
    expect(repeat).not.toBe(first);
  });
});
