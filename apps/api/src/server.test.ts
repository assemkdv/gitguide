import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from './server';
import { resetConfigForTests } from './lib/config';

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describe('CORS origin gate', () => {
  it('rejects requests with no Origin header (the main hole scripts/curl exploited)', async () => {
    const res = await request(app).post('/v1/good-first-issues').send({ repoOwner: 'a', repoName: 'b' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ORIGIN');
    expect(res.text).not.toMatch(/at .*\.ts:\d+/); // no stack trace
  });

  it('rejects an origin outside the allowed set', async () => {
    const res = await request(app)
      .post('/v1/good-first-issues')
      .set('Origin', 'https://evil.com')
      .send({ repoOwner: 'a', repoName: 'b' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ORIGIN');
    expect(res.text).not.toMatch(/at .*\.ts:\d+/); // no stack trace
  });

  it('rejects github.com pages: only the extension itself may call the API', async () => {
    const res = await request(app).post('/v1/good-first-issues').set('Origin', 'https://github.com').send({});
    expect(res.status).toBe(403);
  });

  it('rejects malformed chrome-extension origins', async () => {
    const res = await request(app).post('/v1/good-first-issues').set('Origin', 'chrome-extension://not-an-id').send({});
    expect(res.status).toBe(403);
  });

  it.each(['http://localhost:5173', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'])(
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

describe('trust proxy (Render reverse proxy)', () => {
  it("sets exactly one trusted hop, so req.ip resolves to Render's forwarded client IP rather than the proxy's own address", () => {
    // express-rate-limit's per-IP counters (and any future IP-based logic) key off
    // req.ip, which Express only derives from X-Forwarded-For for as many hops as
    // 'trust proxy' allows. `1` matches Render's single reverse-proxy hop; `true` would
    // trust every hop a client could forge, letting anyone bypass the per-IP limit.
    // See rate-limit.test.ts for why this setting is what stops
    // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
    expect(app.get('trust proxy')).toBe(1);
  });
});

describe('CORS origin gate with ALLOWED_EXTENSION_IDS configured', () => {
  const original = process.env.ALLOWED_EXTENSION_IDS;

  afterEach(() => {
    if (original === undefined) delete process.env.ALLOWED_EXTENSION_IDS;
    else process.env.ALLOWED_EXTENSION_IDS = original;
    vi.resetModules();
    resetConfigForTests();
  });

  it('accepts only the configured extension ID(s) and rejects other chrome-extension origins', async () => {
    process.env.ALLOWED_EXTENSION_IDS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    vi.resetModules();
    (await import('./lib/config')).resetConfigForTests();
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
    expect(disallowed.status).toBe(403);
    expect(disallowed.body.code).toBe('FORBIDDEN_ORIGIN');
  });

  it('still matches when ALLOWED_EXTENSION_IDS is pasted as a full chrome-extension:// origin instead of a bare id', async () => {
    // A plausible copy-paste from the Web Store dashboard or chrome://extensions, which
    // shows the id but is easy to grab alongside its "chrome-extension://" prefix.
    process.env.ALLOWED_EXTENSION_IDS = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    vi.resetModules();
    (await import('./lib/config')).resetConfigForTests();
    const { app: scopedApp } = await import('./server');

    const res = await request(scopedApp)
      .post('/v1/good-first-issues')
      .set('Origin', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      .send({});
    expect(res.status).toBe(400); // passed CORS, failed schema validation
  });
});

describe('operational endpoints and error handling', () => {
  it('GET /ready reports readiness without secrets', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, shuttingDown: false, retrieval: 'lexical' });
    expect(JSON.stringify(res.body)).not.toContain('test-groq-key');
  });

  it('answers malformed JSON with a structured 400, not a stack trace', async () => {
    const res = await request(app)
      .post('/v1/explain-repo')
      .set('Origin', EXTENSION_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"repoOwner":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REQUEST');
    expect(res.text).not.toContain('SyntaxError');
  });

  it('answers unknown routes with JSON 404', async () => {
    const res = await request(app).get('/v1/nope').set('Origin', EXTENSION_ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVALID_REQUEST');
  });

  it('does not log request bodies', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(app).post('/v1/explain-repo').set('Origin', EXTENSION_ORIGIN).send({ repoOwner: 'o', repoName: 'SECRET_REPO_MARKER', extra: 'SECRET_BODY_MARKER' });
    const output = log.mock.calls.flat().join(' ');
    log.mockRestore();
    expect(output).not.toContain('SECRET_BODY_MARKER');
    expect(output).not.toContain('SECRET_REPO_MARKER');
  });
});
