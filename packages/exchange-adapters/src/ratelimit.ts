export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export interface RateLimitConfig {
  /** request-weight budget: capacity units, refilled at refillPerSec units/second */
  capacity: number; refillPerSec: number;
  backoffBaseMs: number; backoffCapMs: number; maxAttempts: number;
  jitter: 'full' | 'equal' | 'none';
}
export class RateLimitedError extends Error { constructor(public attempts: number, public lastStatus: number) { super(`still rate limited after ${attempts} attempts`); } }
export interface ExecOpts { weight: number; /** ONLY set true for idempotent reads. Order creation must be retryable:false. */ retryable: boolean }

/**
 * Weight-budget limiter + 429 exponential backoff with jitter. Clock and RNG are injectable for deterministic tests.
 * A 429 puts the whole limiter in cooldown (all callers wait), and Retry-After (seconds) is a floor on the delay.
 */
export class RateLimitManager {
  private tokens: number; private lastRefill: number; private cooldownUntil = 0;
  readonly log: { t: number; event: string; ms?: number }[] = [];
  constructor(private readonly cfg: RateLimitConfig, private readonly clock: Clock = systemClock, private readonly random: () => number = Math.random) {
    if (cfg.capacity <= 0 || cfg.refillPerSec <= 0 || cfg.maxAttempts < 1) throw new Error('bad rate limit config');
    this.tokens = cfg.capacity; this.lastRefill = clock.now();
  }
  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.cfg.capacity, this.tokens + ((now - this.lastRefill) / 1000) * this.cfg.refillPerSec);
    this.lastRefill = now;
  }
  /** waits (via clock.sleep) until the weight budget and any cooldown allow the request */
  async acquire(weight: number): Promise<void> {
    if (weight <= 0 || weight > this.cfg.capacity) throw new Error(`weight ${weight} exceeds capacity ${this.cfg.capacity}`);
    for (;;) {
      const now = this.clock.now();
      if (now < this.cooldownUntil) { const ms = this.cooldownUntil - now; this.log.push({ t: now, event: 'cooldown_wait', ms }); await this.clock.sleep(ms); continue; }
      this.refill();
      if (this.tokens >= weight) { this.tokens -= weight; return; }
      const ms = Math.ceil(((weight - this.tokens) / this.cfg.refillPerSec) * 1000);
      this.log.push({ t: now, event: 'budget_wait', ms });
      await this.clock.sleep(ms);
    }
  }
  backoffDelay(attempt: number, retryAfterSec?: number): number {
    const exp = Math.min(this.cfg.backoffCapMs, this.cfg.backoffBaseMs * 2 ** attempt);
    const j = this.cfg.jitter === 'full' ? this.random() * exp : this.cfg.jitter === 'equal' ? exp / 2 + (this.random() * exp) / 2 : exp;
    const floor = retryAfterSec !== undefined && Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 0;
    return Math.ceil(Math.max(j, floor));
  }
  async execute<T>(opts: ExecOpts, fn: () => Promise<T>): Promise<T> {
    let lastStatus = 429;
    for (let attempt = 0; attempt < this.cfg.maxAttempts; attempt++) {
      await this.acquire(opts.weight);
      try { return await fn(); } catch (e) {
        const status = (e as { status?: number }).status;
        if (status !== 429) throw e;
        lastStatus = status;
        if (!opts.retryable) throw e; // never auto-retry non-idempotent calls
        if (attempt === this.cfg.maxAttempts - 1) break;
        const delay = this.backoffDelay(attempt, (e as { retryAfterSec?: number }).retryAfterSec);
        this.cooldownUntil = Math.max(this.cooldownUntil, this.clock.now() + delay);
        this.log.push({ t: this.clock.now(), event: '429_backoff', ms: delay });
      }
    }
    throw new RateLimitedError(this.cfg.maxAttempts, lastStatus);
  }
}
/** Deterministic fake clock: sleep() advances virtual time instantly. */
export class FakeClock implements Clock {
  constructor(public t = 0) {}
  now(): number { return this.t; }
  async sleep(ms: number): Promise<void> { this.t += ms; }
}
