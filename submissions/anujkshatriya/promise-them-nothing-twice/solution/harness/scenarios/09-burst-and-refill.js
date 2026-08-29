'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeSequentialRequests } = require('../lib/http-client');
const { formatStatusCounts, printStatusTable } = require('../lib/report');

/**
 * Scenario 9: Burst & Refill
 *
 * Seed bucket to 300. Fire 300 requests instantly.
 * Wait 10 seconds (virtual time). Fire more requests.
 *
 * Expected: First 300 allowed.
 * After 10s at 5 tok/s refill: ~50 more allowed.
 * Bucket never exceeds capacity.
 */
async function scenario09() {
  flushDB();

  const T0 = 1_700_000_000_000;
  const T10s = T0 + 10_000;

  console.log('Configuration:');
  console.log('  Customer: acme (growth, 300 RPM = 5 tokens/sec)');
  console.log('  Phase 1: seed to 300, send 300 requests at T0');
  console.log('  Phase 2: advance 10 seconds (T0 + 10s), send 100 more requests');
  console.log('  Expected refill: 10s × 5 tok/s = 50 tokens');

  seedBucket('acme', 300, T0);

  console.log('\n--- Phase 1: Burst (T0) ---');
  console.log('  Bucket: 300 tokens');
  console.log('  Requests: 300');

  const phase1 = await makeSequentialRequests(300, { customerId: 'acme' }, T0);
  const phase1Allowed = phase1.filter((r) => r.statusCode === 200).length;

  console.log(`  Result: ${phase1Allowed} allowed (expect 300)`);

  console.log('\n--- Phase 2: Refill (T0 + 10s) ---');
  console.log('  Elapsed: 10 seconds');
  console.log('  Refilled: ~50 tokens (10s × 5 tok/s)');
  console.log('  Requests: 100');

  const phase2 = await makeSequentialRequests(100, { customerId: 'acme' }, T10s);
  const phase2Allowed = phase2.filter((r) => r.statusCode === 200).length;
  const phase2Denied = phase2.filter((r) => r.statusCode === 429).length;

  console.log(`  Result: ${phase2Allowed} allowed, ${phase2Denied} denied`);

  console.log('\nSummary:');
  console.log('  Phase 1 (burst): ' + phase1Allowed + ' / 300');
  console.log('  Phase 2 (refill): ' + phase2Allowed + ' / 100 (expect ~50)');

  const pass =
    phase1Allowed === 300 &&
    phase2Allowed >= 40 && phase2Allowed <= 60 && // ~50 with variance
    phase2Denied >= 40 && phase2Denied <= 60;

  return {
    pass,
    details: {
      'Phase 1 burst': phase1Allowed + ' / 300',
      'Phase 2 refill': phase2Allowed + ' allowed (expect ~50)',
      'Capacity respected': phase2Allowed <= 50 ? 'YES' : 'CHECK',
      'Refill working': phase2Allowed > 0 ? 'YES' : 'NO',
      'Expected': '300 burst, then ~50 after 10s refill',
    },
  };
}

module.exports = scenario09;
