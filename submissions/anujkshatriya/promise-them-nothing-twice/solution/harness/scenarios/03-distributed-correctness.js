'use strict';

const { flushDB, seedBucket } = require('../lib/redis-helper');
const { makeConcurrentRequests } = require('../lib/http-client');
const { formatStatusCounts, printStatusTable } = require('../lib/report');

/**
 * Scenario 3: Distributed Correctness
 *
 * One customer on growth (300 RPM). Seed bucket to 300.
 * Send 600 requests **through Nginx** so they fan out across all 3 nodes.
 *
 * Expected: ≈300 allowed (NOT ≈900, proving shared state).
 * Report per-node hit counts to prove all 3 nodes served traffic.
 */
async function scenario03() {
  flushDB();

  const T0 = 1_700_000_000_000;
  seedBucket('acme', 300, T0);

  console.log('Configuration:');
  console.log('  Customer: acme (growth, 300 RPM capacity)');
  console.log('  Initial bucket: 300 tokens');
  console.log('  Requests: 600 through Nginx (round-robin to 3 nodes)');
  console.log('  Time: frozen at ' + T0);

  const results = await makeConcurrentRequests(600, { customerId: 'acme' }, T0);

  const allowed = results.filter((r) => r.statusCode === 200);
  const denied = results.filter((r) => r.statusCode === 429);

  // Extract node information from response body
  const nodeDistribution = {};
  allowed.forEach((r) => {
    if (r.body && r.body.node) {
      nodeDistribution[r.body.node] = (nodeDistribution[r.body.node] || 0) + 1;
    }
  });

  console.log('\nResults:');
  printStatusTable({
    '200 OK': allowed.length,
    '429': denied.length,
  });

  console.log('\nNode Distribution (from 200 OK responses):');
  for (const [node, count] of Object.entries(nodeDistribution)) {
    console.log(`  ${node}: ${count} requests`);
  }

  const nodesServing = Object.keys(nodeDistribution).length;

  const pass =
    allowed.length >= 280 && allowed.length <= 320 && // ≈300 with variance
    denied.length >= 280 && denied.length <= 320 &&
    nodesServing === 3; // All 3 nodes must have served at least one request

  return {
    pass,
    details: {
      'Allowed (200)': allowed.length,
      'Denied (429)': denied.length,
      'Nodes serving': nodesServing,
      'Per-node distribution': Object.entries(nodeDistribution).map(([n, c]) => `${n}:${c}`).join(', '),
      'Expected': '~300 allowed (NOT 900), all 3 nodes serving',
    },
  };
}

module.exports = scenario03;
