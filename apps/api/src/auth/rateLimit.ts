/**
 * In-memory login rate limiter (docs/13 §2): a sliding window of failed attempts
 * per canonicalized (IP + account) key, with an exponential-backoff `retry_after`
 * hint. Blocking is window-based, so it always clears on its own — no self-inflicted
 * permanent lockout / DoS. A successful login clears the key. The clock is injected
 * so tests trip and release the limit deterministically.
 */
import type { Clock } from '@redai/application';

export interface RateLimitConfig {
  maxFailures: number;
  windowMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxFailures: 5,
  windowMs: 5 * 60 * 1000,
  baseDelayMs: 1000,
  maxDelayMs: 60 * 1000,
};

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  public constructor(
    private readonly clock: Clock,
    private readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT,
  ) {}

  /** Canonical key from a socket IP and the attempted account name. */
  static key(ip: string, username: string): string {
    return `${ip.trim().toLowerCase()}|${username}`;
  }

  private prune(key: string, now: number): number[] {
    const cutoff = now - this.config.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length > 0) this.failures.set(key, kept);
    else this.failures.delete(key);
    return kept;
  }

  /** Whether a new attempt is currently allowed. Call before verifying credentials. */
  check(key: string): RateLimitDecision {
    const now = this.clock.now().getTime();
    const recent = this.prune(key, now);
    if (recent.length < this.config.maxFailures) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const oldest = recent[0] ?? now;
    const windowRemaining = this.config.windowMs - (now - oldest);
    const overBy = recent.length - this.config.maxFailures + 1;
    const backoff = Math.min(this.config.maxDelayMs, this.config.baseDelayMs * 2 ** overBy);
    const retryAfterMs = Math.max(windowRemaining, backoff);
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }

  recordFailure(key: string): void {
    const now = this.clock.now().getTime();
    const recent = this.prune(key, now);
    recent.push(now);
    this.failures.set(key, recent);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
