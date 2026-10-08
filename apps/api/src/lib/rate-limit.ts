import { rateLimit } from 'express-rate-limit';
import { ApiError, errorBody } from './errors';

/** Per-IP request quota. Keyed on req.ip, which is only the real client address when
 * Express's 'trust proxy' matches the deployment (see server.ts / TRUST_PROXY_HOPS). */
export function createRateLimit(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfterSec = Math.ceil(options.windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res
        .status(429)
        .json(errorBody(new ApiError('RATE_LIMITED', 429, "You've hit GitGuide's request limit. Please wait a few minutes and try again.", retryAfterSec)));
    },
  });
}
