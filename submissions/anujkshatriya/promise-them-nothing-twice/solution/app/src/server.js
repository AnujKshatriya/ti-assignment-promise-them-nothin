'use strict';

const express = require('express');
const path    = require('path');
const Redis   = require('ioredis');

const { loadConfig }               = require('./policy/loader');
const { SystemTime }               = require('./time/timeSource');
const { RedisLimiter }             = require('./limiter/redisLimiter');
const { createRateLimitMiddleware } = require('./middleware/rateLimit');
const { createPingHandler }        = require('./routes/ping');

/**
 * Builds and returns the Express application.
 * All dependencies are injected so the app can be instantiated in tests
 * without touching the file system, Redis, or the system clock.
 *
 * @param {{ config, limiter, timeSource, nodeId: string }} deps
 */
function createApp({ config, limiter, timeSource, nodeId }) {
  const app = express();

  const rateLimitMiddleware = createRateLimitMiddleware({ config, limiter, timeSource });

  app.get('/api/v1/ping', rateLimitMiddleware, createPingHandler(nodeId));

  return app;
}

module.exports = { createApp };

// ── Production entry point ────────────────────────────────────────────────────
// Only executes when this file is run directly (not when require()'d in tests).

if (require.main === module) {
  const NODE_ID     = process.env.NODE_ID     || 'node-1';
  const PORT        = parseInt(process.env.PORT || '3000', 10);
  const REDIS_URL   = process.env.REDIS_URL   || 'redis://localhost:6379';
  const CONFIG_PATH = process.env.CONFIG_PATH ||
    path.join(__dirname, '../../config/policies.yaml');

  // Fail loudly on invalid config at startup (PRD §8).
  const config = loadConfig(CONFIG_PATH);

  const redisClient = new Redis(REDIS_URL, { lazyConnect: false });
  const timeSource  = new SystemTime();
  const limiter     = new RedisLimiter(redisClient);

  const app = createApp({ config, limiter, timeSource, nodeId: NODE_ID });

  app.listen(PORT, () => {
    console.log(`[${NODE_ID}] listening on :${PORT}`);
  });
}
