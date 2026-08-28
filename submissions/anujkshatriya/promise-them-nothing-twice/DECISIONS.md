# DECISIONS.md

## Conflict Resolution: CTO vs Support

**Our decision:** Implement a **generic, config-driven, time-bounded override mechanism**. Northwind's nightly batch from 02:00–04:00 UTC receives a temporary 1500 RPM exemption via this mechanism, not hardcoded logic.

**What this means:**
- Northwind's contractual quota remains 300 RPM.
- An explicitly authorized, audited override temporarily raises the enforced limit to 1500 RPM during 02:00–04:00 UTC only.
- The override record contains `approved_by`, `ticket`, `reason`, and `expires` fields—treated as a temporary commercial bridge while Sales renegotiates the contract.
- No customer-specific code or branching exists in the application layer.

**Explicitly rejected:**
- **Hardcoding Northwind in application logic** — violates the CTO's requirement for auditable, non-custom-code exceptions; creates precedent for every future exception to require a code change.
- **Strict 300 RPM enforcement without exception** — breaks the business (60% of ARR at renewal risk) and ignores the CTO's explicit escape hatch: "commercial exceptions go through config."
- **Universal burst credits for all customers** — solves Northwind's problem at the cost of weakening fairness for every other customer.
- **Queue-and-serve instead of 429** — changes observable latency and introduces new failure modes (queue overflow).

## Token Bucket Algorithm

**Why token bucket?** Industry standard (AWS, Stripe, GitHub, Cloudflare). Natural burst semantics. The override reduces to "different bucket parameters" (300→1500 RPM) rather than a new code path.

**Core semantics:**
- RPM is the sustained refill rate. 300 RPM → 5 tokens/sec sustained. A client with accumulated tokens may consume faster than the refill rate (burst behavior).
- Capacity is the maximum instantaneous burst. Once full, idle time cannot accumulate unbounded credit.
- In this prototype, capacity equals RPM (300 RPM → 300 capacity; 1500 RPM → 1500 capacity). A permissive choice, consistent with major platforms. Stricter implementations can choose capacity < RPM without changing the algorithm.
- Each request consumes exactly one token.
- Refill is lazy—computed at request arrival, not by background job. Keeps the design stateless-per-request and avoids scheduler bugs.
- The Lua script maintains the invariant: `0 ≤ tokens ≤ capacity` on every call, regardless of clock skew or concurrent requests.

**Explicit formula:**
```
elapsed_seconds  = max(0, (now_ms - last_refill_ms) / 1000)
refilled_tokens  = min(capacity, current_tokens + elapsed_seconds * refill_rate)
if refilled_tokens >= 1:
    new_tokens = refilled_tokens - 1
    ALLOW
else:
    new_tokens = refilled_tokens
    DENY  (retry_after_ms = ceil((1 - new_tokens) / refill_rate * 1000))
persist { tokens: new_tokens, ts: now_ms }
```

**Why not:**
- **Fixed window** — the 12:00:59/12:01:00 double-burst boundary bug.
- **Sliding-window log** — per-request memory scales with RPM; unnecessary cost for a prototype.
- **Leaky bucket** — smooths to a constant rate; rejects legitimate small bursts customers expect.

## Distributed Coordination

**Topology:**
```
Client → Nginx (round-robin, no sticky sessions)
           ├→ Node 1 (stateless, 3000)
           ├→ Node 2 (stateless, 3000)
           └→ Node 3 (stateless, 3000)
                        ↓
                    Shared Redis
```

**State model:**
- One logical token bucket per customer in Redis, keyed by `rl:<customer_id>`.
- Stores: `{ tokens: float, ts: milliseconds }`.
- Per-node counters are explicitly rejected — they would multiply the effective quota by 3.

**Concurrency guarantee:**
- All three nodes call the same atomic Lua script via `EVAL`.
- Redis executes the script single-threaded; the read → refill → check → decrement → write sequence is serialized.
- Two nodes racing for the last token: exactly one wins, one loses. Both see the same decision.

## Redis Failure Behavior

**If Redis is unreachable:**

The CTO required: *"Errors bias toward under-limiting, not over-limiting."*

Three options existed:
1. **Fail open (allow).** Under Redis outage, this allows arbitrary over-quota traffic. Directly violates the CTO requirement.
2. **Fail closed with 429.** Safe on the limiting axis, but semantically wrong. 429 means "you exceeded your quota," not "we can't determine your quota." Hides the outage from customer telemetry.
3. **Fail closed with 503.** Safe AND honest. `503 Service Unavailable` accurately describes an internal availability problem and signals a transient outage.

