import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from './server';

describe('CORS origin gate', () => {
  it('rejects requests with no Origin header (the main hole scripts/curl exploited)', async () => {
    const res = await request(app).post('/v1/good-first-issues').send({ repoOwner: 'a', repoName: 'b' });
    expect(res.status).toBe(500);
    expect(res.text).toContain('Not allowed by CORS');
  });

  it('rejects an origin outside the allowed set', async () => {
    const res = await request(app)
      .post('/v1/good-first-issues')
      .set('Origin', 'https://evil.com')
      .send({ repoOwner: 'a', repoName: 'b' });
    expect(res.status).toBe(500);
    expect(res.text).toContain('Not allowed by CORS');
  });

  it.each(['https://github.com', 'http://localhost:5173', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'])(
    'accepts allowed origin %s (passes CORS; an empty body then fails schema validation instead)',
    async (origin) => {
      const res = await request(app).post('/v1/good-first-issues').set('Origin', origin).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request body');
    },
  );

  it('GET /health succeeds with no Origin header — exempt from the gate above', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('CORS origin gate with ALLOWED_EXTENSION_IDS configured', () => {
  const original = process.env.ALLOWED_EXTENSION_IDS;

  afterEach(() => {
    if (original === undefined) delete process.env.ALLOWED_EXTENSION_IDS;
    else process.env.ALLOWED_EXTENSION_IDS = original;
    vi.resetModules();
  });

  it('accepts only the configured extension ID(s) and rejects other chrome-extension origins', async () => {
    process.env.ALLOWED_EXTENSION_IDS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    vi.resetModules();
    const { app: scopedApp } = await import('./server');

    const allowed = await request(scopedApp)
      .post('/v1/good-first-issues')
      .set('Origin', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      .send({});
    expect(allowed.status).toBe(400); // passed CORS, failed schema validation

    const disallowed = await request(scopedApp)
      .post('/v1/good-first-issues')
      .set('Origin', 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
      .send({});
    expect(disallowed.status).toBe(500);
    expect(disallowed.text).toContain('Not allowed by CORS');
  });
});
