import { rateLimit } from 'express-rate-limit';

export function createRateLimit(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
  });
}
