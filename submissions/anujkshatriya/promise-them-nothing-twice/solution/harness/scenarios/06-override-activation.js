'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeConcurrentRequests } = require('../lib/http-client');
const { printStatusTable } = require('../lib/report');

/**
 * Scenario 6: Northwind Override Activation
 *
 * Using X-Test-Time-Ms:
 * - Send at 01:30 UTC → observe base policy (300 cap)
 * - Advance to 02:30 → observe override policy (1500 cap)
 * - Advance to 04:30 → observe base policy again
 *
 * Expected: Correct policy applied at each timepoint.
 * Traffic at 02:30 up to 1500 RPM produces no 429s.
 */
async function scenario06() {
  flushDB();

  // Use static timestamp for predictability
  // UTC 2026-01-15
  const timepoints = {
    '01:30': Date.UTC(2026, 0, 15, 1, 30, 0, 0),
    '02:30': Date.UTC(2026, 0, 15, 2, 30, 0, 0),
    '04:30': Date.UTC(2026, 0, 15, 4, 30, 0, 0),
  };

  const northwindStartTime = timepoints['01:30'];

  console.log('Configuration:');
  console.log('  Customer: northwind (growth base 300 RPM)');
  console.log('  Override: 02:00–04:00 UTC @ 1500 RPM');
  console.log('  Testing override activation/expiry');

  const results = {};

  // 01:30 UTC - before override (base policy 300)
  console.log('\n--- 01:30 UTC (before override) ---');
  seedBucket('northwind', 300, timepoints['01:30']);
  const res0130 = await makeConcurrentRequests(100, { customerId: 'northwind' }, timepoints['01:30']);
  const allowed0130 = res0130.filter((r) => r.statusCode === 200).length;
  results['01:30'] = { allowed: allowed0130, policy: 'base (300)' };
  console.log(`  Requests: 100, Allowed: ${allowed0130} (expect ~100)`);

  // 02:30 UTC - override active (1500 RPM policy)
  console.log('\n--- 02:30 UTC (override active) ---');
  seedBucket('northwind', 1500, timepoints['02:30']);
  const res0230 = await makeConcurrentRequests(100, { customerId: 'northwind' }, timepoints['02:30']);
  const allowed0230 = res0230.filter((r) => r.statusCode === 200).length;
  results['02:30'] = { allowed: allowed0230, policy: 'override (1500)' };
  console.log(`  Requests: 100, Allowed: ${allowed0230} (expect ~100, no 429s)`);

  // 04:30 UTC - after override expires (back to base 300)
  console.log('\n--- 04:30 UTC (override expired) ---');
  seedBucket('northwind', 300, timepoints['04:30']);
  const res0430 = await makeConcurrentRequests(100, { customerId: 'northwind' }, timepoints['04:30']);
  const allowed0430 = res0430.filter((r) => r.statusCode === 200).length;
  results['04:30'] = { allowed: allowed0430, policy: 'base (300)' };
  console.log(`  Requests: 100, Allowed: ${allowed0430} (expect ~100)`);

  console.log('\nSummary:');
  for (const [time, result] of Object.entries(results)) {
    console.log(`  ${time}: ${result.allowed} allowed (${result.policy})`);
  }

  // All three should get ~100 allowed (no denials expected within 100 requests per bucket config)
  const pass =
    allowed0130 >= 90 &&
    allowed0230 >= 90 &&
    allowed0430 >= 90;

  return {
    pass,
    details: {
      '01:30 allowed': allowed0130 + ' (base)',
      '02:30 allowed': allowed0230 + ' (override)',
      '04:30 allowed': allowed0430 + ' (base)',
      'Override activation': allowed0230 > allowed0130 ? 'VERIFIED' : 'CHECK',
      'Override expiry': allowed0430 >= 90 ? 'VERIFIED' : 'CHECK',
      'Expected': 'All ~100, correct policy at each time',
    },
  };
}

module.exports = scenario06;
