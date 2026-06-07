import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/** Validates req.body against `schema`; on success, replaces req.body with the parsed
 * (and defaulted) result so downstream handlers get clean data. On failure, responds
 * 400 with a concise, actionable list of what's wrong — no internals, no stack trace. */
export function validateBody<Schema extends z.ZodTypeAny>(schema: Schema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
