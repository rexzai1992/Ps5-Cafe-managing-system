/**
 * Fixed-window request counter per key (e.g. "reserve:<ip>"). In memory only: a restart resets it, which is
 * acceptable for a LAN booking page. Old windows are swept as keys are touched.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  public constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Records one attempt. Returns 0 if allowed, otherwise the seconds until the key may try again. */
  take(key: string): number {
    const now = this.now();
    if (this.hits.size > 10_000) {
      for (const [stale, entry] of this.hits) if (now - entry.windowStart >= this.windowMs) this.hits.delete(stale);
    }
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      return 0;
    }
    if (entry.count >= this.limit) return Math.max(1, Math.ceil((entry.windowStart + this.windowMs - now) / 1000));
    entry.count += 1;
    return 0;
  }
}
