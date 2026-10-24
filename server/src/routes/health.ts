import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { ModelProvider } from '../providers/ModelProvider.js';

export interface HealthDeps {
  config: AppConfig;
  provider: ModelProvider;
}

export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => ({
    ok: true,
    provider: deps.provider.name,
    // Differs from `provider` when MODEL_PROVIDER=deepseek but the key is
    // missing: the server keeps serving with mock so the cause is visible.
    configuredProvider: deps.config.provider,
    providerFallback: deps.config.provider !== deps.provider.name,
    model: {
      vision: deps.provider.visionModel,
      chat: deps.provider.chatModel,
    },
    version: deps.config.version,
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  }));
}
