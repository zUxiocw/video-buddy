import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeaders, makeTestServer } from './helpers.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const analyzePayload = {
  requestId: 'auth-request-001',
  tone: 'roaster',
  dwellMs: 5000,
  ocr: { text: '一只猫', caption: '猫猫', hashtags: ['萌宠'] },
  images: [],
};

describe('auth and validation', () => {
  it('rejects missing or wrong bearer token', async () => {
    app = await makeTestServer();
    const missing = await app.inject({ method: 'POST', url: '/v1/analyze', payload: analyzePayload });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('UNAUTHORIZED');

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: { ...authHeaders, authorization: 'Bearer wrong-token-000000' },
      payload: analyzePayload,
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('protects chat and trends too', async () => {
    app = await makeTestServer();
    const chat = await app.inject({ method: 'POST', url: '/v1/chat', payload: { message: 'hi' } });
    expect(chat.statusCode).toBe(401);
    const trends = await app.inject({ method: 'GET', url: '/v1/trends' });
    expect(trends.statusCode).toBe(401);
  });

  it('requires a valid device id', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: { ...authHeaders, 'x-device-id': 'bad' },
      payload: analyzePayload,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('DEVICE_ID_REQUIRED');
  });

  it('rejects malformed JSON with 422', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: '{"requestId":',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid fields', async () => {
    app = await makeTestServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analyze',
      headers: authHeaders,
      payload: { ...analyzePayload, dwellMs: -1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
