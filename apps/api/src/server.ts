import express from 'express';
import cors from 'cors';
import { createRateLimit } from './lib/rate-limit';
import { analyzeRouter } from './routes/analyze';
import { chatRouter } from './routes/chat';
import { explainRepoRouter } from './routes/explain-repo';
import { explainFileRouter } from './routes/explain-file';
import { goodFirstIssuesRouter } from './routes/good-first-issues';
import { askRepoRouter } from './routes/ask-repo';

export const app = express();

// Render sits its own reverse proxy in front of this app, which sets X-Forwarded-For.
// express-rate-limit reads req.ip to key its per-IP counters, and refuses to trust that
// header at all unless Express is told how many proxy hops to trust — without this it
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request. Render adds exactly one
// hop, so trust exactly one (not `true`/trust-all, which would let a client spoof its
// own X-Forwarded-For and bypass the per-IP limit). Must be set before any rate limiter
// middleware below is registered, since that's the first thing that reads req.ip.
app.set('trust proxy', 1);

// Health checks (Render, uptime monitors) hit this directly and generally don't send
// an Origin header — keep it exempt from the CORS/origin gate below entirely.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Comma-separated list of published extension IDs allowed to call this API, e.g.
// "abcdefghijklmnopabcdefghijklmnop". Unset in dev; must be set once the extension is
// published so this can stop accepting every chrome-extension:// origin. Tolerates the
// id being pasted as a bare id or as a full "chrome-extension://<id>" origin (an easy
// copy-paste mistake from the Web Store dashboard/chrome://extensions) — normalizing it
// here means a correctly-published id still matches regardless of which form someone
// pasted, without accepting anything a bare-id config wouldn't already accept.
const allowedExtensionIds = (process.env.ALLOWED_EXTENSION_IDS ?? '')
  .split(',')
  .map((id) => id.trim().replace(/^chrome-extension:\/\//, ''))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header at all (plain curl/script requests, not real browser traffic)
      // — reject rather than waving it through, since that was the main hole letting
      // anyone hit these endpoints directly with a script.
      if (!origin) {
        callback(new Error('Not allowed by CORS'));
        return;
      }
      const isAllowedExtension = allowedExtensionIds.length
        ? allowedExtensionIds.some((id) => origin === `chrome-extension://${id}`)
        : /^chrome-extension:\/\//.test(origin);
      if (isAllowedExtension || origin === 'https://github.com' || origin === 'http://localhost:5173') {
        callback(null, true);
      } else {
        // Log the actual rejected origin server-side (never to the client) — the two
        // extension-originated origins this API expects are https://github.com (content
        // script actions: explain-repo/file, analyze, good-first-issues — content scripts
        // are CORS-restricted to the injected page's own origin since MV3, host_permissions
        // no longer exempts them) and chrome-extension://<id> (the background service
        // worker, which relays /v1/chat and /v1/ask-repo and isn't subject to that
        // restriction). Without logging which one showed up, a mismatch here is
        // undiagnosable from Render's logs alone, e.g. a stale/incorrect
        // ALLOWED_EXTENSION_IDS after the extension gets a new published id.
        console.error(`CORS: rejected origin ${JSON.stringify(origin)}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
  }),
);

app.use(express.json({ limit: '256kb' }));

// Per-IP request quota across the expensive AI/GitHub-backed routes. CORS above only
// stops well-behaved browsers; this is what actually caps abuse from scripts that spoof
// an allowed Origin header.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const V1_RATE_LIMIT = 60;
// /v1/chat streams tokens and is the cheapest to hammer relative to perceived value —
// keep it under a tighter budget than the other one-shot endpoints.
export const CHAT_RATE_LIMIT = 20;
// /v1/ask-repo can trigger a full repository index build (not just one completion), so
// it gets the tightest budget of all.
export const ASK_REPO_RATE_LIMIT = 15;

app.use('/v1', createRateLimit(RATE_LIMIT_WINDOW_MS, V1_RATE_LIMIT));

app.use('/v1/analyze', analyzeRouter);
app.use('/v1/chat', createRateLimit(RATE_LIMIT_WINDOW_MS, CHAT_RATE_LIMIT), chatRouter);
app.use('/v1/explain-repo', explainRepoRouter);
app.use('/v1/explain-file', explainFileRouter);
app.use('/v1/good-first-issues', goodFirstIssuesRouter);
app.use('/v1/ask-repo', createRateLimit(RATE_LIMIT_WINDOW_MS, ASK_REPO_RATE_LIMIT), askRepoRouter);
