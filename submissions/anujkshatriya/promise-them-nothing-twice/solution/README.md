# Promise Them Nothing Twice — Rate Limiter Solution

A distributed, per-customer HTTP rate limiter for a fictional B2B API platform (RelayAPI). Enforces token-bucket quotas correctly across three stateless application nodes, with support for time-bounded commercial overrides.

## What This System Does

- **Per-customer rate limiting.** Each customer has an RPM quota. Requests exceeding the quota receive `429 Too Many Requests` with a `Retry-After` header.
- **Shared distributed state.** All three application nodes enforce the same limits by reading/writing a shared Redis bucket.
- **Time-bounded overrides.** Northwind Logistics receives a temporary 1500 RPM quota from 02:00–04:00 UTC (base contract: 300 RPM) via an explicitly audited override in the configuration file.
- **Atomic enforcement.** Redis Lua script ensures the state transition is serialized—two requests racing for the last token: exactly one wins.
- **Deterministic testing.** Virtual time injection (gated by `RATE_LIMIT_TEST_MODE=true`) allows testing the 02:00/04:00 boundary without wall-clock waits.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Load Harness / Manual Requests                  │
│  (with X-Customer-Id header)                     │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
         ┌─────────────────────┐
         │   Nginx             │
         │  (round-robin)      │
         │  port :8080         │
         └──┬──────┬──────┬────┘
            │      │      │
     ┌──────▼──┐  ┌┴──────▼───┐  ┌─────────▼──┐
     │ Node 1  │  │  Node 2   │  │  Node 3    │
     │ :3000   │  │  :3000    │  │  :3000     │
     │Express  │  │ Express   │  │ Express    │
     │app      │  │ app       │  │ app        │
     └────┬────┘  └─┬─────────┘  └─────┬──────┘
          │         │                  │
          └─────────┼──────────────────┘
                    │
                    ▼
             ┌──────────────────┐
             │  Redis           │
             │  :6379 (exposed) │
             │                  │
             │ Shared buckets:  │
             │ rl:acme          │
             │ rl:globex        │
             │ rl:northwind     │
             └──────────────────┘
```

**Three stateless nodes** talk to **one shared Redis** instance. Nginx performs round-robin load balancing with no sticky sessions.

## Token Bucket Algorithm

Each customer has a bucket containing tokens. On each request:

1. **Refill lazily:** compute elapsed time since last request, add `elapsed_seconds × refill_rate` tokens (capped at capacity).
2. **Check availability:** if ≥ 1 token, consume 1 and allow. Otherwise, deny.
3. **Persist state:** store updated token count and timestamp back to Redis atomically.

**Example (acme customer, 300 RPM tier):**
- Capacity: 300 tokens
- Refill rate: 5 tokens/second
- First request at 10:00:00.000: bucket is full (300) → consume 1 → remaining 299 → allow
- Ninth request at 10:00:00.050: elapsed 50ms → refilled 0.25 tokens → still at 291 → allow
- 300th request: bucket depleted → deny with `Retry-After: ~40s` (time to refill 1 token)

**Burst behavior:** if idle for 10 seconds, the bucket refills to 300 (never beyond). A client with tokens in the bucket can consume them faster than the refill rate (burst), but idle time cannot accumulate unbounded credit.

## Northwind Nightly Batch Exception

Northwind's contract specifies 300 RPM. Their nightly batch job (02:00–04:00 UTC) sends ~800–1200 RPM, which would normally be rate-limited.

**Resolution:** An explicitly audited override in `config/policies.yaml` temporarily raises Northwind's limit to 1500 RPM during that window:

```yaml
overrides:
  - id: northwind-nightly-batch
    customer_id: northwind
    rpm: 1500
    capacity: 1500
    schedule:
      start: "02:00"
      end:   "04:00"
      timezone: "UTC"
    reason: "Approved nightly batch workload — commercial bridge"
    approved_by: "priya.nair@relayapi"
    ticket: "OPS-4471"
    expires: "2026-06-01T00:00:00Z"
