import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRateLimit } from './rate-limit';

describe('createRateLimit', () => {
  it('returns 429 once a client exceeds the configured limit within the window', async () => {
    const app = express();
    app.use(createRateLimit(60_000, 3));
    app.get('/ping', (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/ping');
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/ping');
    expect(blocked.status).toBe(429);
  });

  it('keeps a separate counter per limiter instance, mirroring /v1 vs /v1/chat in server.ts', async () => {
    const appA = express();
    appA.use(createRateLimit(60_000, 1));
    appA.get('/ping', (_req, res) => res.json({ ok: true }));

    const appB = express();
    appB.use(createRateLimit(60_000, 1));
    appB.get('/ping', (_req, res) => res.json({ ok: true }));

    expect((await request(appA).get('/ping')).status).toBe(200);
    expect((await request(appA).get('/ping')).status).toBe(429);
    // A fresh limiter instance isn't tripped by the other one's count.
    expect((await request(appB).get('/ping')).status).toBe(200);
  });
});
