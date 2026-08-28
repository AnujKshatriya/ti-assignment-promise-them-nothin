'use strict';

// Converts "HH:MM" to milliseconds since midnight.
function parseScheduleMs(hhMm) {
  const [h, m] = hhMm.split(':').map(Number);
  return (h * 60 + m) * 60 * 1000;
}

// Returns milliseconds elapsed since UTC midnight for a given epoch ms.
function utcTimeOfDayMs(nowMs) {
  const d = new Date(nowMs);
  return (
    d.getUTCHours() * 3600000 +
    d.getUTCMinutes() * 60000 +
    d.getUTCSeconds() * 1000 +
    d.getUTCMilliseconds()
  );
}

/**
 * Resolves the effective rate-limit policy for a customer at a given instant.
 *
 * @param {string} customerId
 * @param {number} nowMs  - epoch milliseconds (from TimeSource.now())
 * @param {object} config - validated config from loader.js
 * @returns {{ refillRate: number, capacity: number, policyId: string }}
 */
function resolvePolicy(customerId, nowMs, config) {
  const customer = config.customers[customerId];
  if (!customer) {
    throw new Error(`Unknown customer: "${customerId}"`);
  }

  const todMs = utcTimeOfDayMs(nowMs);
  const overrides = config.overrides ?? [];

  for (const override of overrides) {
    if (override.customer_id !== customerId) continue;

    // Expired overrides are silently skipped (PRD §9: "first in file wins").
    if (nowMs >= Date.parse(override.expires)) continue;

    // Half-open interval [start, end) — PRD §9.
    const startMs = parseScheduleMs(override.schedule.start);
    const endMs   = parseScheduleMs(override.schedule.end);

    if (todMs >= startMs && todMs < endMs) {
      return {
        refillRate: override.rpm / 60,
        capacity:   override.capacity,
        policyId:   override.id,
      };
    }
  }

  // Fall back to the customer's base tier.
  const tier = config.tiers[customer.tier];
  return {
    refillRate: tier.rpm / 60,
    capacity:   tier.capacity,
    policyId:   customer.tier,
  };
}

module.exports = { resolvePolicy };
