'use strict';

/**
 * Format status counters into a table row.
 */
function formatStatusCounts(allowed, denied, unavailable, errors) {
  return {
    '200 OK': allowed,
    '429': denied,
    '503': unavailable,
    'Errors': errors,
  };
}

/**
 * Print a scenario header.
 */
function printScenarioHeader(number, name) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO ${number} — ${name}`);
  console.log('='.repeat(70));
}

/**
 * Print a scenario result.
 */
function printScenarioResult(pass, details = {}) {
  console.log(
    `\nResult: ${pass ? '✓ PASS' : '✗ FAIL'}`
  );
  if (Object.keys(details).length > 0) {
    console.log('Details:');
    for (const [k, v] of Object.entries(details)) {
      console.log(`  ${k}: ${v}`);
    }
  }
}

/**
 * Print an aggregate summary table.
 */
function printAggregateSummary(results) {
  console.log(`\n${'='.repeat(70)}`);
  console.log('AGGREGATE SUMMARY');
  console.log('='.repeat(70));
  console.log(
    `${'Scenario'.padEnd(50)} ${'Result'.padEnd(10)}`
  );
  console.log('-'.repeat(70));
  results.forEach((r, i) => {
    const status = r.pass ? 'PASS' : 'FAIL';
    const label = `${i + 1}. ${r.name}`;
    console.log(`${label.padEnd(50)} ${status.padEnd(10)}`);
  });
  console.log('-'.repeat(70));
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`TOTAL: ${passed}/${total} PASS\n`);
}

/**
 * Print a table of status counts.
 */
function printStatusTable(counts) {
  console.log('');
  const entries = Object.entries(counts).filter(([, v]) => v !== undefined);
  for (const [status, count] of entries) {
    console.log(`  ${status.padEnd(20)} ${count}`);
  }
}

module.exports = {
  formatStatusCounts,
  printScenarioHeader,
  printScenarioResult,
  printAggregateSummary,
  printStatusTable,
};
