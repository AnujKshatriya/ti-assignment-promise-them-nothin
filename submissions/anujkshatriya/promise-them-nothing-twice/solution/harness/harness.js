#!/usr/bin/env node

'use strict';

const { printScenarioHeader, printScenarioResult, printAggregateSummary } = require('./lib/report');

// Import all 9 scenarios
const scenario01 = require('./scenarios/01-basic-quota');
const scenario02 = require('./scenarios/02-customer-isolation');
const scenario03 = require('./scenarios/03-distributed-correctness');
const scenario04 = require('./scenarios/04-concurrent-contention');
const scenario05 = require('./scenarios/05-fairness');
const scenario06 = require('./scenarios/06-override-activation');
const scenario07 = require('./scenarios/07-boundary-interval');
const scenario08 = require('./scenarios/08-boundary-clamp');
const scenario09 = require('./scenarios/09-burst-and-refill');

const scenarios = [
  { num: 1, name: 'Basic Quota', fn: scenario01 },
  { num: 2, name: 'Customer Isolation', fn: scenario02 },
  { num: 3, name: 'Distributed Correctness', fn: scenario03 },
  { num: 4, name: 'Concurrent Contention', fn: scenario04 },
  { num: 5, name: 'Fairness', fn: scenario05 },
  { num: 6, name: 'Northwind Override Activation', fn: scenario06 },
  { num: 7, name: 'Boundary – Half-Open Interval', fn: scenario07 },
  { num: 8, name: 'Boundary – Capacity Clamp', fn: scenario08 },
  { num: 9, name: 'Burst & Refill', fn: scenario09 },
];

async function runAllScenarios() {
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║                  RATE LIMITER HARNESS - All 9 Scenarios             ║');
  console.log('║                          PRD §15 Verification                        ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');

  const results = [];
  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    printScenarioHeader(scenario.num, scenario.name);

    try {
      const result = await scenario.fn();
      printScenarioResult(result.pass, result.details);

      results.push({
        name: scenario.name,
        pass: result.pass,
      });

      if (result.pass) {
        passed++;
      } else {
        failed++;
      }
    } catch (err) {
      console.log(`\n✗ EXCEPTION: ${err.message}`);
      console.log(err.stack);

      results.push({
        name: scenario.name,
        pass: false,
      });

      failed++;
    }
  }

  // Print aggregate summary
  printAggregateSummary(results);

  // Exit code
  const exitCode = failed === 0 ? 0 : 1;
  console.log(`Exit code: ${exitCode}\n`);
  process.exit(exitCode);
}

// Set test mode environment
process.env.RATE_LIMIT_TEST_MODE = 'true';

runAllScenarios().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
