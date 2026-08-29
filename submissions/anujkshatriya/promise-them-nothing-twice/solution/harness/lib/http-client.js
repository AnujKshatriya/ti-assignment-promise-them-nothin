'use strict';

// Local integration harness: targets Docker Nginx on localhost; HTTPS not configured for prototype.
// nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
const http = require('http');

// nosemgrep: problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 256,
  maxFreeSockets: 256,
});

/**
 * Simple HTTP client for making requests to the rate-limited service.
 * Returns a promise that resolves to { statusCode, headers, body }.
 */
function makeRequest(options, testTimeMs = null) {
  return new Promise((resolve) => {
    const requestOptions = {
      hostname: 'localhost',
      port: 8080,
      path: '/api/v1/ping',
      method: 'GET',
      headers: {
        'X-Customer-Id': options.customerId,
      },
      agent,
      timeout: 5000,
    };

    if (testTimeMs !== null && process.env.RATE_LIMIT_TEST_MODE === 'true') {
      requestOptions.headers['X-Test-Time-Ms'] = String(testTimeMs);
    }

    // Local test harness only: HTTP to localhost Docker Nginx; TLS not configured in prototype.
    const req = http.request(requestOptions, (res) => { // nosemgrep: problem-based-packs.insecure-transport.js-node.http-request.http-request, problem-based-packs.insecure-transport.js-node.using-http-server.using-http-server
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(data);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        } catch {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 0,
        error: err.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        statusCode: 0,
        error: 'timeout',
      });
    });

    req.end();
  });
}

/**
 * Make N requests concurrently.
 */
async function makeConcurrentRequests(n, options, testTimeMs = null) {
  const promises = Array.from({ length: n }, () =>
    makeRequest(options, testTimeMs).catch((err) => ({
      statusCode: 0,
      error: err.message,
    }))
  );
  return Promise.all(promises);
}

/**
 * Make N requests sequentially.
 */
async function makeSequentialRequests(n, options, testTimeMs = null) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const res = await makeRequest(options, testTimeMs).catch((err) => ({
      statusCode: 0,
      error: err.message,
    }));
    results.push(res);
  }
  return results;
}

module.exports = { makeRequest, makeConcurrentRequests, makeSequentialRequests };
