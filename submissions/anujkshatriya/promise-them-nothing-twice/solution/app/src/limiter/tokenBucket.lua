-- tokenBucket.lua — atomic token-bucket enforcement
--
-- KEYS[1]  : bucket key ("rl:<customer_id>")
-- ARGV[1]  : now_ms       (epoch ms supplied by caller — never read system clock here)
-- ARGV[2]  : refill_rate  (tokens per second, e.g. 5 for 300 RPM)
-- ARGV[3]  : capacity     (max tokens, e.g. 300)
--
-- Returns an array: { allowed, remaining, retry_after_ms }
--   allowed        : 1 if request is granted, 0 if denied
--   remaining      : floor(tokens after decision); 0 on deny
--   retry_after_ms : 0 when allowed; ms until next token available when denied

local key         = KEYS[1]
local now_ms      = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local capacity    = tonumber(ARGV[3])

-- Read stored state (nil fields mean no bucket exists yet).
local stored = redis.call('HMGET', key, 'tokens', 'ts')
local tokens  = tonumber(stored[1])
local last_ts = tonumber(stored[2])

-- First request for this customer: start with a full bucket.
if tokens == nil then
  tokens  = capacity
  last_ts = now_ms
end

-- Lazy refill: accumulate tokens proportional to elapsed time.
-- max(0,...) guards against backward clock skew between nodes.
local elapsed  = math.max(0, (now_ms - last_ts) / 1000)
local refilled = math.min(capacity, tokens + elapsed * refill_rate)

-- Consume one token if available.
local new_tokens
local allowed        = 0
local remaining      = 0
local retry_after_ms = 0

if refilled >= 1 then
  new_tokens = refilled - 1
  allowed    = 1
  remaining  = math.floor(new_tokens)
else
  new_tokens    = refilled
  retry_after_ms = math.ceil((1 - new_tokens) / refill_rate * 1000)
end

-- Persist and refresh TTL.
-- TTL = 10× full-bucket refill time (min 60 s) so idle buckets GC
-- but active buckets never expire mid-use.
local full_refill_s = math.ceil(capacity / refill_rate)
local ttl_ms        = math.max(60000, full_refill_s * 10 * 1000)

redis.call('HSET', key, 'tokens', tostring(new_tokens), 'ts', tostring(now_ms))
redis.call('PEXPIRE', key, ttl_ms)

return { allowed, remaining, retry_after_ms }
