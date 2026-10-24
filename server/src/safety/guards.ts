import type { AnalyzeResult, SlangEntry, Tone } from '../types.js';
import { clampText, dedupeStrings } from '../lib/text.js';

/**
 * Conservative denylist for *outputs* and injected trend candidates.
 * We would rather stay silent than comment on high-risk material.
 * The model also receives safety instructions and may return risk="blocked".
 */
const BLOCKED_TERMS: readonly string[] = [
  // Politics / state
  '习近平', '共产党', '政治局', '总书记', '国家主席', '六四', '天安门事件',
  '台独', '港独', '藏独', '疆独', '法轮功', '政变', '示威', '抗议', '游行',
  '选举舞弊', '领导人', '中南海',
  // Military / conflict
  '战争', '开战', '军事', '导弹', '军演', '军队', '武器', '核武', '空袭',
  '俄乌', '巴以', '哈马斯', '恐怖袭击',
  // Disasters / casualties
  '地震', '洪水', '台风', '空难', '海啸', '山体滑坡', '矿难', '火灾', '遇难',
  '死伤', '死亡人数',
  // Crime / violence
  '杀人', '谋杀', '强奸', '绑架', '拐卖', '贩毒', '毒品', '枪击', '袭击案',
  '诈骗团伙', '判决', '案件',
  // Health / financial advice
  '处方', '用药剂量', '治愈癌症', '包治百病', '停药', '荐股', '内幕消息',
  '保本高收益', '梭哈', '币圈',
  // Sexual content / minors / privacy
  '色情', '裸体', '未成年性', '人肉搜索', '开盒', '身份证号', '家庭住址',
];

