import type { AppConfig } from '../config.js';
import type { ModelProvider } from './ModelProvider.js';
import { DeepSeekProvider } from './DeepSeekProvider.js';
import { MockProvider } from './MockProvider.js';

export function createProvider(config: AppConfig): ModelProvider {
  if (config.provider === 'deepseek') {
    if (!config.deepseek.apiKey) {
      // A missing key must not take the whole server down; falling back keeps
      // the extension usable and /health reports mock so the cause is visible.
      console.warn('[provider] MODEL_PROVIDER=deepseek but DEEPSEEK_API_KEY is empty; using mock');
      return new MockProvider(config.mock);
    }
    return new DeepSeekProvider(config.deepseek);
  }
  return new MockProvider(config.mock);
}

export type { ModelProvider };
