'use strict';

const { resolvePolicy } = require('../src/policy/resolver');

// Inline config — matches policies.yaml exactly.
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

// UTC timestamp for 2026-01-15 at H:M:S.ms
function utc(h, m, s = 0, ms = 0) {
  return Date.UTC(2026, 0, 15, h, m, s, ms);
}

// ── Base tier resolution ──────────────────────────────────────────────────────

describe('base tier', () => {
  test('acme always gets growth policy (no override)', () => {
    expect(resolvePolicy('acme', utc(12, 0), CONFIG)).toEqual({
      refillRate: 5,
      capacity:   300,
      policyId:   'growth',
    });
  });

  test('northwind outside override window gets growth policy', () => {
    expect(resolvePolicy('northwind', utc(10, 0), CONFIG)).toEqual({
      refillRate: 5,
      capacity:   300,
      policyId:   'growth',
    });
  });

  test('throws for unknown customer', () => {
    expect(() => resolvePolicy('unknown-corp', utc(12, 0), CONFIG)).toThrow(
      'Unknown customer: "unknown-corp"'
    );
  });
});

// ── Override activation ───────────────────────────────────────────────────────

describe('override activation', () => {
  test('northwind at 02:30 UTC gets override policy', () => {
    expect(resolvePolicy('northwind', utc(2, 30), CONFIG)).toEqual({
      refillRate: 25,
      capacity:   1500,
      policyId:   'northwind-nightly-batch',
    });
  });

  test('northwind at 03:00 UTC gets override policy', () => {
    expect(resolvePolicy('northwind', utc(3, 0), CONFIG).policyId).toBe('northwind-nightly-batch');
  });

  test('acme is unaffected by northwind override at 02:30', () => {
    expect(resolvePolicy('acme', utc(2, 30), CONFIG).policyId).toBe('growth');
  });
});

// ── Half-open interval boundary [02:00:00.000, 04:00:00.000) ─────────────────

describe('half-open interval boundary', () => {
  test('01:59:59.999 → base (just before override starts)', () => {
    expect(resolvePolicy('northwind', utc(1, 59, 59, 999), CONFIG).policyId).toBe('growth');
  });

  test('02:00:00.000 → override (exactly at start)', () => {
    expect(resolvePolicy('northwind', utc(2, 0, 0, 0), CONFIG).policyId).toBe('northwind-nightly-batch');
  });

  test('03:59:59.999 → override (last ms before end)', () => {
    expect(resolvePolicy('northwind', utc(3, 59, 59, 999), CONFIG).policyId).toBe('northwind-nightly-batch');
  });

  test('04:00:00.000 → base (exactly at end, exclusive)', () => {
    expect(resolvePolicy('northwind', utc(4, 0, 0, 0), CONFIG).policyId).toBe('growth');
  });
});

// ── Expiry ────────────────────────────────────────────────────────────────────

describe('expired override', () => {
  const EXPIRED_CONFIG = {
    ...CONFIG,
    overrides: [{ ...CONFIG.overrides[0], expires: '2020-01-01T00:00:00Z' }],
  };

  test('expired override is ignored; falls back to base tier', () => {
    // Request inside the override window but override is expired.
    expect(resolvePolicy('northwind', utc(2, 30), EXPIRED_CONFIG).policyId).toBe('growth');
  });
});

// ── Refill rate arithmetic ────────────────────────────────────────────────────

describe('refill rate', () => {
  test('growth tier: 300 RPM → 5 tokens/sec', () => {
    expect(resolvePolicy('acme', utc(12, 0), CONFIG).refillRate).toBe(5);
  });

  test('override: 1500 RPM → 25 tokens/sec', () => {
    expect(resolvePolicy('northwind', utc(2, 30), CONFIG).refillRate).toBe(25);
  });

  test('starter tier: 60 RPM → 1 token/sec', () => {
    const starterConfig = {
      ...CONFIG,
      customers: { ...CONFIG.customers, tiny: { tier: 'starter' } },
    };
    expect(resolvePolicy('tiny', utc(12, 0), starterConfig).refillRate).toBe(1);
  });
});
