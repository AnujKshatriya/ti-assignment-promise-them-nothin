'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeConcurrentRequests } = require('../lib/http-client');
const { formatStatusCounts, printStatusTable } = require('../lib/report');

/**
 * Scenario 8: Boundary – Capacity Clamp at 04:00
 *
 * Seed bucket to 1200 tokens with test time 03:59:59.
 * Jump to 04:00:00.
 * Immediately send 400 requests.
 *
 * Expected: ≤300 allowed.
 * Proves min(tokens, new_capacity) clamp.
 * Without this, customer would burst 1200 into the base window.
 */
async function scenario08() {
  flushDB();

  const baseDate = Date.UTC(2026, 0, 15);
  const t0359 = baseDate + 3*3600*1000 + 59*60*1000 + 59*1000;
  const t0400 = baseDate + 4*3600*1000;

  console.log('Configuration:');
  console.log('  Customer: northwind');
  console.log('  Setup: seed to 1200 tokens at 03:59:59 UTC (inside 1500-cap override)');
  console.log('  Action: jump to 04:00:00 UTC (back to 300-cap base), send 400 requests');
  console.log('  Purpose: verify capacity clamp prevents 1200-token carryover');

  seedBucket('northwind', 1200, t0359);

  console.log('\nRequest phase:');
  console.log('  Time: 04:00:00.000 UTC (override expired)');
  console.log('  Effective capacity: 300 (clamped from 1200)');
  console.log('  Requests: 400 concurrent');

  const results = await makeConcurrentRequests(400, { customerId: 'northwind' }, t0400);

  const allowed = results.filter((r) => r.statusCode === 200).length;
  const denied = results.filter((r) => r.statusCode === 429).length;

  console.log('\nResults:');
  printStatusTable(formatStatusCounts(allowed, denied, 0, 0));

  const pass = allowed <= 300 && denied >= 100;

  return {
    pass,
    details: {
      'Allowed (200)': allowed,
      'Denied (429)': denied,
      'Capacity clamp verified': allowed <= 300 ? 'YES (≤300)' : 'NO (>300)',
      'Carryover prevented': denied >= 100 ? 'YES' : 'NO',
      'Expected': '≤300 allowed (proving min(1200, 300) clamp)',
    },
  };
}

module.exports = scenario08;
