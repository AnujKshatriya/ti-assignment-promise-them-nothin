'use strict';

/**
 * Simple HTTP client for making requests to the rate-limited service.
 * Returns a promise that resolves to { statusCode, headers, body }.
 */
async function makeRequest(options, testTimeMs = null) {
  const headers = {
    'X-Customer-Id': options.customerId,
  };

  if (testTimeMs !== null && process.env.RATE_LIMIT_TEST_MODE === 'true') {
    headers['X-Test-Time-Ms'] = String(testTimeMs);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch('http://localhost:8080/api/v1/ping', {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const data = await response.text();
    const responseHeaders = Object.fromEntries(response.headers);

    try {
      const body = JSON.parse(data);
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body,
      };
    } catch {
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body: data,
      };
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        statusCode: 0,
        error: 'timeout',
      };
    }
    return {
      statusCode: 0,
      error: err.message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
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
