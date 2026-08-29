'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeConcurrentRequests } = require('../lib/http-client');
const { formatStatusCounts, printStatusTable } = require('../lib/report');

/**
 * Scenario 2: Customer Isolation
 *
 * Two customers on growth tier (300 RPM each).
 * Seed both buckets to 300.
 * Customer A sends 500 requests concurrently.
 * Customer B sends 100 requests concurrently (at same time).
 *
 * Expected: Customer B gets all 100 (its full budget),
 *           Customer A gets ~300 allowed ~200 denied.
 *           B's bucket untouched by A's activity.
 */
async function scenario02() {
  flushDB();

  const T0 = 1_700_000_000_000;
  seedBucket('acme', 300, T0);
  seedBucket('globex', 300, T0);

  console.log('Configuration:');
  console.log('  Customers: acme, globex (both on growth, 300 RPM each)');
  console.log('  Initial buckets: both 300 tokens');
  console.log('  Time: frozen at ' + T0);
  console.log('  Concurrent: acme sends 500, globex sends 100 (simultaneously)');

  const resultsA = makeConcurrentRequests(500, { customerId: 'acme' }, T0);
  const resultsB = makeConcurrentRequests(100, { customerId: 'globex' }, T0);

  const [resA, resB] = await Promise.all([resultsA, resultsB]);

  const allowedA = resA.filter((r) => r.statusCode === 200).length;
  const deniedA = resA.filter((r) => r.statusCode === 429).length;
  const allowedB = resB.filter((r) => r.statusCode === 200).length;
  const deniedB = resB.filter((r) => r.statusCode === 429).length;

  console.log('\nResults:');
  console.log('  acme:');
  printStatusTable({ '200 OK': allowedA, '429': deniedA });
  console.log('  globex:');
  printStatusTable({ '200 OK': allowedB, '429': deniedB });

  // globex should get all 100 allowed, 0 denied
  // acme should get ~300 allowed, ~200 denied
  const pass =
    allowedB === 100 &&
    deniedB === 0 &&
    allowedA >= 280 && allowedA <= 320 && // ~300 with some variance
    deniedA >= 180 && deniedA <= 220;

  return {
    pass,
    details: {
      'acme allowed': allowedA,
      'acme denied': deniedA,
      'globex allowed': allowedB,
      'globex denied': deniedB,
      'globex isolation': allowedB === 100 ? 'VERIFIED' : 'FAILED',
      'Expected': 'globex: 100 allowed / acme: ~300 allowed, ~200 denied',
    },
  };
}

module.exports = scenario02;
