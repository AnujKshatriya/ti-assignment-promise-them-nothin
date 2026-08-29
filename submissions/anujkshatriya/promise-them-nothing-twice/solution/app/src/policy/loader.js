'use strict';

const fs = require('fs');
const yaml = require('js-yaml');

const REQUIRED_OVERRIDE_FIELDS = [
  'id', 'customer_id', 'rpm', 'capacity', 'schedule',
  'reason', 'approved_by', 'ticket', 'expires',
];
const REQUIRED_SCHEDULE_FIELDS = ['start', 'end', 'timezone'];
const HH_MM = /^\d{2}:\d{2}$/;

function validateOverride(override, index) {
  const label = override.id ? `override[${override.id}]` : `override[index=${index}]`;

  for (const field of REQUIRED_OVERRIDE_FIELDS) {
    if (override[field] == null) {
      throw new Error(`Config error: ${label} is missing required field "${field}"`);
    }
  }

  for (const field of REQUIRED_SCHEDULE_FIELDS) {
    if (override.schedule[field] == null) {
      throw new Error(`Config error: ${label}.schedule is missing required field "${field}"`);
    }
  }

  if (override.schedule.timezone !== 'UTC') {
    throw new Error(
      `Config error: ${label}.schedule.timezone must be "UTC". Multi-timezone support is future work. Got: "${override.schedule.timezone}"`
    );
  }

  if (!HH_MM.test(override.schedule.start)) {
    throw new Error(
      `Config error: ${label}.schedule.start must be HH:MM format, got "${override.schedule.start}"`
    );
  }

  if (!HH_MM.test(override.schedule.end)) {
    throw new Error(
      `Config error: ${label}.schedule.end must be HH:MM format, got "${override.schedule.end}"`
    );
  }

  if (Number.isNaN(Date.parse(override.expires))) {
    throw new Error(
      `Config error: ${label}.expires is not a valid ISO date: "${override.expires}"`
    );
  }

  if (typeof override.rpm !== 'number' || override.rpm <= 0) {
    throw new Error(`Config error: ${label}.rpm must be a positive number`);
  }

  if (typeof override.capacity !== 'number' || override.capacity <= 0) {
    throw new Error(`Config error: ${label}.capacity must be a positive number`);
  }
}

function parseConfig(rawYaml) {
  const config = yaml.load(rawYaml);

  if (!config || typeof config.tiers !== 'object') {
    throw new Error('Config error: "tiers" section is required');
  }

  if (typeof config.customers !== 'object') {
    throw new Error('Config error: "customers" section is required');
  }

  for (const [id, customer] of Object.entries(config.customers)) {
    if (!customer.tier) {
      throw new Error(`Config error: customer "${id}" is missing "tier"`);
    }
    if (!config.tiers[customer.tier]) {
      throw new Error(`Config error: customer "${id}" references unknown tier "${customer.tier}"`);
    }
  }

  const overrides = config.overrides ?? [];
  const seen = new Set();

  for (let i = 0; i < overrides.length; i++) {
    validateOverride(overrides[i], i);
    if (seen.has(overrides[i].id)) {
      throw new Error(`Config error: duplicate override id "${overrides[i].id}"`);
    }
    seen.add(overrides[i].id);
  }

  return config;
}

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  return parseConfig(raw);
}

module.exports = { loadConfig, parseConfig };
