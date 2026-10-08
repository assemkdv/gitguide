import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { createRateLimit } from './lib/rate-limit';
import { getConfig } from './lib/config';
import { ApiError, errorBody } from './lib/errors';
import { aiGuardStats } from './lib/ai-guard';
import { lastModelCheck } from './lib/ai-models';
import { defaultIndexer } from './lib/indexer';
import { analyzeRouter } from './routes/analyze';
import { explainRepoRouter } from './routes/explain-repo';
import { explainFileRouter } from './routes/explain-file';
import { goodFirstIssuesRouter } from './routes/good-first-issues';
import { askRepoRouter } from './routes/ask-repo';

export const app = express();
app.disable('x-powered-by');

// How many reverse-proxy hops sit in front of the app (Render: one load balancer). This
// decides which X-Forwarded-For entry becomes req.ip, which keys the per-IP limits.
// Trusting more hops than really exist would let a client spoof its own address.
app.set('trust proxy', getConfig().trustProxyHops);

let shuttingDown = false;
export function markShuttingDown(): void {
  shuttingDown = true;
}

// Operational log line per request: route, status, duration, request id. Deliberately no
// IP address, query string, body, question, or repository content. `xff` is only the
// *number* of X-Forwarded-For entries, which is how TRUST_PROXY_HOPS is verified against
// the real deployment (see docs/DEPLOYMENT.md).
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = randomUUID();
  const started = process.hrtime.bigint();
  res.setHeader('X-Request-Id', requestId);
  const forwarded = req.headers['x-forwarded-for'];
  const xff = forwarded ? String(forwarded).split(',').length : 0;
  res.on('finish', () => {
    if (req.path === '/health') return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(
      JSON.stringify({ level: 'info', msg: 'request', id: requestId, method: req.method, route: req.baseUrl + req.path, status: res.statusCode, ms: Math.round(ms), xff }),
    );
  });
  next();
});

// Liveness: the process is up. Exempt from the Origin gate (monitors send no Origin).
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Readiness: configuration loaded and not draining for shutdown. No secrets, no content.
app.get('/ready', (_req, res) => {
  const config = getConfig();
  const body = {
    ok: !shuttingDown,
    shuttingDown,
    githubTokenConfigured: config.githubToken != null,
    extensionIdsConfigured: config.allowedExtensionIds.length > 0,
    retrieval: config.enableLocalEmbeddings ? 'hybrid' : 'lexical',
    models: { ...config.models, check: lastModelCheck() },
    ai: aiGuardStats(),
    indexing: defaultIndexer.stats(),
  };
  res.status(shuttingDown ? 503 : 200).json(body);
});

// Browser-origin gate. This is NOT authentication: any non-browser client can send any
// Origin header it likes. It only stops other websites' pages from calling the API with
// a user's browser. Abuse protection comes from the per-IP limits and the global AI
// concurrency/budget guards (lib/ai-guard.ts).
app.use(
  cors({
    origin: (origin, callback) => {
      const { allowedExtensionIds } = getConfig();
      if (!origin) {
        callback(new ApiError('FORBIDDEN_ORIGIN', 403, 'Requests must come from the GitGuide extension.'));
        return;
      }
      const isAllowedExtension = allowedExtensionIds.length
        ? allowedExtensionIds.some((id) => origin === `chrome-extension://${id}`)
        : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      // Every extension request is made by its service worker (see the extension's
      // background/api-relay.ts), so pages — including github.com — are never allowed.
      const isLocalDev = !getConfig().isProduction && origin === 'http://localhost:5173';
      if (isAllowedExtension || isLocalDev) {
        callback(null, true);
      } else {
        console.warn(JSON.stringify({ level: 'warn', msg: 'cors_rejected', origin }));
        callback(new ApiError('FORBIDDEN_ORIGIN', 403, 'Requests must come from the GitGuide extension.'));
      }
    },
  }),
);

app.use((_req: Request, res: Response, next: NextFunction) => {
  if (shuttingDown) {
    res.setHeader('Retry-After', '5');
    res.status(503).json(errorBody(new ApiError('SHUTTING_DOWN', 503, 'GitGuide is restarting. Please try again in a moment.', 5)));
    return;
  }
  next();
});

app.use(express.json({ limit: '64kb' }));

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const V1_RATE_LIMIT = 60;
// /v1/ask-repo can trigger a full repository index build (not just one completion), so
// it gets the tightest budget of all.
export const ASK_REPO_RATE_LIMIT = 15;

app.use('/v1', createRateLimit(RATE_LIMIT_WINDOW_MS, V1_RATE_LIMIT));

app.use('/v1/analyze', analyzeRouter);
app.use('/v1/explain-repo', explainRepoRouter);
app.use('/v1/explain-file', explainFileRouter);
app.use('/v1/good-first-issues', goodFirstIssuesRouter);
app.use('/v1/ask-repo', createRateLimit(RATE_LIMIT_WINDOW_MS, ASK_REPO_RATE_LIMIT), askRepoRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found', code: 'INVALID_REQUEST' });
});

// Final error handler: structured JSON, never a stack trace (Express's default handler
// prints one outside production).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof ApiError) {
    res.status(err.status).json(errorBody(err));
    return;
  }
  const bodyParserType = (err as { type?: string })?.type;
  if (bodyParserType === 'entity.too.large') {
    res.status(413).json(errorBody(new ApiError('INVALID_REQUEST', 413, 'Request body is too large.')));
    return;
  }
  if (bodyParserType === 'entity.parse.failed') {
    res.status(400).json(errorBody(new ApiError('INVALID_REQUEST', 400, 'Request body is not valid JSON.')));
    return;
  }
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled_error', cause: (err as Error)?.name ?? typeof err }));
  res.status(500).json(errorBody(new ApiError('INTERNAL', 500, 'Something went wrong on the GitGuide server.')));
});
