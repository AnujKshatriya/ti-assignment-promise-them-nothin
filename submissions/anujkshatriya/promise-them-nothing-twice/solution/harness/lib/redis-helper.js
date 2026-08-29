'use strict';

const { execFileSync } = require('child_process');

const DOCKER = 'docker';
const CONTAINER = 'solution-redis-1';
const REDIS_CLI = 'redis-cli';

/**
 * Execute a Redis command via docker exec (fixed binary/args; no shell interpolation).
 */
function executeRedisCmd(redisArgs) {
  const args = ['exec', CONTAINER, REDIS_CLI, ...redisArgs];
  try {
    // Test-harness only: fixed docker/redis-cli args; no shell or user-controlled command fragments.
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    const result = execFileSync(DOCKER, args, {
      encoding: 'utf8',
    });
    return result.trim();
  } catch (err) {
    throw new Error(`Redis command failed: ${redisArgs.join(' ')}\n${err.message}`);
  }
}

/**
 * Flush all Redis data (for test isolation).
 */
function flushDB() {
  executeRedisCmd(['FLUSHDB']);
}

/**
 * Seed a customer's bucket with a specific token count and timestamp.
 * @param {string} customerId
 * @param {number} tokens
 * @param {number} tsMs
 */
function seedBucket(customerId, tokens, tsMs) {
  const key = `rl:${customerId}`;
  executeRedisCmd(['HMSET', key, 'tokens', String(tokens), 'ts', String(tsMs)]);
}

/**
 * Get the current bucket state (for debugging/verification).
 * @param {string} customerId
 * @returns {{ tokens: number, ts: number } | null}
 */
function getBucketState(customerId) {
  const key = `rl:${customerId}`;
  const result = executeRedisCmd(['HMGET', key, 'tokens', 'ts']);
  const parts = result.split('\n').filter((x) => x);
  if (parts.length < 2) return null;
  return {
    tokens: parseFloat(parts[0]),
    ts: parseFloat(parts[1]),
  };
}

module.exports = { flushDB, seedBucket, getBucketState };
