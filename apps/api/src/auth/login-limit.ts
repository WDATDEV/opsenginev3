export const LOGIN_MAX_FAILURES = 8;
export const LOGIN_LOCK_MS = 15 * 60_000;
const MAX_TRACKED = 5000;

type Entry = { failures: number; firstAt: number; lockedUntil: number };

/** Slows password guessing. Counted per email, in this API process. */
export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();

  retryAfterMs(email: string, now = Date.now()) {
    const entry = this.entries.get(email);
    if (!entry) return 0;
    if (entry.lockedUntil > now) return entry.lockedUntil - now;
    if (entry.lockedUntil || now - entry.firstAt > LOGIN_LOCK_MS) this.entries.delete(email);
    return 0;
  }

  fail(email: string, now = Date.now()) {
    let entry = this.entries.get(email);
    if (!entry || now - entry.firstAt > LOGIN_LOCK_MS) {
      if (!entry && this.entries.size >= MAX_TRACKED) this.prune(now);
      entry = { failures: 0, firstAt: now, lockedUntil: 0 };
      this.entries.set(email, entry);
    }
    entry.failures += 1;
    if (entry.failures >= LOGIN_MAX_FAILURES) entry.lockedUntil = now + LOGIN_LOCK_MS;
  }

  succeed(email: string) {
    this.entries.delete(email);
  }

  private prune(now: number) {
    for (const [email, entry] of this.entries) {
      if (entry.lockedUntil <= now && now - entry.firstAt > LOGIN_LOCK_MS) this.entries.delete(email);
    }
    while (this.entries.size >= MAX_TRACKED) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
