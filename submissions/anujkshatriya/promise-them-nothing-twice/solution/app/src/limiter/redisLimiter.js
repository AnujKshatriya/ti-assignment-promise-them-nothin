'use strict';

const fs   = require('fs');
const path = require('path');

const SCRIPT = fs.readFileSync(
  path.join(__dirname, 'tokenBucket.lua'),
  'utf8'
);

class RedisLimiter {
  /**
   * @param {import('ioredis').Redis} redisClient
   */
  constructor(redisClient) {
    this._client = redisClient;
  }

  /**
   * Checks whether the customer's request should be allowed.
   *
   * Throws on Redis connectivity failure — the middleware must catch this
   * and return 503 (PRD §11: fail closed, honest about the cause).
   *
   * @param {string} customerId
   * @param {number} nowMs     - epoch ms from the injected TimeSource
   * @param {{ refillRate: number, capacity: number }} policy
   * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }>}
   */
  async check(customerId, nowMs, policy) {
    const key    = `rl:${customerId}`;
    const result = await this._client.eval(
      SCRIPT,
      1,                       // numkeys
      key,                     // KEYS[1]
      String(nowMs),           // ARGV[1]
      String(policy.refillRate), // ARGV[2]
      String(policy.capacity)  // ARGV[3]
    );

    // Lua returns [allowed (0|1), remaining (int), retry_after_ms (int)]
    return {
      allowed:      result[0] === 1,
      remaining:    result[1],
      retryAfterMs: result[2],
    };
  }
}

module.exports = { RedisLimiter };
