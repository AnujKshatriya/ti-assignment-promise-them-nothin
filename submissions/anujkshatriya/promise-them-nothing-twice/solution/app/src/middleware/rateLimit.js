'use strict';

const { resolvePolicy } = require('../policy/resolver');

/**
 * Returns an Express middleware that enforces per-customer token-bucket limits.
 *
 * Dependency-injected so the middleware can be tested without touching the
 * file system, Redis, or the system clock.
 *
 * @param {{ config: object, limiter: object, timeSource: object }} deps
 */
function createRateLimitMiddleware({ config, limiter, timeSource }) {
  return async (req, res, next) => {
    // ── 1. Validate customer identity ───────────────────────────────────────
    const customerId = req.headers['x-customer-id'];
    if (!customerId) {
      return res.status(400).json({ error: 'missing_customer_id' });
    }

    // ── 2. Resolve nowMs — computed once and shared for both policy lookup
    //       and Redis check to ensure they see the same instant.
    //       In test mode the caller may inject a virtual timestamp via header
    //       (PRD §10) — guarded by RATE_LIMIT_TEST_MODE env var so it is
    //       silently ignored in any other configuration.
    let nowMs;
    const testHeader = req.headers['x-test-time-ms'];
    if (process.env.RATE_LIMIT_TEST_MODE === 'true' && testHeader) {
      const parsed = parseInt(testHeader, 10);
      nowMs = Number.isFinite(parsed) ? parsed : timeSource.now();
    } else {
      nowMs = timeSource.now();
    }

    // ── 3. Resolve effective policy (pure, no I/O) ──────────────────────────
    let policy;
    try {
      policy = resolvePolicy(customerId, nowMs, config);
    } catch {
      // resolvePolicy throws only for unknown customer IDs.
      return res.status(400).json({ error: 'unknown_customer_id' });
    }

    // ── 4. Enforce via Redis (atomic Lua script) ────────────────────────────
    let result;
    try {
      result = await limiter.check(customerId, nowMs, policy);
    } catch {
      // Redis unavailable — fail closed with 503 (PRD §11).
      // 429 would be semantically wrong here: the customer is not over quota;
      // we cannot make an authoritative decision.
      return res
        .status(503)
        .set('Retry-After', '5')
        .json({ error: 'rate_limiter_unavailable' });
    }

    // ── 5. Set rate-limit headers (present on every 200 and 429) ───────────
    res.set('X-RateLimit-Limit',  String(policy.capacity));
    res.set('X-RateLimit-Policy', policy.policyId);

    if (result.allowed) {
      res.set('X-RateLimit-Remaining', String(result.remaining));
      return next();
    }

    // ── 6. Customer over quota ──────────────────────────────────────────────
    // Retry-After is ceil(ms/1000), minimum 1 s (PRD §13).
    const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    return res
      .status(429)
      .set('Retry-After',           String(retryAfterSec))
      .set('X-RateLimit-Remaining', '0')
      .json({ error: 'rate_limited', retry_after_ms: result.retryAfterMs });
  };
}

module.exports = { createRateLimitMiddleware };
