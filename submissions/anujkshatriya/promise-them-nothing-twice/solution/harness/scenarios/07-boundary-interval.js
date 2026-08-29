'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeRequest } = require('../lib/http-client');
const { printStatusTable } = require('../lib/report');

/**
 * Scenario 7: Boundary – Half-Open Interval
 *
 * Request at exact timestamps:
 * - 01:59:59.999 UTC → base policy
 * - 02:00:00.000 UTC → override policy
 * - 03:59:59.999 UTC → override policy
 * - 04:00:00.000 UTC → base policy
 *
 * Expected: Confirms half-open interval [02:00:00, 04:00:00)
 */
async function scenario07() {
  flushDB();

  const baseDate = Date.UTC(2026, 0, 15);

  const testpoints = [
    { name: '01:59:59.999', ms: baseDate + 1*3600*1000 + 59*60*1000 + 59*1000 + 999, expect: 'base' },
    { name: '02:00:00.000', ms: baseDate + 2*3600*1000, expect: 'override' },
    { name: '03:59:59.999', ms: baseDate + 3*3600*1000 + 59*60*1000 + 59*1000 + 999, expect: 'override' },
    { name: '04:00:00.000', ms: baseDate + 4*3600*1000, expect: 'base' },
  ];

  console.log('Configuration:');
  console.log('  Customer: northwind');
  console.log('  Override window: [02:00:00, 04:00:00) UTC');
  console.log('  Testing exact boundary instants');

  const results = [];

  for (const tp of testpoints) {
    seedBucket('northwind', 100, tp.ms);
    const res = await makeRequest({ customerId: 'northwind' }, tp.ms).catch((err) => ({
      statusCode: 0,
      error: err.message,
    }));

    const policyName = res.headers['x-ratelimit-policy'] || 'unknown';
    const capacity = res.headers['x-ratelimit-limit'] || '?';

    const isCorrect =
      (tp.expect === 'override' && policyName === 'northwind-nightly-batch') ||
      (tp.expect === 'base' && policyName === 'growth');

    results.push({
      time: tp.name,
      expect: tp.expect,
      policy: policyName,
      capacity,
      correct: isCorrect,
    });

    console.log(
      `  ${tp.name} → ${policyName} (capacity ${capacity}) — ${isCorrect ? '✓' : '✗'}`
    );
  }

  const pass = results.every((r) => r.correct);

  return {
    pass,
    details: {
      '01:59:59.999': results[0].policy + ' (expect base)',
      '02:00:00.000': results[1].policy + ' (expect override)',
      '03:59:59.999': results[2].policy + ' (expect override)',
      '04:00:00.000': results[3].policy + ' (expect base)',
      'Half-open interval': pass ? 'VERIFIED' : 'FAILED',
      'Expected': 'Half-open [02:00:00, 04:00:00)',
    },
  };
}

module.exports = scenario07;
