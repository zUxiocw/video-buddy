import type { AnalyzeInput, AnalyzeResult, ChatInput } from '../types.js';

export interface ModelProvider {
  readonly name: string;
  readonly visionModel: string;
  readonly chatModel: string;
  analyze(input: AnalyzeInput, signal: AbortSignal): Promise<AnalyzeResult>;
  streamChat(input: ChatInput, signal: AbortSignal): AsyncIterable<string>;
}
