/*
 * Thin TypeScript wrapper over extension/shared/zh-prompt.js.
 *
 * Prompt assembly moved to the shared file for P2: the BYOK path asks the
 * model from the service worker, and the cat has to talk the same way whether
 * the request came from the server or straight from the browser. Keeping the
 * rules here would have meant two copies that drift quietly.
 *
 * What stays server-side is the data those rules consume: the hand-maintained
 * slang lexicon (node:fs) and the request-id hashing used for rate limiting
 * (node:crypto). The prompt only ever receives them as plain values.
 */
import '../../../extension/shared/persona.js';
import '../../../extension/shared/text-core.js';
import '../../../extension/shared/zh-prompt.js';
import type { AnalyzeInput, ChatInput } from '../types.js';

interface PromptTextPart {
  type: 'text';
  text: string;
}

interface PromptImagePart {
  type: 'image_url';
  image_url: { url: string; detail: string };
}

export type PromptPart = PromptTextPart | PromptImagePart;

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | PromptPart[];
}

interface PromptApi {
  pickChatEmotion(input: ChatInput): string | null;
  usedAngles(recent: readonly string[]): string[];
  buildAnalyzeMessages(input: AnalyzeInput, imageDetail: string): PromptMessage[];
  buildChatMessages(input: ChatInput): PromptMessage[];
}

const api = (globalThis as unknown as { SmPrompt: PromptApi }).SmPrompt;
if (!api) {
  throw new Error('extension/shared/zh-prompt.js did not install globalThis.SmPrompt');
}

export function pickChatEmotion(input: ChatInput): string | null {
  return api.pickChatEmotion(input);
}

export function usedAngles(recent: readonly string[]): string[] {
  return api.usedAngles(recent);
}

export function buildAnalyzeMessages(input: AnalyzeInput, imageDetail: string): PromptMessage[] {
  return api.buildAnalyzeMessages(input, imageDetail);
}

export function buildChatMessages(input: ChatInput): PromptMessage[] {
  return api.buildChatMessages(input);
}
