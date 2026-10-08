import { describe, it, expect } from 'vitest';
import { DailyBudget, Semaphore } from './ai-guard';

describe('Semaphore', () => {
  it('limits concurrency and hands slots to waiters in order', async () => {
    const s = new Semaphore(1);
    const release1 = await s.acquire();
    const order: number[] = [];
    const p2 = s.acquire().then((r) => {
      order.push(2);
      return r;
    });
    const p3 = s.acquire().then((r) => {
      order.push(3);
      return r;
    });
    expect(s.queued).toBe(2);
    release1();
    (await p2)();
    (await p3)();
    expect(order).toEqual([2, 3]);
    expect(s.inUse).toBe(0);
  });

  it('rejects with SERVER_BUSY when no slot frees up in time', async () => {
    const s = new Semaphore(1);
    await s.acquire();
    await expect(s.acquire({ timeoutMs: 5 })).rejects.toMatchObject({ code: 'SERVER_BUSY', retryAfterSec: 10 });
    expect(s.queued).toBe(0);
  });

  it('removes an aborted waiter from the queue', async () => {
    const s = new Semaphore(1);
    const release = await s.acquire();
    const controller = new AbortController();
    const waiting = s.acquire({ signal: controller.signal });
    controller.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    release();
    expect(s.inUse).toBe(0);
  });

  it('ignores a double release', async () => {
    const s = new Semaphore(2);
    const r = await s.acquire();
    r();
    r();
    expect(s.inUse).toBe(0);
  });
});

describe('DailyBudget', () => {
  it('stops at the limit and resets at UTC midnight', () => {
    let now = new Date('2026-10-07T23:59:00Z');
    const budget = new DailyBudget(() => 2, () => now);
    budget.consume();
    budget.consume();
    expect(() => budget.consume()).toThrow(expect.objectContaining({ code: 'DAILY_BUDGET_EXHAUSTED' }));
    now = new Date('2026-10-08T00:00:01Z');
    expect(() => budget.consume()).not.toThrow();
  });

  it('treats 0 as unlimited', () => {
    const budget = new DailyBudget(() => 0);
    for (let i = 0; i < 100; i++) budget.consume();
    expect(budget.usedToday).toBe(100);
  });
});
