'use strict';

const request              = require('supertest');
const { GenericContainer } = require('testcontainers');
const Redis                = require('ioredis');

const { RedisLimiter }  = require('../src/limiter/redisLimiter');
const { FakeTime }      = require('../src/time/timeSource');
const { createApp }     = require('../src/server');

// ── Shared config (matches policies.yaml exactly) ─────────────────────────────

const CONFIG = {
  tiers: {
    starter: { rpm: 60,  capacity: 60  },
    growth:  { rpm: 300, capacity: 300 },
  },
  customers: {
    acme:      { tier: 'growth' },
    globex:    { tier: 'growth' },
    northwind: { tier: 'growth' },
  },
  overrides: [
    {
      id:          'northwind-nightly-batch',
      customer_id: 'northwind',
      rpm:         1500,
      capacity:    1500,
      schedule:    { start: '02:00', end: '04:00', timezone: 'UTC' },
      reason:      'Approved nightly batch workload — commercial bridge',
      approved_by: 'priya.nair@relayapi',
      ticket:      'OPS-4471',
      expires:     '2026-06-01T00:00:00Z',
    },
  ],
};

// Fixed epoch — outside any override window (10:00 UTC on 2026-01-15).
const T0 = Date.UTC(2026, 0, 15, 10, 0, 0, 0);

// UTC timestamp helper
function utc(h, m, s = 0, ms = 0) {
  return Date.UTC(2026, 0, 15, h, m, s, ms);
}

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
}, 120_000);

afterAll(async () => {
  await redisClient.quit();
  await container.stop();
});

beforeEach(async () => {
  await redisClient.flushdb();
  // Restore env var if a test changed it.
  delete process.env.RATE_LIMIT_TEST_MODE;
});

// Helper: creates an app with a FakeTime set to the given epoch ms.
function makeApp(nowMs = T0) {
  return createApp({ config: CONFIG, limiter, timeSource: new FakeTime(nowMs), nodeId: 'test-node' });
}

// Helper: creates an app whose limiter always throws (simulates Redis outage).
function makeAppWithBrokenLimiter() {
  const broken = { check: async () => { throw new Error('simulated Redis failure'); } };
  return createApp({ config: CONFIG, limiter: broken, timeSource: new FakeTime(T0), nodeId: 'test-node' });
}

// Helper: seed bucket state directly without going through the public API.
function seedBucket(customerId, tokens, tsMs = T0) {
  return redisClient.hmset(`rl:${customerId}`, 'tokens', String(tokens), 'ts', String(tsMs));
}

// ── 200 OK ────────────────────────────────────────────────────────────────────

describe('200 OK', () => {
  test('returns 200 and ok:true when bucket has tokens', async () => {
    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('includes node ID in response body', async () => {
    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.body.node).toBe('test-node');
  });

  test('includes X-RateLimit headers on 200', async () => {
    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.headers['x-ratelimit-limit']).toBe('300');
    expect(res.headers['x-ratelimit-remaining']).toBe('299'); // 300 - 1
    expect(res.headers['x-ratelimit-policy']).toBe('growth');
  });

  test('X-RateLimit-Remaining decrements on successive allowed requests', async () => {
    const app = makeApp();

    const r1 = await request(app).get('/api/v1/ping').set('X-Customer-Id', 'acme');
    const r2 = await request(app).get('/api/v1/ping').set('X-Customer-Id', 'acme');

    expect(r1.headers['x-ratelimit-remaining']).toBe('299');
    expect(r2.headers['x-ratelimit-remaining']).toBe('298');
  });
});

// ── 429 Too Many Requests ─────────────────────────────────────────────────────

describe('429 Too Many Requests', () => {
  test('returns 429 when bucket is exhausted', async () => {
    await seedBucket('acme', 0, T0);

    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
  });

  test('Retry-After header is present on 429', async () => {
    await seedBucket('acme', 0, T0);

    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.headers['retry-after']).toBeDefined();
    expect(parseInt(res.headers['retry-after'], 10)).toBeGreaterThanOrEqual(1);
  });

  test('Retry-After is minimum 1 second even for sub-second waits', async () => {
    // 0 tokens at T0, refill_rate=5 tok/s → retry_after_ms=200 → ceil(200/1000)=1
    await seedBucket('acme', 0, T0);

    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.retry_after_ms).toBe(200);
  });

  test('X-RateLimit-Remaining is 0 on 429', async () => {
    await seedBucket('acme', 0, T0);

    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  test('X-RateLimit headers are present on 429', async () => {
    await seedBucket('acme', 0, T0);

    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.headers['x-ratelimit-limit']).toBe('300');
    expect(res.headers['x-ratelimit-policy']).toBe('growth');
  });
});

