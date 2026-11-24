import type { NextFunction, Request, Response } from "express";

/** Fixed-window, in-memory rate limiter (issue #18). Fine for the single
 * production instance; swap for a shared store if the hub is ever scaled out. */
export function createRateLimiter({ limit, windowMs, maxKeys = 10_000 }: { limit: number; windowMs: number; maxKeys?: number }) {
  const windows = new Map<string, { start: number; count: number }>();

  // Drop stale windows so the map can't grow without bound.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, w] of windows) if (w.start < cutoff) windows.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    check(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
      const now = Date.now();
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        // Refuse new identities at capacity instead of evicting active budgets.
        if (!w && windows.size >= maxKeys) {
          for (const [k, value] of windows) if (now - value.start >= windowMs) windows.delete(k);
          if (windows.size >= maxKeys) return { ok: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
        }
        windows.set(key, { start: now, count: 1 });
        return { ok: true };
      }
      if (w.count >= limit) return { ok: false, retryAfterSeconds: Math.ceil((w.start + windowMs - now) / 1000) };
      w.count++;
      return { ok: true };
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

/** This limiter runs BEFORE authentication. An arbitrary bearer must never buy a fresh budget.
 * REST and MCP resolve client IP through the same trusted-proxy policy. */
export function rateLimitKey(_authorization: string | undefined, ip: string | undefined): string {
  return `ip:${ip ?? "unknown"}`;
}

/**
 * @param exempt Paths this limiter must NOT throttle, matched exactly. Needed because the global
 * limiter is mounted with `app.use(...)` and therefore runs for EVERY request before any route
 * handler -- so a route cannot escape it by adding its own limiter downstream, it can only be
 * exempted here. `POST /v1/billing/webhook` is the reason this exists: it authenticates by HMAC
 * signature and sends no `authorization` header, so it would share the anonymous `ip:` bucket with
 * all other unauthenticated traffic, and a 429 to a retrying provider counts toward the failures
 * that make it disable the endpoint. The exempt route carries its own limiter instead (src/rest.ts).
 */
export function rateLimitMiddleware(limiter: RateLimiter, { exempt = [] as string[] } = {}) {
  const exemptSet = new Set(exempt);
  return (req: Request, res: Response, next: NextFunction) => {
    if (exemptSet.has(req.path)) return next();
    const result = limiter.check(rateLimitKey(req.header("authorization"), req.ip));
    if (result.ok) return next();
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json({ error: "rate limit exceeded", retryAfterSeconds: result.retryAfterSeconds });
  };
}

export const requestsPerMinute = () => Number(process.env.OPENCADRE_RATE_LIMIT_PER_MIN) || 600;
