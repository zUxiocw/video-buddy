import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/app.js';
import { makeFakeTrendService, makeTestServer } from './helpers.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('health', () => {
  it('reports provider and model without auth', async () => {
    app = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('mock');
    expect(body.model).toEqual({ vision: 'mock-vision', chat: 'mock-chat' });
    expect(typeof body.time).toBe('string');
  });

  it('exposes a config-vs-provider mismatch when the key is missing', async () => {
    // No provider override: this exercises the real createProvider fallback.
    app = await buildServer({
      warmTrends: false,
      trendService: makeFakeTrendService(),
      config: { provider: 'deepseek', logLevel: 'silent', deepseek: { apiKey: '' } },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('mock');
    expect(body.configuredProvider).toBe('deepseek');
    expect(body.providerFallback).toBe(true);
  });

  it('reports no fallback when the provider matches the config', async () => {
    app = await makeTestServer();
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.configuredProvider).toBe('mock');
    expect(body.providerFallback).toBe(false);
  });

  it('returns a structured 404', async () => {
    app = await makeTestServer();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
