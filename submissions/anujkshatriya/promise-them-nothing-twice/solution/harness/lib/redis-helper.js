'use strict';

const { execSync } = require('child_process');

/**
 * Execute a Redis command via docker exec.
 */
function executeRedisCmd(cmd) {
  try {
    const result = execSync(`docker exec solution-redis-1 redis-cli ${cmd}`, {
      encoding: 'utf8',
    });
    return result.trim();
  } catch (err) {
    throw new Error(`Redis command failed: ${cmd}\n${err.message}`);
  }
}

/**
 * Flush all Redis data (for test isolation).
 */
function flushDB() {
  executeRedisCmd('FLUSHDB');
}

/**
 * Seed a customer's bucket with a specific token count and timestamp.
 * @param {string} customerId
 * @param {number} tokens
 * @param {number} tsMs
 */
function seedBucket(customerId, tokens, tsMs) {
  const key = `rl:${customerId}`;
  executeRedisCmd(`HMSET ${key} tokens ${tokens} ts ${tsMs}`);
}

/**
 * Get the current bucket state (for debugging/verification).
 * @param {string} customerId
 * @returns {{ tokens: number, ts: number } | null}
 */
function getBucketState(customerId) {
  const key = `rl:${customerId}`;
  const result = executeRedisCmd(`HMGET ${key} tokens ts`);
  const parts = result.split('\n').filter((x) => x);
  if (parts.length < 2) return null;
  return {
    tokens: parseFloat(parts[0]),
    ts: parseFloat(parts[1]),
  };
}

module.exports = { flushDB, seedBucket, getBucketState };
