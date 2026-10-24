/*
 * Thin TypeScript wrapper over extension/shared/guards-core.js.
 *
 * The voice rules that both runtimes need — the 喵 tail, the style pass, the
 * ad lines, the neutral fallbacks — live in one shared file. What stays here
 * is only what the extension has no use for: the output denylist, the analyze
 * result pipeline, and the meme normaliser. They need server-only types and
 * node built-ins, and putting them in the browser bundle would be dead weight.
 */
import '../../../extension/shared/guards-core.js';
import type { AnalyzeResult, SlangEntry, Tone } from '../types.js';
import { clampText, dedupeStrings } from '../lib/text.js';

interface GuardsCoreApi {
  NEUTRAL_BY_TONE: Record<Tone, string>;
  AD_REACTIONS: Record<Tone, string>;
  withMaoSuffix(text: string): string;
  applyMaomaoStyle(text: string): string;
  adReaction(tone: Tone): string;
  neutralReaction(tone: Tone): string;
}

const core = (globalThis as unknown as { SmGuards: GuardsCoreApi }).SmGuards;
if (!core) {
  throw new Error('extension/shared/guards-core.js did not install globalThis.SmGuards');
}

export const NEUTRAL_BY_TONE: Record<Tone, string> = core.NEUTRAL_BY_TONE;

export function withMaoSuffix(text: string): string {
  return core.withMaoSuffix(text);
}

export function applyMaomaoStyle(text: string): string {
  return core.applyMaomaoStyle(text);
}

export function adReaction(tone: Tone): string {
  return core.adReaction(tone);
}

export function neutralReaction(tone: Tone): string {
  return core.neutralReaction(tone);
}

/**
 * Conservative denylist for *outputs* and injected trend candidates.
 * We would rather stay silent than comment on high-risk material.
 * The model also receives safety instructions and may return risk="blocked".
 *
 * Server-only: the extension never checks text against this list, because it
 * never composes prompt copy of its own.
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

const ALLOWED_MOODS = new Set(['搞笑', '治愈', '无语', '种草', '感动', '燃', '其他']);

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