```

The override is **time-bounded** and **auditable**. Northwind's contract remains 300 RPM; the override is a temporary exception, not a contract change.

### Capacity Clamping at Boundary

When the override expires at 04:00:00.000 UTC:
- Northwind's effective policy drops from (1500 RPM / 1500 capacity) to (300 RPM / 300 capacity).
- If the bucket held 1000 tokens from the elevated window, the next request clamps it: `min(1000, 300) = 300`.
- This prevents a burst of 1000 requests bleeding into the base 300 RPM window.

## HTTP Behavior

### 200 OK (request allowed)

```
GET /api/v1/ping HTTP/1.1
Host: localhost:8080
X-Customer-Id: acme
```

```
HTTP/1.1 200 OK
X-RateLimit-Limit:     300
X-RateLimit-Remaining: 299
X-RateLimit-Policy:    growth
Content-Type: application/json

{"ok": true, "node": "node-2"}
```

- `X-RateLimit-Limit`: capacity (configurable per tier/override).
- `X-RateLimit-Remaining`: floor of current tokens.
- `X-RateLimit-Policy`: `growth`, `northwind-nightly-batch`, etc.
- `node`: which of the three nodes handled the request (proves distributed behavior).

### 429 Too Many Requests (quota exhausted)

```
HTTP/1.1 429 Too Many Requests
Retry-After:           1
X-RateLimit-Limit:     300
X-RateLimit-Remaining: 0
X-RateLimit-Policy:    growth
Content-Type: application/json

{"error": "rate_limited", "retry_after_ms": 200}
```

- `Retry-After`: seconds until the next token is available (minimum 1).
- `retry_after_ms`: precise milliseconds (for clients that want sub-second precision).

### 503 Service Unavailable (Redis is down)

```
HTTP/1.1 503 Service Unavailable
Retry-After: 5
Content-Type: application/json

{"error": "rate_limiter_unavailable"}
```

**Critical:** Returns 503, **not 429**. Rationale: if Redis is unavailable, the limiter cannot determine whether the customer is over quota. Returning 429 would be semantically misleading ("you exceeded your quota" when we can't know). Returning 503 honestly signals an infrastructure problem.

Clients should retry after `Retry-After: 5` seconds.

### 400 Bad Request

```
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"error": "missing_customer_id"}
```

Returned if:
- `X-Customer-Id` header is missing.
- `X-Customer-Id` refers to a customer not in the configuration.

## Repository Structure

```
solution/
├── docker-compose.yml              # 3-node + Nginx + Redis
├── .dockerignore
├── nginx/
│   └── nginx.conf                  # round-robin upstream
├── app/
│   ├── package.json
│   ├── Dockerfile
│   ├── src/
│   │   ├── server.js               # Express app factory + production entry
│   │   ├── middleware/
│   │   │   └── rateLimit.js        # rate-limit middleware logic
│   │   ├── routes/
│   │   │   └── ping.js             # GET /api/v1/ping handler
│   │   ├── policy/
│   │   │   ├── loader.js           # YAML config parsing + validation
│   │   │   └── resolver.js         # (customer, now, config) → policy
│   │   ├── limiter/
│   │   │   ├── tokenBucket.lua     # atomic Lua script
│   │   │   └── redisLimiter.js     # Redis client wrapper
│   │   └── time/
│   │       └── timeSource.js       # SystemTime + FakeTime
│   └── test/
│       ├── policy.resolver.test.js
│       ├── policy.loader.test.js
│       ├── limiter.integration.test.js
│       └── middleware.integration.test.js
└── config/
    └── policies.yaml               # tier definitions, customer assignments, overrides
```

## Prerequisites

- **Docker** (with Docker Compose v2).
- **Node 18+** (for running tests locally without Docker).
- **npm** (for `npm ci`, `npm test`).

## Installation & Running Tests

### 1. Install dependencies (local tests, not Docker)

```bash
cd solution/app
npm ci
npm test
```

Runs 66 tests:
- 14 policy resolver tests (override boundaries, expiry, tier fallback).
- 19 config loader tests (validation, required fields, date parsing).
- 14 Redis/Lua integration tests (atomicity, capacity clamping, concurrent requests).
- 19 HTTP middleware tests (200/429/503 responses, headers, X-Test-Time-Ms gating).

**Expected output:** `66 passed, 0 failed`.

### 2. Start the full distributed system

```bash
cd solution
docker compose up --build -d
```

Starts:
- Redis (port 6379, exposed for test harness)
- Node 1 (internal, port 3000)
- Node 2 (internal, port 3000)
- Node 3 (internal, port 3000)
- Nginx (port 8080, your entry point)

All nodes will wait for Redis to be healthy before starting (health check: `redis-cli ping`).

**Verify:**
```bash
docker compose ps
```

All five services should show `running`.

### 3. Send a request

```bash
curl -H "X-Customer-Id: acme" http://localhost:8080/api/v1/ping
```

Response:
```json
{
  "ok": true,
  "node": "node-1"  (or node-2 or node-3, depending on round-robin)
}
```

### 4. Check rate-limit headers

```bash
curl -v -H "X-Customer-Id: acme" http://localhost:8080/api/v1/ping 2>&1 | grep -i "X-RateLimit"
```

Output:
```
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 299
X-RateLimit-Policy: growth
```

### 5. Exhaust the quota

Seed the bucket to a low token count via `redis-cli`, then send requests:

```bash
# Connect to Redis
docker exec solution-redis-1 redis-cli

