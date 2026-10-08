import type { Request, Response } from 'express';

/** An AbortSignal that fires when the client goes away before the response is finished
 * (panel closed, navigation, Stop), so in-flight GitHub/Groq work is cancelled instead of
 * being paid for with nobody waiting. */
export function requestSignal(_req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new DOMException('Client disconnected', 'AbortError'));
  });
  return controller.signal;
}
