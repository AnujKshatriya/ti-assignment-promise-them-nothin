'use strict';

const { parseConfig } = require('../src/policy/loader');

// ── Minimal valid configs ─────────────────────────────────────────────────────

const VALID_OVERRIDE = `
    - id: test-override
      customer_id: acme
      rpm: 1000
      capacity: 1000
      schedule:
        start: "02:00"
        end: "04:00"
        timezone: "UTC"
      reason: "Test"
      approved_by: "admin@test"
      ticket: "TEST-1"
      expires: "2030-01-01T00:00:00Z"
`;

const VALID_YAML = `
tiers:
  starter: { rpm: 60, capacity: 60 }
  growth:  { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
overrides:
${VALID_OVERRIDE}
`;

// ── Happy path ────────────────────────────────────────────────────────────────

describe('valid config', () => {
  test('parses without throwing', () => {
    expect(() => parseConfig(VALID_YAML)).not.toThrow();
  });

  test('returns tiers, customers, overrides', () => {
    const c = parseConfig(VALID_YAML);
    expect(c.tiers.starter).toEqual({ rpm: 60, capacity: 60 });
    expect(c.customers.acme).toEqual({ tier: 'growth' });
    expect(c.overrides).toHaveLength(1);
  });

  test('config with no overrides key is valid', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
`;
    expect(() => parseConfig(yaml)).not.toThrow();
  });

  test('config with empty overrides list is valid', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
overrides: []
`;
    expect(() => parseConfig(yaml)).not.toThrow();
  });
});

// ── Missing required override fields ─────────────────────────────────────────

describe('missing override fields', () => {
  function yamlWithout(field) {
    // Construct an override that's missing one top-level field.
    const fields = {
      id:          'test-override',
      customer_id: 'acme',
      rpm:         1000,
      capacity:    1000,
      schedule:    { start: '02:00', end: '04:00', timezone: 'UTC' },
      reason:      'Test',
      approved_by: 'admin@test',
      ticket:      'TEST-1',
      expires:     '2030-01-01T00:00:00Z',
    };
    const { [field]: _dropped, ...rest } = fields;
    // Build inline YAML from the object (simple, since all values are primitives or one-level objects).
    const lines = Object.entries(rest).map(([k, v]) => {
      if (typeof v === 'object') {
        const inner = Object.entries(v).map(([ik, iv]) => `        ${ik}: "${iv}"`).join('\n');
        return `      ${k}:\n${inner}`;
      }
      return `      ${k}: ${JSON.stringify(v)}`;
    });
    return `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
overrides:
  -\n${lines.join('\n')}
`;
  }

  for (const field of ['id', 'customer_id', 'rpm', 'capacity', 'reason', 'approved_by', 'ticket', 'expires']) {
    test(`throws when override is missing "${field}"`, () => {
      expect(() => parseConfig(yamlWithout(field))).toThrow(/missing required field/);
    });
  }

  test('throws when schedule is missing "start"', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
overrides:
  - id: test
    customer_id: acme
    rpm: 1000
    capacity: 1000
    schedule:
      end: "04:00"
      timezone: "UTC"
    reason: "Test"
    approved_by: "admin"
    ticket: "T-1"
    expires: "2030-01-01T00:00:00Z"
`;
    expect(() => parseConfig(yaml)).toThrow(/schedule.*missing required field "start"/);
  });

  test('throws when schedule is missing "end"', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
overrides:
  - id: test
    customer_id: acme
    rpm: 1000
    capacity: 1000
    schedule:
      start: "02:00"
      timezone: "UTC"
    reason: "Test"
    approved_by: "admin"
    ticket: "T-1"
    expires: "2030-01-01T00:00:00Z"
`;
    expect(() => parseConfig(yaml)).toThrow(/schedule.*missing required field "end"/);
  });
});

// ── Validation errors ─────────────────────────────────────────────────────────

describe('validation errors', () => {
  test('throws when customer references unknown tier', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: enterprise }
overrides: []
`;
    expect(() => parseConfig(yaml)).toThrow(/unknown tier "enterprise"/);
  });

  test('throws on duplicate override id', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
overrides:
  - id: dup
    customer_id: acme
    rpm: 1000
    capacity: 1000
    schedule: { start: "02:00", end: "04:00", timezone: "UTC" }
    reason: "First"
    approved_by: "admin"
    ticket: "T-1"
    expires: "2030-01-01T00:00:00Z"
  - id: dup
    customer_id: acme
    rpm: 2000
    capacity: 2000
    schedule: { start: "06:00", end: "08:00", timezone: "UTC" }
    reason: "Second"
    approved_by: "admin"
    ticket: "T-2"
    expires: "2030-01-01T00:00:00Z"
`;
    expect(() => parseConfig(yaml)).toThrow(/duplicate override id "dup"/);
  });

  test('throws on invalid expires date string', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
overrides:
  - id: test
    customer_id: acme
    rpm: 1000
    capacity: 1000
    schedule: { start: "02:00", end: "04:00", timezone: "UTC" }
    reason: "Test"
    approved_by: "admin"
    ticket: "T-1"
    expires: "not-a-date"
`;
    expect(() => parseConfig(yaml)).toThrow(/not a valid ISO date/);
  });

  test('throws on invalid schedule start format (single-digit hour)', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: { tier: growth }
overrides:
  - id: test
    customer_id: acme
    rpm: 1000
    capacity: 1000
    schedule: { start: "2:00", end: "04:00", timezone: "UTC" }
    reason: "Test"
    approved_by: "admin"
    ticket: "T-1"
    expires: "2030-01-01T00:00:00Z"
`;
    expect(() => parseConfig(yaml)).toThrow(/HH:MM format/);
  });

  test('throws when customer is missing tier field', () => {
    const yaml = `
tiers:
  growth: { rpm: 300, capacity: 300 }
customers:
  acme: {}
overrides: []
`;
    expect(() => parseConfig(yaml)).toThrow(/missing "tier"/);
  });
});