const NEUTRAL_BY_TONE: Record<Tone, string> = {
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
export function withMaoSuffix(text: string): string {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';

  // Split off the trailing punctuation so the tail lands *before* it:
  // "真的假的？" becomes "真的假的喵？", not "真的假的？喵".
  const match = /^([\s\S]*?)([。，,、！!？?~～\s]*)$/.exec(trimmed);
  const tail = match?.[2] ?? '';
  let head = (match?.[1] ?? '').replace(/喵+$/, '').replace(/[。，,、\s]+$/, '').trim();

  // A reply that is nothing but punctuation ("？", "？？") is a deliberate
  // beat, not an utterance: tagging it with 喵 would read as a glitch.
  if (!head) return trimmed;
  return `${head}喵${tail}`;
}

/**
 * Post-process the 「上头了喵喵」 voice: no exclamation marks, tildes,
 * "哈哈/呵" or trailing 语气词. Meaning-preserving edits only.
 */
export function applyMaomaoStyle(text: string): string {
  return text
    .replace(/[~～]+/g, '')
    .replace(/(哈哈+|呵呵+|hhh+|233+)/gi, '')
    .replace(/([？?])[!！]+/g, '$1')
    .replace(/[!！]+([？?])/g, '$1')
    .replace(/[!！]+/g, '。')
    .replace(/(呢|啦|哦|嘛|呀|噢|哟)(?=[。，,、？?\s]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[。，]{2,}/g, (match) => match[0]!)
    .replace(/^[，,。、\s]+/, '')
    .replace(/[，,、\s]+$/, '')
    .replace(/。$/, '')
    .trim();
}

const ALLOWED_MOODS = new Set(['搞笑', '治愈', '无语', '种草', '感动', '燃', '其他']);

/**
 * An ad gets one fixed reaction: the cat is annoyed at being sold to.
 *
 * Fixed rather than generated on purpose — a "please buy this" video can be
 * friendly, useful or funny, and a model asked to react to it would sometimes
 * play along. Anger at the interruption is the honest, consistent response,
 * and it keeps the ad from ever looking like a recommendation.
 */
const AD_REACTIONS: Record<Tone, string> = {
  // Each line carries an anger marker the client's content detection can read
  // (过分 / 气人), so the avatar turns angry even if the mood never gets there.
  maomao: '又塞广告，太过分了喵',
  roaster: '又来一条广告，真够可以的',
  cheerleader: '又是广告，这可真有点气人',
  professor: '广告，跳过比分析它有用，太过分了',
};

export function adReaction(tone: Tone): string {
  return AD_REACTIONS[tone] ?? AD_REACTIONS.roaster;
}

/**
 * Wording that shows up in ad copy or in the page's own ad labels, but almost
 * never in ordinary captions. Kept narrow for that reason: 商品 / 品牌 / 推荐
 * appear in normal videos too and are intentionally absent.
 */
const AD_MARKERS =
  /广告|赞助|品牌合作|商业推广|小黄车|商品链接|购买链接|下单立减|限时优惠|领取优惠券|点击购买|带货|推广链接|广告创意|赞助内容/;

/**
 * Does this analyze result describe an ad?
 *
 * Deliberately conservative on the model's word alone: a false `true` costs
 * the user a real reaction to a real video, so `isAd` must be corroborated by
 * a concrete marker in the text. Models hallucinate the flag, and ordinary
 * videos sometimes say 广告 in passing.
 *
 * The page's own 「广告」 chip is different: that is first-hand evidence, so it
 * is passed in as `confirmed` and needs no corroboration.
 */
export function isAdvertisement(
  result: Pick<AnalyzeResult, 'isAd' | 'summary' | 'keywords' | 'reaction'>,
  confirmed = false,
): boolean {
  if (confirmed) return true;
  const text = [result.summary, ...(result.keywords ?? []), result.reaction].join(' ');
  return result.isAd === true && AD_MARKERS.test(text);
}

export function containsBlockedTerm(text: string): string | null {
  if (!text) return null;
  const haystack = text.toLocaleLowerCase('zh-CN');
  for (const term of BLOCKED_TERMS) {
    if (haystack.includes(term.toLocaleLowerCase('zh-CN'))) return term;
  }
  return null;
}

export function isSafeTrendWord(word: string): boolean {
  const text = clampText(word, 60);
  return text.length >= 2 && !containsBlockedTerm(text);
}

/**
 * Normalize model output before it reaches the phone:
 * clamp lengths, validate meme usage, and block risky copy.
 */
export function finalizeAnalyzeResult(
  raw: AnalyzeResult,
  slangCandidates: SlangEntry[],
  trendCandidates: string[],
  tone: Tone,
  adConfirmed = false,
): AnalyzeResult {
  const summary = clampText(raw.summary, 60);
  const keywords = dedupeStrings(raw.keywords, 5);
  const mood = ALLOWED_MOODS.has(raw.mood) ? raw.mood : '其他';
  const finiteConfidence = Number.isFinite(raw.confidence) ? raw.confidence : 0.5;
  const confidence = Math.min(1, Math.max(0, finiteConfidence));
  const rawReaction = clampText(raw.reaction, 60);
  let reaction = rawReaction;
  let memeUsed = normalizeMeme(raw.memeUsed, slangCandidates, trendCandidates);

  // Judged on the model's own summary/keywords, before `reaction` may be
  // replaced by the neutral fallback below (which would erase the marker).
  const isAd = isAdvertisement(
    { isAd: raw.isAd, summary, keywords, reaction: rawReaction },
    adConfirmed,
  );

  const blocked =
    raw.risk === 'blocked' ||
    !!containsBlockedTerm(summary) ||
    !!containsBlockedTerm(reaction) ||
    !!containsBlockedTerm(keywords.join(' '));

  if (blocked) {
    return {
      summary: summary || '这条内容不适合展开聊，我们换个轻松的。',
      keywords,
      mood,
      isAd,
      isLive: !!raw.isLive,
      risk: 'blocked',
      reaction: '',
      memeUsed: null,
      confidence,
    };
  }

  if (confidence < 0.35) {
    reaction = NEUTRAL_BY_TONE[tone];
    memeUsed = null;
  }

  // Ads get one fixed, annoyed line instead of whatever the model invented,
  // and skip the confidence fallback: "this is an ad" is not a guess.
  if (isAd) {
    reaction = adReaction(tone);
    memeUsed = null;
  }

  if (tone === 'maomao' && reaction) {
    reaction = clampText(withMaoSuffix(applyMaomaoStyle(reaction)), 60);
  }

  return {
    summary,
    keywords,
    mood,
    isAd: isAd,
    isLive: !!raw.isLive,
    risk: 'ok',
    reaction,
    memeUsed,
    confidence,
  };
}

function normalizeMeme(
  value: string | null,
  slangCandidates: SlangEntry[],
  trendCandidates: string[],
): string | null {
  const raw = clampText(value, 40);
  if (!raw) return null;
  const needle = raw.toLocaleLowerCase('zh-CN');
  for (const trend of trendCandidates) {
    if (trend.toLocaleLowerCase('zh-CN') === needle) return trend;
  }
  for (const entry of slangCandidates) {
    const names = [entry.term, ...entry.aliases];
    if (names.some((name) => name.toLocaleLowerCase('zh-CN') === needle)) return entry.term;
  }
  return null;
}

export function neutralReaction(tone: Tone): string {
  return NEUTRAL_BY_TONE[tone];
}
