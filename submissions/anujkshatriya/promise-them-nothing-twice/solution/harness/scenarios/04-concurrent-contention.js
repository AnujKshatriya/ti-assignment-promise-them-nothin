'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeConcurrentRequests } = require('../lib/http-client');
const { formatStatusCounts, printStatusTable } = require('../lib/report');

/**
 * Scenario 4: Concurrent Single-Token Contention
 *
 * One customer. Seed bucket to exactly 1 token.
 * Fire 100 requests simultaneously across all 3 nodes (through Nginx).
 *
 * Expected: Exactly 1 allowed, exactly 99 denied.
 * Proves the Lua transition is atomic (not two allowed, not zero).
 */
async function scenario04() {
  flushDB();

  const T0 = 1_700_000_000_000;
  seedBucket('acme', 1, T0);

  console.log('Configuration:');
  console.log('  Customer: acme');
  console.log('  Initial bucket: 1 token (exact contention point)');
  console.log('  Requests: 100 concurrent');
  console.log('  Time: frozen at ' + T0);
  console.log('  Purpose: prove atomic Lua script (exactly 1 wins)');

  const results = await makeConcurrentRequests(100, { customerId: 'acme' }, T0);

  const allowed = results.filter((r) => r.statusCode === 200);
  const denied = results.filter((r) => r.statusCode === 429);
  const other = results.filter((r) => r.statusCode !== 200 && r.statusCode !== 429);

  console.log('\nResults:');
  printStatusTable({
    '200 OK': allowed.length,
    '429': denied.length,
    'Other': other.length,
  });

  const pass = allowed.length === 1 && denied.length === 99 && other.length === 0;

  return {
    pass,
    details: {
      '200 OK': allowed.length,
      '429': denied.length,
      'Other': other.length,
      'Atomicity': pass ? 'VERIFIED (exactly 1 won)' : 'FAILED',
      'Expected': 'Exactly 1 allowed, 99 denied',
    },
  };
}

module.exports = scenario04;
