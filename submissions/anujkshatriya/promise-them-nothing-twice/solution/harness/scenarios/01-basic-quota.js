'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeRequest } = require('../lib/http-client');
const { formatStatusCounts, printStatusTable } = require('../lib/report');

/**
 * Scenario 1: Basic Quota
 *
 * Customer on growth (300 RPM). Seed bucket to 300.
 * Send 400 requests as fast as possible to a single node.
 *
 * Expected: ≥300 allowed, remainder 429. Every 429 carries valid Retry-After.
 */
async function scenario01() {
  flushDB();

  const T0 = 1_700_000_000_000; // Fixed epoch, no refill
  seedBucket('acme', 300, T0);

  console.log('Configuration:');
  console.log('  Customer: acme');
  console.log('  Policy: growth (300 RPM, capacity 300)');
  console.log('  Initial bucket: 300 tokens');
  console.log('  Requests: 400 (sequential to single node)');
  console.log('  Time: frozen at ' + T0);

  const allowed200 = [];
  const denied429 = [];
  const other = [];

  // Send 400 requests sequentially to a single node
  for (let i = 0; i < 400; i++) {
    const res = await makeRequest({ customerId: 'acme' }, T0).catch((err) => ({
      statusCode: 0,
      error: err.message,
    }));

    if (res.statusCode === 200) {
      allowed200.push(res);
    } else if (res.statusCode === 429) {
      denied429.push(res);
    } else {
      other.push(res);
    }
  }

  // Verify all 429s have Retry-After
  const retry429WithoutHeader = denied429.filter(
    (r) => r.headers['retry-after'] == null
  );

  console.log('\nResults:');
  printStatusTable(formatStatusCounts(allowed200.length, denied429.length, 0, other.length));

  const pass =
    allowed200.length >= 300 &&
    denied429.length === 400 - allowed200.length &&
    retry429WithoutHeader.length === 0 &&
    other.length === 0;

  return {
    pass,
    details: {
      '200 OK': allowed200.length,
      '429 Too Many': denied429.length,
      'Retry-After present': denied429.length - retry429WithoutHeader.length + '/' + denied429.length,
      'Other errors': other.length,
      'Expected': '≥300 allowed, rest 429 with Retry-After',
    },
  };
}

module.exports = scenario01;