# Seed acme bucket to 1 token
HMSET rl:acme tokens 1 ts 1000000

# Exit redis-cli
exit

# Now send 3 requests
for i in {1..3}; do
  curl -H "X-Customer-Id: acme" \
       -H "X-Test-Time-Ms: 1000000" \
       http://localhost:8080/api/v1/ping
done
```

**Expected:**
- Request 1: `200 OK`, `X-RateLimit-Remaining: 0`
- Request 2: `429 Too Many Requests`, `Retry-After: 1` (approx 200ms until next token)
- Request 3: `429 Too Many Requests`, same

### 6. Test Northwind override (02:00–04:00 UTC window)

Using the `X-Test-Time-Ms` header (test-mode only) to inject a virtual timestamp:

```bash
# At 02:30 UTC (inside override window, cap should be 1500)
curl -v -H "X-Customer-Id: northwind" \
        -H "X-Test-Time-Ms: $(date -d '2026-01-15T02:30:00Z' +%s)000" \
        http://localhost:8080/api/v1/ping 2>&1 | grep "X-RateLimit-Limit"
```

**Expected:** `X-RateLimit-Limit: 1500` (not 300).

```bash
# At 10:00 UTC (outside override window, cap should be 300)
curl -v -H "X-Customer-Id: northwind" \
        -H "X-Test-Time-Ms: $(date -d '2026-01-15T10:00:00Z' +%s)000" \
        http://localhost:8080/api/v1/ping 2>&1 | grep "X-RateLimit-Limit"
```

**Expected:** `X-RateLimit-Limit: 300` (base tier).

## Test-Only Features

### X-Test-Time-Ms Header

Allows the test harness to inject a virtual epoch timestamp (ms) without waiting for real time to pass.

**ONLY honored if `RATE_LIMIT_TEST_MODE=true`.** In production (no such env var), the header is silently ignored.

**Usage:**
```bash
curl -H "X-Customer-Id: northwind" \
     -H "X-Test-Time-Ms: 1674806400000" \
     http://localhost:8080/api/v1/ping
```

### Redis Direct Access

The Redis port (6379) is intentionally exposed in `docker-compose.yml` so the test harness can:
- `FLUSHDB` to reset state between scenarios.
- `HMSET rl:<customer_id> tokens <n> ts <ms>` to seed bucket state.

**⚠️ WARNING:** This is a development/testing convenience only. Production infrastructure must isolate Redis from external access and disable these operations.

## Known Limitations

- **Load-testing harness not implemented yet.** The nine PRD scenarios are not yet end-to-end proven.
- **RATE_LIMIT_TEST_MODE is a single env var.** Stronger production boundaries (separate binary, build-time removal) are future work.
- **No config hot-reload.** Changes to `config/policies.yaml` require restarting the nodes.
- **No persistent audit log.** The config file is the audit trail; persistent logging is future work.
- **Single Redis instance.** No HA, failover, or clustering. High-availability setup with local-counter fallback is future work.
- **No metrics/observability.** No Prometheus-style instrumentation; observability is future work.

## Stopping the System

```bash
cd solution
docker compose down
```

Removes all containers and the internal network. Volumes are not removed (Redis data persists).

To clean up completely:
```bash
docker compose down -v
```

## Next Phase: Load-Testing Harness

The nine assignment scenarios (PRD §15) are not yet implemented:
1. Basic quota
2. Customer isolation
3. Distributed correctness (all 3 nodes serve 300 requests, not 900)
4. Concurrent single-token contention
5. Fairness
6. Override activation
7. Boundary: half-open interval
8. Boundary: capacity clamp at 04:00
9. Burst & refill

These will be implemented as a first-class harness that makes correct vs incorrect behavior obvious without reading source code.
