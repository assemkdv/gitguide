// Server-wide safeguards on AI spending, on top of the per-IP rate limits in server.ts.
// Per-IP limits stop one client from hogging the service; these stop the service as a
// whole (many clients, or one client rotating IPs) from exceeding what the operator is
// willing to pay for. Both are in-memory: they reset on restart and are per-instance,
// which is appropriate for the single small Render instance this launch targets.
import { ApiError } from './errors';
import { getConfig } from './config';

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** Resolves with a release function once a slot is free. Rejects with SERVER_BUSY if no
   * slot frees up within `timeoutMs`, or with the abort reason if `signal` fires first. */
  acquire(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<() => void> {
    const { signal, timeoutMs = Infinity } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);

    const makeRelease = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) next();
        else this.active--;
      };
    };

    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(makeRelease());
    }

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(grant);
        if (index !== -1) this.waiters.splice(index, 1);
      };
      // The slot is handed over directly (active stays the same) to avoid a race where a
      // newcomer grabs it between release and wake-up.
      const grant = () => {
        cleanup();
        resolve(makeRelease());
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason);
      };
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          cleanup();
          reject(new ApiError('SERVER_BUSY', 503, 'GitGuide is busy right now. Please try again in a few seconds.', 10));
        }, timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }
}

export class DailyBudget {
  private day = '';
  private used = 0;

  constructor(
    private readonly limit: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private rollover(): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }

  get usedToday(): number {
    this.rollover();
    return this.used;
  }

  /** Records one AI call, or throws once today's budget (UTC) is spent. A limit of 0
   * disables the budget. */
  consume(): void {
    this.rollover();
    const limit = this.limit();
    if (limit > 0 && this.used >= limit) {
      const now = this.now();
      const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      throw new ApiError(
        'DAILY_BUDGET_EXHAUSTED',
        503,
        "GitGuide has reached today's usage limit. Please try again tomorrow.",
        Math.max(60, Math.ceil((midnight - now.getTime()) / 1000)),
      );
    }
    this.used++;
  }
}

let aiSemaphore: Semaphore | null = null;
export const dailyBudget = new DailyBudget(() => getConfig().limits.dailyAiRequestBudget);

function semaphore(): Semaphore {
  if (!aiSemaphore) aiSemaphore = new Semaphore(getConfig().limits.maxConcurrentAiRequests);
  return aiSemaphore;
}

/** Runs one AI provider call inside the global concurrency limit and daily budget. */
export async function withAiSlot<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  dailyBudget.consume();
  const release = await semaphore().acquire({ signal, timeoutMs: getConfig().limits.aiQueueTimeoutMs });
  try {
    return await fn();
  } finally {
    release();
  }
}

export function aiGuardStats(): { inUse: number; queued: number; usedToday: number } {
  const s = semaphore();
  return { inUse: s.inUse, queued: s.queued, usedToday: dailyBudget.usedToday };
}

export function resetAiGuardForTests(): void {
  aiSemaphore = null;
}