// ── 503 Service Unavailable ───────────────────────────────────────────────────

describe('503 Service Unavailable (Redis failure)', () => {
  test('returns 503 when Redis throws', async () => {
    const res = await request(makeAppWithBrokenLimiter())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('rate_limiter_unavailable');
  });

  test('503 carries Retry-After: 5', async () => {
    const res = await request(makeAppWithBrokenLimiter())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.headers['retry-after']).toBe('5');
  });

  test('503 is not returned when Redis is healthy', async () => {
    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'acme');

    expect(res.status).not.toBe(503);
  });
});

// ── 400 Bad Request ───────────────────────────────────────────────────────────

describe('400 Bad Request', () => {
  test('returns 400 when X-Customer-Id header is missing', async () => {
    const res = await request(makeApp()).get('/api/v1/ping');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_customer_id');
  });

  test('returns 400 for an unknown customer ID', async () => {
    const res = await request(makeApp())
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'no-such-customer');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_customer_id');
  });
});

// ── X-Test-Time-Ms header (PRD §10) ──────────────────────────────────────────

describe('X-Test-Time-Ms header', () => {
  afterEach(() => { delete process.env.RATE_LIMIT_TEST_MODE; });

  test('header controls policy when RATE_LIMIT_TEST_MODE=true', async () => {
    process.env.RATE_LIMIT_TEST_MODE = 'true';

    // FakeTime says 10:00 UTC (base policy).
    // Header injects 02:30 UTC (inside northwind override window).
    const app = createApp({
      config:      CONFIG,
      limiter,
      timeSource:  new FakeTime(utc(10, 0)),
      nodeId:      'test-node',
    });

    const res = await request(app)
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'northwind')
      .set('X-Test-Time-Ms', String(utc(2, 30)));

    expect(res.status).toBe(200);
    // Override policy was applied (capacity 1500, not 300).
    expect(res.headers['x-ratelimit-limit']).toBe('1500');
    expect(res.headers['x-ratelimit-policy']).toBe('northwind-nightly-batch');
  });

  test('header is silently ignored when RATE_LIMIT_TEST_MODE is not set', async () => {
    // No RATE_LIMIT_TEST_MODE — FakeTime (10:00 UTC) must win, not the header.
    const app = createApp({
      config:      CONFIG,
      limiter,
      timeSource:  new FakeTime(utc(10, 0)),
      nodeId:      'test-node',
    });

    const res = await request(app)
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'northwind')
      .set('X-Test-Time-Ms', String(utc(2, 30)));

    expect(res.status).toBe(200);
    // Base policy was applied — header was ignored.
    expect(res.headers['x-ratelimit-limit']).toBe('300');
    expect(res.headers['x-ratelimit-policy']).toBe('growth');
  });

  test('header is silently ignored when RATE_LIMIT_TEST_MODE=false', async () => {
    process.env.RATE_LIMIT_TEST_MODE = 'false';

    const app = createApp({
      config:      CONFIG,
      limiter,
      timeSource:  new FakeTime(utc(10, 0)),
      nodeId:      'test-node',
    });

    const res = await request(app)
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'northwind')
      .set('X-Test-Time-Ms', String(utc(2, 30)));

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-policy']).toBe('growth');
  });
});

// ── Policy headers reflect effective policy ───────────────────────────────────

describe('policy headers', () => {
  test('northwind inside override window reports override policy and 1500 cap', async () => {
    process.env.RATE_LIMIT_TEST_MODE = 'true';

    const app = makeApp(utc(2, 30));

    const res = await request(app)
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'northwind');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('1500');
    expect(res.headers['x-ratelimit-policy']).toBe('northwind-nightly-batch');
  });

  test('northwind outside override window reports base policy and 300 cap', async () => {
    const res = await request(makeApp(utc(10, 0)))
      .get('/api/v1/ping')
      .set('X-Customer-Id', 'northwind');

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('300');
    expect(res.headers['x-ratelimit-policy']).toBe('growth');
  });
});
