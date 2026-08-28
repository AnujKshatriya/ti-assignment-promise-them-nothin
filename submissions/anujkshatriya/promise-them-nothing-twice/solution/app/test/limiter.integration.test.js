'use strict';

const { GenericContainer } = require('testcontainers');
const Redis                = require('ioredis');
const { RedisLimiter }     = require('../src/limiter/redisLimiter');

// ── Test infrastructure ───────────────────────────────────────────────────────

let container;
let redisClient;
let limiter;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  redisClient = new Redis({
    host: container.getHost(),
    port: container.getMappedPort(6379),
  });

  limiter = new RedisLimiter(redisClient);
}, 120_000); // generous timeout: image pull on first run

afterAll(async () => {
  await redisClient.quit();
  await container.stop();
});

beforeEach(async () => {
  // Each test starts with a clean Redis — scenarios are independent.
  await redisClient.flushdb();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Directly seeds bucket state so tests don't depend on the public API to set up.
function seedBucket(customerId, tokens, nowMs) {
  return redisClient.hmset(`rl:${customerId}`, 'tokens', String(tokens), 'ts', String(nowMs));
}

const GROWTH = { refillRate: 5, capacity: 300 };   // 300 RPM tier
const T0     = 1_700_000_000_000;                   // fixed epoch; avoids real-clock dependency

// ── Basic allow / deny ────────────────────────────────────────────────────────

describe('basic allow / deny', () => {
  test('new bucket is implicitly full — first request allowed', async () => {
    const r = await limiter.check('cust-a', T0, GROWTH);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(299);       // 300 - 1
    expect(r.retryAfterMs).toBe(0);
  });

  test('request against empty bucket is denied', async () => {
    await seedBucket('cust-a', 0, T0);
    const r = await limiter.check('cust-a', T0, GROWTH);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  test('retryAfterMs is 0 when request is allowed', async () => {
    const r = await limiter.check('cust-a', T0, GROWTH);
    expect(r.retryAfterMs).toBe(0);
  });

  test('retryAfterMs reflects time to next token — 0 tokens at 5 tok/sec = 200 ms', async () => {
    // ceil((1 - 0) / 5 * 1000) = ceil(200) = 200
    await seedBucket('cust-a', 0, T0);
    const r = await limiter.check('cust-a', T0, GROWTH);
    expect(r.retryAfterMs).toBe(200);
  });

  test('remaining decrements with each allowed request', async () => {
    await seedBucket('cust-a', 3, T0);
    const r1 = await limiter.check('cust-a', T0, GROWTH);
    const r2 = await limiter.check('cust-a', T0, GROWTH);
    const r3 = await limiter.check('cust-a', T0, GROWTH);
    expect(r1.remaining).toBe(2);
    expect(r2.remaining).toBe(1);
    expect(r3.remaining).toBe(0);
    // Bucket is now empty at T0 — next call at T0 denied
    const r4 = await limiter.check('cust-a', T0, GROWTH);
    expect(r4.allowed).toBe(false);
  });
});

// ── Refill math ───────────────────────────────────────────────────────────────

describe('refill math', () => {
  test('tokens refill proportionally to elapsed time', async () => {
    // Start empty at T0; 10 s later → 50 tokens refilled (10s × 5 tok/s)
    await seedBucket('cust-a', 0, T0);
    const r = await limiter.check('cust-a', T0 + 10_000, GROWTH);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(49);        // floor(50 - 1)
  });

  test('partial refill (fractional tokens) — 100 ms at 5 tok/sec = 0.5 token', async () => {
    // 0 tokens + 0.5 refilled < 1 → still denied; retry in 100 ms
    // ceil((1 - 0.5) / 5 * 1000) = ceil(100) = 100
    await seedBucket('cust-a', 0, T0);
    const r = await limiter.check('cust-a', T0 + 100, GROWTH);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(100);
  });

  test('nowMs is used for elapsed calculation, not system clock', async () => {
    // Inject an arbitrary past timestamp — verifies the script reads ARGV[1], not CLOCK
    const fakePast    = 1_000_000;
    const fakePresent = 1_001_000;          // 1 second later
    await seedBucket('cust-a', 0, fakePast);
    // 1 s at 5 tok/s → 5 tokens refilled → allow, remaining = 4
    const r = await limiter.check('cust-a', fakePresent, GROWTH);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
  });

  test('backward clock skew produces no negative refill (elapsed clamped to 0)', async () => {
    // now_ms < last_ts: elapsed = max(0, negative) = 0, no refill
    await seedBucket('cust-a', 0, T0 + 5_000);    // ts is 5 s in the future
    const r = await limiter.check('cust-a', T0, GROWTH);
    expect(r.allowed).toBe(false);                // still 0 tokens, no refill
  });
});

// ── Capacity invariant ────────────────────────────────────────────────────────

describe('capacity invariant', () => {
  test('tokens never exceed capacity after long idle', async () => {
    const tiny = { refillRate: 5, capacity: 10 };
    // Start empty; 1 hour later would produce 18 000 tokens without clamping
    await seedBucket('cust-a', 0, T0);
    const r = await limiter.check('cust-a', T0 + 3_600_000, tiny);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);                  // min(10, 18000) - 1 = 9
  });

  test('capacity clamp on policy downshift (PRD §9)', async () => {
    // Simulate: bucket held 1200 tokens during the 1500-RPM override window.
    // Override expires at 04:00; next request uses base policy (capacity 300).
    // Expected: refilled = min(300, 1200 + 0) = 300; allow; remaining = 299.
    await seedBucket('cust-a', 1200, T0);
    const r = await limiter.check('cust-a', T0, GROWTH);  // capacity=300
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(299);                // NOT 1199
  });

  test('capacity clamp also works for capacity increase (upshift)', async () => {
    // Bucket has 300 tokens; policy upgrades to capacity=1500.
    // refilled = min(1500, 300 + 0) = 300; allow; remaining = 299.
    const override = { refillRate: 25, capacity: 1500 };
    await seedBucket('cust-a', 300, T0);
    const r = await limiter.check('cust-a', T0, override);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(299);               // no free jump to 1500
  });
});

// ── Atomicity under concurrent requests ──────────────────────────────────────

describe('atomicity', () => {
  test('exactly 1 of 50 concurrent requests wins the last token', async () => {
    // Seed exactly 1 token; fire 50 parallel requests.
    // Redis executes the Lua script single-threaded: exactly one call
    // will see ≥ 1 token; all others will see 0.
    await seedBucket('cust-a', 1, T0);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.check('cust-a', T0, GROWTH))
    );

    const allowed = results.filter(r => r.allowed);
    const denied  = results.filter(r => !r.allowed);

    expect(allowed).toHaveLength(1);
    expect(denied).toHaveLength(49);
  });

  test('customer isolation — A exhausting budget does not affect B', async () => {
    // A has 0 tokens; B has 5 tokens.
    await seedBucket('cust-a', 0, T0);
    await seedBucket('cust-b', 5, T0);

    const rA = await limiter.check('cust-a', T0, GROWTH);
    const rB = await limiter.check('cust-b', T0, GROWTH);

    expect(rA.allowed).toBe(false);
    expect(rB.allowed).toBe(true);
    expect(rB.remaining).toBe(4);
  });
});
