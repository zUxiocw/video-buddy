import type { AnalyzeInput, AnalyzeResult, ChatInput } from '../types.js';
import type { ModelProvider } from './ModelProvider.js';
import type { Tone } from '../types.js';
import { clampText, dedupeStrings, delay, hashShort, normalizeForMatch } from '../lib/text.js';
import { applyMaomaoStyle, containsBlockedTerm, neutralReaction } from '../safety/guards.js';

export interface MockProviderOptions {
  delayMs?: number;
  chunkDelayMs?: number;
}

const STOPWORDS = new Set([
  '这个', '那个', '一个', '我们', '你们', '他们', '真的', '就是', '什么', '怎么',
  '可以', '不是', '没有', '现在', '今天', '视频', '抖音', '一下', '感觉', '已经',
  '还是', '因为', '所以', '但是', '然后', '自己', '知道', '喜欢', '看到', '时候',
]);

/**
 * Deterministic, offline provider used for development and CI.
 * It never calls the network and is good enough to exercise the whole app.
 */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly visionModel = 'mock-vision';
  readonly chatModel = 'mock-chat';

  private readonly delayMs: number;
  private readonly chunkDelayMs: number;

  constructor(options: MockProviderOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
  }

  async analyze(input: AnalyzeInput, signal: AbortSignal): Promise<AnalyzeResult> {
    if (this.delayMs > 0) await delay(this.delayMs, signal);

    const caption = clampText(input.ocr.caption, 300);
    const ocr = clampText(input.ocr.text, 2000);
    const hashtags = input.ocr.hashtags
      .map((tag) => clampText(tag.replace(/^#/, ''), 30))
      .filter(Boolean);
    const keywords = extractKeywords(`${caption} ${ocr}`, hashtags);
    const combined = `${caption} ${ocr}`;
    const isAd = /广告|赞助|品牌合作|小黄车|商品链接/.test(combined);
    const isLive = /直播中|正在直播|LIVE/i.test(combined);
    const blocked = containsBlockedTerm(combined);

    if (blocked) {
      return {
        summary: '这条内容涉及不适合展开的话题，我们换个轻松的看。',
        keywords,
        mood: '其他',
        isAd,
        isLive,
        risk: 'blocked',
        reaction: '',
        memeUsed: null,
        confidence: 0.9,
      };
    }

    const summary = caption
      ? clampText(caption, 60)
      : keywords.length > 0
        ? `画面内容主要和${keywords.slice(0, 2).join('、')}有关`
        : '画面信息不太够，我还没完全看准';
    const mood = detectMood(combined);
    const confidence = caption ? 0.78 : ocr ? 0.56 : 0.3;
    const reaction =
      confidence < 0.35
        ? neutralReaction(input.tone)
        : chooseReaction(input.tone, mood, keywords, combined, input.recentReactions);
    const memeUsed = pickMeme(combined, input);

    return {
      summary,
      keywords,
      mood,
      isAd,
      isLive,
      risk: 'ok',
      reaction,
      memeUsed,
      confidence,
    };
  }

  async *streamChat(input: ChatInput, signal: AbortSignal): AsyncIterable<string> {
    const reply = buildMockChatReply(input);
    for (const chunk of chunkText(reply, 4)) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (this.chunkDelayMs > 0) await delay(this.chunkDelayMs, signal);
      yield chunk;
    }
  }
}

function extractKeywords(text: string, hashtags: string[]): string[] {
  const segments = text
    .split(/[\s#，。！？、；：,.!?;:()（）【】[\]"'“”‘’]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const phrases: string[] = [];
  for (const segment of segments) {
    if (/^[0-9]+$/.test(segment) || STOPWORDS.has(segment)) continue;
    if (segment.length >= 2 && segment.length <= 10) phrases.push(segment);
    else if (segment.length > 10) phrases.push(segment.slice(0, 8));
  }
  // Caption phrases come first: a concrete detail beats a generic hashtag.
  const candidates = [...phrases, ...hashtags].filter((word) => {
    const value = word.trim();
    return value.length >= 2 && !STOPWORDS.has(value) && !/^[0-9]+$/.test(value);
  });
  const unique = dedupeStrings(candidates, 8);
  return unique.length > 0 ? unique.slice(0, 5) : ['日常', '短视频'];
}

function detectMood(text: string): string {
  if (/感动|想哭|泪目|破防/.test(text)) return '感动';
  if (/燃|热血|逆袭|比赛|赢了/.test(text)) return '燃';
  if (/猫|狗|萌|可爱|治愈|宝宝|孩子/.test(text)) return '治愈';
  if (/搞笑|笑|整活|沙雕|翻车|离谱|哈哈哈/.test(text)) return '搞笑';
  if (/种草|推荐|好物|必入|买它|同款/.test(text)) return '种草';
  if (/无语|尴尬|服了/.test(text)) return '无语';
  return '其他';
}

function chooseReaction(
  tone: Tone,
  mood: string,
  keywords: string[],
  text: string,
  recent: string[],
): string {
  const kw = keywords[0] ?? '这段';
  const pools: Record<Tone, string[]> = {
    maomao: [
      `这${kw}能留住你，靠的不是内容`,
      `${kw}这段，我只看出来你很闲`,
      `你停在这儿，不是${kw}有多好，是你懒得滑`,
      `${kw}有点意思，但没到值得停下的程度`,
      `这${kw}的节奏，专治你这种手欠`,
      `${kw}我见多了，你这条算演的`,
      `别装了，${kw}就是你的电子榨菜`,
      `${kw}这段，评论区比正片有戏`,
      `同一个${kw}看这么久，手指是不会自己滑了`,
      `这${kw}挑得挺准，正好戳你`,
    ],
    roaster: [
      `这${kw}属实有点东西，我盯了两秒才反应过来`,
      `不是，这${kw}也太会整活了，谁教它的`,
      `看到${kw}我直接笑出声，这合理吗`,
      `这段${kw}建议反复观看，越看越离谱`,
      `好家伙，${kw}这一下把我整不会了`,
    ],
    cheerleader: [
      `这个${kw}好治愈，我跟着停下来了`,
      `这段${kw}看得人心情都变好了，难怪你会停`,
      `${kw}这画面软乎乎的，我也想多看两眼`,
      `能刷到这段${kw}，今天运气不错`,
      `这种${kw}的小日常最能接住人了`,
    ],
    professor: [
      `这条的关键其实是${kw}，画面和文案都在往这个点收`,
      `${kw}之所以抓人，是因为节奏卡得很准`,
      `从${kw}能看出来，短视频很擅长放大一个瞬间`,
      `这属于典型的${kw}类内容，靠细节取胜`,
      `这里的${kw}既是看点，也是文案的钩子`,
    ],
  };
  const pool = pools[tone] ?? pools.roaster;
  const seed = seedFrom(`${text}|${mood}|${keywords.join('|')}`);
  return pickFresh(pool, recent, seed);
}

function pickMeme(text: string, input: AnalyzeInput): string | null {
  const slangHit = input.slangCandidates.find((entry) => {
    const names = [entry.term, ...entry.aliases];
    return names.some((name) => text.includes(name));
  });
  if (slangHit) return slangHit.term;
  const trendHit = input.trendCandidates.find((trend) => text.includes(trend));
  return trendHit ?? null;
}

function buildMockChatReply(input: ChatInput): string {
  if (input.tone === 'maomao') return buildMaomaoChatReply(input);

  const summary = clampText(input.context.summary, 80);
  const keywords = (input.context.keywords ?? []).map((word) => clampText(word, 20)).filter(Boolean);
  const message = input.message.trim();
  const summaryLine = summary ? `你刚看的这条，我理解是${summary}。` : '';
  const keywordLine = keywords.length > 0 ? `画面里比较突出的是${keywords.slice(0, 2).join('、')}。` : '';

  if (/这视频|讲了啥|讲什么|内容是|啥意思|什么意思/.test(message)) {
    if (!summary) return '我这边还没拿到这条的摘要，你再跟我说说画面里有什么，我接着聊。';
    return `${summaryLine}${keywordLine}你想让我吐槽还是认真分析？`;
  }

  if (/梗|热梗|流行语/.test(message)) {
    const slang = input.slangCandidates[0];
    if (slang) {
      return `这里可以借用「${slang.term}」来理解：${slang.meaning}。不过具体还得看画面语境，别硬套。`;
    }
    return '我暂时没抓到特别贴的梗。你先说说画面里最离谱的点，我再帮你配一个。';
  }

  if (/推荐|下一个|看什么|再刷/.test(message)) {
    const kw = keywords[0] ?? '这类';
    return `顺着${kw}这个路子再刷几条可以，但别一直停在同一类，换换口味更有意思。`;
  }

  if (/你好|在吗|hello|hi/i.test(message)) {
    return summary ? `在的，我陪你刷。刚这条是${summary}，你想吐槽还是听我夸？` : '在的，先刷到有意思的再喊我。';
  }

  const toneLines: Record<Tone, string> = {
    maomao: '这画面自己已经会说话了。',
    roaster: '要我说，这画面自己已经会说话了。',
    cheerleader: '我还挺喜欢这种轻轻松松的感觉。',
    professor: '这类内容一般靠画面节奏和文案一起抓注意力。',
  };
  return `${summaryLine}${toneLines[input.tone]}你更想聊视频本身，还是随便扯两句？`;
}

function buildMaomaoChatReply(input: ChatInput): string {
  const summary = clampText(input.context.summary, 60);
  const caption = clampText(input.context.caption, 60);
  const keywords = (input.context.keywords ?? []).map((word) => clampText(word, 20)).filter(Boolean);
  const topic = compactTopic(summary || caption || (keywords[0] ? `这个${keywords[0]}` : '这条'));
  const detail = compactTopic(keywords[1] || keywords[0] || summary || caption || '这个反应');
  const message = input.message.trim();
  const recent = input.history
    .filter((turn) => turn.role === 'assistant')
    .slice(-6)
    .map((turn) => clampText(turn.content, 120))
    .filter(Boolean);
  const seed = seedFrom(`${input.requestId}|${input.sessionId}|${input.message}|${input.history.length}|${recent.slice(-2).join('|')}`);
  // Summary/caption often carry the raw "文案 #话题" line; compact it so the
  // reply does not read the hashtags aloud.
  const about = compactTopic(summary || caption);
  let candidates: string[];

  if (/^(你好|在吗|hi|hello|嗨|早上好|晚上好)/i.test(message)) {
    candidates = [
      '在。你继续刷，我负责挑刺',
      `来了。${topic}这条你先说`,
      `嗯，我在。${topic}看完再聊`,
      '在，别光刷，挑一条有意思的',
    ];
  } else if (/^[?？]+$/.test(message)) {
    candidates = ['?', '说清楚，别拿问号打发我', '没头没尾，补一句', '你这一下把我问住了'];
  } else if (isLeaving(message)) {
    candidates = ['行，手指总算停了', '睡吧，视频又不会跑', '撤吧，明天再刷', '好，今天到这儿'];
  } else if (/这视频|讲了啥|讲什么|内容是|啥意思|什么意思|看懂|没看懂|剧情/.test(message)) {
    if (!summary && !caption) {
      candidates = ['画面给的信息不够，你先说看到了什么', '你问我，我还想问你看到了什么', '这条我没看准，别装懂'];
    } else {
      candidates = [
        `${about}。就这么点事，你盯了这么久`,
        `你盯这么久，不就是${about}`,
        `别装看不懂，${about}`,
        `说穿了就一件事：${about}`,
        `这条的重点不是剧情，是${detail}那下；${about}只是壳`,
        `${about}。我只看懂${detail}，别的没救`,
        `${about}。真正有戏的是${detail}，不是剧情`,
      ];
    }
  } else if (/为什么|为啥|凭什么|怎么|怎么会/.test(message)) {
    candidates = [
      `因为${topic}这种破事最容易让人停下`,
      `没为什么，${topic}刚好戳中你`,
      `你问为什么，先问问自己为什么停在这儿`,
      `${topic}经不起细想，平台要的就是你不细想`,
      `别找原因，${topic}就是饵`,
    ];
  } else if (/推荐|下一个|看什么|再刷|换一个|换点/.test(message)) {
    candidates = [
      `换${detail}之外的，你在这类里泡太久了`,
      `往下刷，别再给${topic}贡献停留`,
      `看点别的，${topic}这套你已经熟`,
      `换口味，${topic}再刷就馊了`,
      `${topic}看够了就换，别让算法替你决定`,
      `刷点不一样的，${topic}已经把你喂熟了`,
      `你先停一下，${topic}再看就真成电子榨菜了`,
      `往旁边滑，别在${topic}里打转`,
    ];
  } else if (/梗|热梗|流行语/.test(message)) {
    const slang = input.slangCandidates[0];
    candidates = slang
      ? [
          `「${slang.term}」能用，但别硬塞`,
          `这梗放${topic}上勉强，换个说法`,
          `会用「${slang.term}」不算懂梗，得看场合`,
        ]
      : [
          '这话题没梗可借，硬凑更尴尬',
          `别硬找梗，${topic}本身就有戏`,
          '梗不是这么用的，先看语境',
        ];
  } else if (/谢谢|谢了|感谢|懂了|有道理/.test(message)) {
    candidates = [
      `别谢，${topic}还没聊完`,
      '少来这套，继续',
      '嗯，算你有眼光',
      '行，听懂了就往下说',
    ];
  } else if (/笑死|好笑|绷不住|乐死|离谱|绝了|笑喷|卧槽/.test(message)) {
    candidates = [
      '笑点在哪，我倒没看出来',
      '你笑点挺低，这也能乐',
      '行，你开心就好',
      '笑完记得往下滑',
      '这种事也能笑，你今天状态不对',
      '笑归笑，别把这条当真的',
      '你这笑声比视频有内容',
    ];
  } else if (isLowMood(message)) {
    candidates = [
      '先别刷，怎么了',
      '视频先放一边，说',
      '你这状态不适合继续刷，停一下',
      '怎么了，谁惹你了',
      '先别刷，跟我说说',
      '视频先停，别一个人憋着',
      '这状态还刷什么，说',
      '停一下，先处理你的事',
    ];
  } else {
    candidates = [
      `${topic}就摆在那，你还在等它自己解释`,
      `你这句比${topic}有意思`,
      `别急着总结，${topic}还没演完`,
      `我只关心${topic}，别的都是配菜`,
      `${topic}。你继续，我看你还能刷出什么`,
      `你这话说得，${topic}都显得正常了`,
      `行，${topic}这条算你有点反应`,
    ];
  }

  return applyMaomaoStyle(pickFresh(candidates, recent, seed));
}

/**
 * "要走了" intent. Bare 停/困/烦/累 match inside ordinary comments
 * ("为什么猫这么困"), so require a whole-phrase match or a first-person cue.
 */
function isLeaving(message: string): boolean {
  const text = message.replace(/[\s。，、,.!！?？~～]+/g, '');
  return (
    /^(我)?(不刷了|不看了|睡了|困了|撤了|走了|拜拜|晚安|下了|先这样|先睡了)$/.test(text) ||
    /^(我)?(先)?(睡|撤|走|下)了?$/.test(text) ||
    /^(拜拜|晚安|再见)/.test(text) ||
    /^(我)?(不刷|不看了|先不刷|先睡了)/.test(text)
  );
}

/** Low-mood intent; 烦/累 only count when the sentence is about the user. */
function isLowMood(message: string): boolean {
  const text = message.replace(/\s+/g, '');
  if (/难过|焦虑|不开心|emo|郁闷|没意思|好无聊/i.test(text)) return true;
  if (/^(今天|我|自己|最近)?(好|有点|很|太|真)?(烦|累|无聊|郁闷)/.test(text)) return true;
  if (/(我|自己)(很|好|有点|太|真)?(烦|累|难过|不开心)/.test(text)) return true;
  return false;
}

function compactTopic(value: string): string {
  const text = clampText(value, 60)
    .replace(/#[^\s#]+/g, '')
    .replace(/[“”"'`]/g, '')
    .trim();
  const first = text.split(/[。！？!?；;\n]/)[0] ?? text;
  return clampText(first, 28) || '这条';
}

function seedFrom(value: string): number {
  const raw = Number.parseInt(hashShort(value, 8), 16);
  return Number.isFinite(raw) ? Math.abs(raw) : 0;
}

function pickFresh(candidates: string[], recent: string[], seed: number): string {
  const used = recent.map(normalizeForMatch).filter(Boolean);
  const fresh = candidates.filter((candidate) => {
    const normalized = normalizeForMatch(candidate);
    if (!normalized) return false;
    return !used.some((previous) => {
      return previous === normalized || previous.includes(normalized) || normalized.includes(previous);
    });
  });
  const pool = fresh.length > 0 ? fresh : candidates;
  return pool[Math.abs(seed) % pool.length]!;
}

function chunkText(text: string, size: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(''));
  }
  return chunks;
}
