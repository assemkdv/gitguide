import { describe, it, expect, vi } from 'vitest';
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

  // express-rate-limit's default keyGenerator reads req.ip, and only validates its own
  // config against that on the *first* request a given limiter instance ever handles
  // (it disables all of its own validations right after) — so each case below needs a
  // fresh app/limiter, not a shared one, or the check would silently no-op.
  describe('trust proxy / X-Forwarded-For (Render puts a reverse proxy in front of the API)', () => {
    it('logs ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when trust proxy is left at its Express default', async () => {
      const app = express();
      // No app.set('trust proxy', ...) — this is the misconfigured state server.ts fixes.
      app.use(createRateLimit(60_000, 5));
      app.get('/ping', (_req, res) => res.json({ ok: true }));

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await request(app).get('/ping').set('X-Forwarded-For', '203.0.113.1');
      const loggedForwardedForError = errorSpy.mock.calls.some((call) =>
        call.some((arg) => String(arg).includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR')),
      );
      errorSpy.mockRestore();

      expect(loggedForwardedForError).toBe(true);
    });

    it('does not log ERR_ERL_UNEXPECTED_X_FORWARDED_FOR once trust proxy is set to 1, matching server.ts', async () => {
      const app = express();
      app.set('trust proxy', 1); // the fix under test, mirrored from server.ts
      app.use(createRateLimit(60_000, 5));
      app.get('/ping', (req, res) => res.json({ ip: req.ip }));

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await request(app).get('/ping').set('X-Forwarded-For', '203.0.113.1');
      const loggedForwardedForError = errorSpy.mock.calls.some((call) =>
        call.some((arg) => String(arg).includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR')),
      );
      errorSpy.mockRestore();

      expect(loggedForwardedForError).toBe(false);
      // Bonus confirmation this is more than just silencing the log: req.ip now
      // resolves to the forwarded client address, not the proxy's own socket address —
      // which is what makes per-IP rate limiting actually work behind Render.
      expect(res.body.ip).toBe('203.0.113.1');
    });
  });
});
