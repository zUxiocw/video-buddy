/*
 * Thin TypeScript wrapper over extension/shared/guards-core.js.
 *
 * Every guard now lives in the shared file, including the output denylist and
 * the analyze pipeline. That is not tidiness: the BYOK path asks the model
 * directly from the service worker, and it has to run the same filtering the
 * server does. If the denylist stayed here, direct-mode users would receive
 * unfiltered model output.
 *
 * text-core.js is imported first because guards-core.js reads
 * globalThis.SmText lazily.
 */
import '../../../extension/shared/text-core.js';
import '../../../extension/shared/guards-core.js';
import type { AnalyzeResult, SlangEntry, Tone } from '../types.js';

interface GuardsCoreApi {
  NEUTRAL_BY_TONE: Record<Tone, string>;
  AD_REACTIONS: Record<Tone, string>;
  BLOCKED_TERMS: readonly string[];
  AD_MARKERS: RegExp;
  ALLOWED_MOODS: readonly string[];
  withMaoSuffix(text: string): string;
  applyMaomaoStyle(text: string): string;
  adReaction(tone: Tone): string;
  neutralReaction(tone: Tone): string;
  isAdvertisement(
    result: Pick<AnalyzeResult, 'isAd' | 'summary' | 'keywords' | 'reaction'>,
    confirmed?: boolean,
  ): boolean;
  containsBlockedTerm(text: string): string | null;
  isSafeTrendWord(word: string): boolean;
  finalizeAnalyzeResult(
    raw: AnalyzeResult,
    slangCandidates: SlangEntry[],
    trendCandidates: string[],
    tone: Tone,
    adConfirmed?: boolean,
  ): AnalyzeResult;
  normalizeMeme(
    value: string | null,
    slangCandidates: SlangEntry[],
    trendCandidates: string[],
  ): string | null;
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

export function isAdvertisement(
  result: Pick<AnalyzeResult, 'isAd' | 'summary' | 'keywords' | 'reaction'>,
  confirmed = false,
): boolean {
  return core.isAdvertisement(result, confirmed);
}

export function containsBlockedTerm(text: string): string | null {
  return core.containsBlockedTerm(text);
}

export function isSafeTrendWord(word: string): boolean {
  return core.isSafeTrendWord(word);
}

export function finalizeAnalyzeResult(
  raw: AnalyzeResult,
  slangCandidates: SlangEntry[],
  trendCandidates: string[],
  tone: Tone,
  adConfirmed = false,
): AnalyzeResult {
  return core.finalizeAnalyzeResult(raw, slangCandidates, trendCandidates, tone, adConfirmed);
}