**We chose 503.**

```
HTTP/1.1 503 Service Unavailable
Retry-After: 5
Content-Type: application/json
{"error":"rate_limiter_unavailable"}
```

This trades service availability for correctness—an acceptable tradeoff given the CTO's stated priority. Production would mitigate with Redis HA and a short-window local-counter fallback (future work).

## Time Handling

**Production:** `SystemTime` wraps the OS clock.

**Tests:** `FakeTime` advances only when tests direct it.

**Determinism across 3 nodes:**
- The policy resolver receives `nowMs` as an argument and is pure (no I/O, no system clock reads).
- The Lua script receives `now_ms` as an explicit argument.
- No direct `Date.now()` calls in the enforcement path outside the `TimeSource` module.

**Test affordance:**
- `X-Test-Time-Ms` header allows the harness to inject a virtual timestamp.
- Only honored when `RATE_LIMIT_TEST_MODE=true`.
- Silently ignored in any other configuration (production never sees this header).
- Critical for deterministic testing of the 02:00/04:00 boundary without waiting real wall-clock time.

## Policy Transitions

Buckets are **preserved** across policy changes; capacity is **clamped** on downshift.

| Time (UTC) | Effective policy | Behavior |
|---|---|---|
| 01:59:59.999 | 300 RPM / 300 cap | Base tier |
| 02:00:00.000 | 1500 RPM / 1500 cap | Override active; existing tokens retained; larger capacity available for future refill |
| 03:59:59.999 | 1500 RPM / 1500 cap | Override still active |
| 04:00:00.000 | 300 RPM / 300 cap | Override expired; `new_tokens = min(current_tokens, 300)`; no burst carryover into base window |

The Lua script handles this naturally: it always clamps to the *currently effective* capacity. No explicit transition event needed.

## Verification: What Has Been Tested

**Automated tests:** 66/66 passing.
- **Policy resolver (14 tests):** base tiers, override activation, all four half-open boundary instants (01:59:59.999, 02:00:00.000, 03:59:59.999, 04:00:00.000), expired overrides, refill rate arithmetic.
- **Config loader (19 tests):** valid configs, all missing required fields, tier references, duplicate IDs, date parsing, HH:MM format.
- **Redis/Lua (14 tests):** allow/deny, remaining count, partial refill, elapsed-time calculation, capacity invariant, capacity clamp on downshift, atomicity under 50 concurrent requests, customer isolation.
- **HTTP middleware (19 tests):** 200 OK with headers, 429 with Retry-After, 503 on Redis failure (never 429 for infrastructure failure), 400 for missing/unknown customer, X-Test-Time-Ms gating, policy headers (Northwind override inside/outside window).

**Distributed smoke test (manual, verified):**
- Three nodes served traffic in round-robin.
- Shared Redis counter decremented globally (not per-node).
- Exact token exhaustion: seeded 2 tokens at frozen clock, sent 5 requests—exactly 2 allowed, 3 denied with correct `retry_after_ms: 200`.

## Known Limitations & Next Steps

- **Load-testing harness not implemented yet.** The nine assignment scenarios (PRD §15) are not yet proven end-to-end; this is Phase 3, next after this checkpoint.
- **Redis host port exposure** (6379) and `FLUSHDB`/seed operations are development/test conveniences. Not production-safe; production infrastructure must use different isolation.
- **RATE_LIMIT_TEST_MODE env var** is a single switch. Production-grade systems would want stronger boundaries (separate binary or build-time removal). Called out in the README.
- **No config hot-reload.** Config is loaded on startup. SIGHUP-based reload is future work.
- **No persistent audit log.** Config file is the audit surface for the prototype; persistent audit logging is future work.
- **Single Redis instance.** No HA/failover/clustering. Future work with local-counter fallback.

## Decisions Made Today: Summary

This implementation resolves the CTO vs Support conflict via an explicitly approved, audited, time-bounded override mechanism that scales generically to any customer and any override. The token-bucket algorithm provides fair per-customer enforcement with natural burst semantics. Distributed coordination is achieved via atomic Redis Lua, eliminating per-node state and multiplication of effective quotas. Failure modes bias toward safety: Redis infrastructure failures are 503, never 429. Time is injected as a dependency, enabling deterministic testing of the critical 02:00/04:00 boundary without clock mocking. The result is a thin, correct vertical slice of a rate limiter for a real multi-node deployment.
