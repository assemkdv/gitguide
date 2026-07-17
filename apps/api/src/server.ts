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

// Health checks (Render, uptime monitors) hit this directly and generally don't send
// an Origin header — keep it exempt from the CORS/origin gate below entirely.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Comma-separated list of published extension IDs allowed to call this API, e.g.
// "abcdefghijklmnopabcdefghijklmnop". Unset in dev; must be set once the extension is
// published so this can stop accepting every chrome-extension:// origin.
const allowedExtensionIds = (process.env.ALLOWED_EXTENSION_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
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
