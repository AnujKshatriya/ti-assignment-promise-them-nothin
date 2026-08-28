'use strict';

/**
 * Returns a handler for GET /api/v1/ping.
 * The node ID in the response body lets the harness verify that all
 * three nodes serve traffic (PRD §13, §15 scenario 3).
 *
 * @param {string} nodeId
 */
function createPingHandler(nodeId) {
  return (_req, res) => {
    res.json({ ok: true, node: nodeId });
  };
}

module.exports = { createPingHandler };
