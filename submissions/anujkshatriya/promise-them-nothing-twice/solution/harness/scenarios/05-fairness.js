'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeConcurrentRequests } = require('../lib/http-client');
const { formatStatusCounts, printStatusTable } = require('../lib/report');

/**
 * Scenario 5: Fairness
 *
 * Two customers on the same effective policy (growth, 300 RPM each).
 * Same initial bucket state (300 tokens each).
 * Both send 500 requests concurrently through Nginx.
 *
 * Expected: Both allowed counts within 2% of each other.
 * Neither starves.
 */
async function scenario05() {
  flushDB();

  const T0 = 1_700_000_000_000;
  seedBucket('acme', 300, T0);
  seedBucket('globex', 300, T0);

  console.log('Configuration:');
  console.log('  Customers: acme, globex (both growth, 300 RPM)');
  console.log('  Initial buckets: both 300 tokens (symmetric)');
  console.log('  Requests: both send 500 concurrently');
  console.log('  Time: frozen at ' + T0);

  const [resA, resB] = await Promise.all([
    makeConcurrentRequests(500, { customerId: 'acme' }, T0),
    makeConcurrentRequests(500, { customerId: 'globex' }, T0),
  ]);

  const allowedA = resA.filter((r) => r.statusCode === 200).length;
  const allowedB = resB.filter((r) => r.statusCode === 200).length;

  console.log('\nResults:');
  console.log('  acme:');
  printStatusTable(formatStatusCounts(allowedA, 500 - allowedA, 0, 0));
  console.log('  globex:');
  printStatusTable(formatStatusCounts(allowedB, 500 - allowedB, 0, 0));

  // Both should get ~300 allowed, within 2% means abs(A-B) <= 0.02 * avg
  const diff = Math.abs(allowedA - allowedB);
  const avg = (allowedA + allowedB) / 2;
  const pctDiff = avg > 0 ? (diff / avg) * 100 : 0;
  const withinTolerance = pctDiff <= 2;

  const pass =
    allowedA >= 280 && allowedA <= 320 &&
    allowedB >= 280 && allowedB <= 320 &&
    withinTolerance;

  return {
    pass,
    details: {
      'acme allowed': allowedA,
      'globex allowed': allowedB,
      'Difference': diff,
      'Percent diff': pctDiff.toFixed(2) + '%',
      'Within 2%': withinTolerance ? 'YES' : 'NO',
      'Expected': 'Both ~300, within 2% of each other',
    },
  };
}

module.exports = scenario05;
