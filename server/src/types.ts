import { z } from 'zod';

export const toneSchema = z.enum(['maomao', 'roaster', 'cheerleader', 'professor']);
export type Tone = z.infer<typeof toneSchema>;

export type Risk = 'ok' | 'blocked';

export interface ImagePayload {
  mime: 'image/jpeg' | 'image/png';
  /** Raw base64, no data URL prefix. */
  data: string;
}

export interface TrendItem {
  word: string;
  hotValue?: number;
}

export interface SlangEntry {
  term: string;
  aliases: string[];
  meaning: string;
  usageExample: string;
  tags: string[];
  updatedAt: string;
}

export interface AnalyzeResult {
  summary: string;
  keywords: string[];
  mood: string;
  isAd: boolean;
  isLive: boolean;
  risk: Risk;
  reaction: string;
  memeUsed: string | null;
  confidence: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  summary?: string;
  keywords?: string[];
  caption?: string;
}

export interface AnalyzeInput {
  requestId: string;
  app: string;
  tone: Tone;
  dwellMs: number;
  fingerprint?: string;
  ocr: {
    text: string;
    caption: string;
    hashtags: string[];
  };
  images: ImagePayload[];
  recentReactions: string[];
  /**
   * A second (or later) reaction to the same long video. The model should
   * continue the thought instead of re-introducing the video.
   */
  repeat?: boolean;
  /**
   * Coarse length of the video itself — 'short' | 'medium' | 'long'.
   * Deliberately a bucket, not seconds: a number in the prompt is what made
   * every reaction say 「八秒」. Empty string means unknown.
   */
  videoBucket?: string;
  trendCandidates: string[];
  slangCandidates: SlangEntry[];
}

export interface ChatInput {
  requestId: string;
  sessionId: string;
  tone: Tone;
  message: string;
  context: ChatContext;
  history: ChatTurn[];
  trendCandidates: string[];
  slangCandidates: SlangEntry[];
  privacyTextOnly: boolean;
  /**
   * How often each emotion has been shown so far in this conversation, as
   * reported by the client. Used only to fill turns where the user's message
   * carries no emotion of its own; the server keeps no state.
   */
  emotionTally?: Record<string, number>;
}
