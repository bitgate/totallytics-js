# Totallytics ingest wire format, v1

Everything an SDK needs: aggregate requests per minute in memory, POST them in batches, retry safely.

## Request

```
POST https://totallytics.com/api/ingest
Authorization: Bearer <key>            keys look like tt_<48 hex chars>
Content-Type: application/json
User-Agent: <sdk-name>/<version>
```

```json
{
  "v": 1,
  "batch_id": "b8f3c0d2e1a94f7e9c1b2a3d4e5f6a7b",
  "sdk": "totallytics-js/0.1.0 hono",
  "metrics": [
    {
      "minute": 1790391600,
      "method": "GET",
      "route": "/users/:id",
      "status": 200,
      "user_agent": "okhttp/4.12.0",
      "consumer": "cust_42",
      "count": 12,
      "duration_ms_sum": 845.2,
      "histogram": { "40": 3, "41": 9 }
    }
  ],
  "errors": [
    {
      "ts": 1790391612345,
      "method": "POST",
      "route": "/users/:id",
      "path": "/users/123",
      "status": 500,
      "duration_ms": 12.3,
      "user_agent": "okhttp/4.12.0",
      "consumer": "cust_42",
      "message": "TypeError: x is undefined"
    }
  ]
}
```

| Field | Rules |
| --- | --- |
| `v` | Always `1` |
| `batch_id` | 8-64 chars of `[A-Za-z0-9_-]`, unique per batch. The server deduplicates on it |
| `sdk` | Optional, at most 64 chars |
| `metrics` | At most 5000 rows. Send at most 1000 per batch by default |
| `errors` | At most 200 rows |

### Metric rows

One row per aggregation key `(minute, method, route, status, user_agent, consumer)`.

| Field | Rules |
| --- | --- |
| `minute` | Unix **seconds** of the request start, floored to the minute. Rows older than 7 days are rejected |
| `method` | Uppercase |
| `route` | Route template (`/users/:id`) when known, otherwise the raw path without query string. The server collapses id-like segments |
| `status` | 100-599 |
| `user_agent` | Optional. Caller's raw `User-Agent`, truncated to 512 chars |
| `consumer` | Optional. Opaque id of the API consumer, truncated to 128 chars |
| `count` | Requests in the row, at least 1 |
| `duration_ms_sum` | Sum of durations in milliseconds |
| `histogram` | Latency bucket index to count. The counts add up to `count` |

Latency buckets grow by 8%. Bucket 0 holds everything up to 1 ms (and NaN or negative values), bucket `i` covers `(1.08^(i-1), 1.08^i]` ms, capped at 250:

```js
const bucket = (ms) => (!(ms > 1) ? 0 : Math.min(Math.ceil(Math.log(ms) / Math.log(1.08)), 250))
```

### Error rows

Individually sampled 4xx and 5xx requests. Suggested cap per batch: 50 5xx and 20 4xx.

| Field | Rules |
| --- | --- |
| `ts` | Unix **milliseconds** |
| `method`, `route`, `status`, `user_agent`, `consumer` | As in metric rows |
| `path` | Raw path without query string, truncated to 512 chars |
| `duration_ms` | Duration of this request |
| `message` | Optional. Error message, truncated to 1000 chars |

Every sampled error is also counted in `metrics`.

## Responses

| Status | Meaning | SDK action |
| --- | --- | --- |
| `202` | `{"accepted":{"metrics":n,"errors":m},"rejected":r}` | Done |
| `400` | Invalid payload | Drop, do not retry |
| `401` | Bad or revoked key | Drop, warn once per process |
| `413` | Payload too large | Split the rows in half, send each half as a new batch |
| `408`, `429`, `5xx`, network error, timeout | Temporary | Retry with exponential backoff and jitter |

## Idempotency

- Serialize a batch once. A retry resends the byte-identical body with the same `batch_id`.
- A flushed batch is immutable. New requests go into a fresh buffer, never into a batch waiting for a retry.
- A 413 split produces new batches with new `batch_id`s.

## Recommended client behavior

- Measure around the handler and record after the response is ready. Never throw into user code or delay the response.
- Flush every 10 s on long-lived servers, and when the buffer reaches the row limit. On serverless runtimes, flush in the background after the response (`waitUntil`).
- Bound memory: cap distinct keys per buffer (10k) and pending retry batches (20, drop the oldest).
- Retry up to 3 attempts with a 10 s timeout per attempt.
- Never send bodies, headers other than `User-Agent`, or query strings.

## Minimal SDK

```js
const buffer = new Map()

function record({ startMs, method, route, status, durationMs, userAgent, consumer }) {
  const minute = Math.floor(startMs / 60000) * 60
  const key = JSON.stringify([minute, method, route, status, userAgent, consumer])
  let row = buffer.get(key)
  if (!row) {
    row = { minute, method, route, status, user_agent: userAgent, consumer, count: 0, duration_ms_sum: 0, histogram: {} }
    buffer.set(key, row)
  }
  row.count += 1
  row.duration_ms_sum += durationMs
  const index = bucket(durationMs)
  row.histogram[index] = (row.histogram[index] ?? 0) + 1
}

async function flush(key) {
  const metrics = [...buffer.values()]
  buffer.clear()
  if (metrics.length === 0) return
  const body = JSON.stringify({ v: 1, batch_id: crypto.randomUUID().replaceAll('-', ''), metrics, errors: [] })

  for (let attempt = 1; attempt <= 3; attempt++) {
    const status = await fetch('https://totallytics.com/api/ingest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'my-sdk/1.0.0' },
      body,
      signal: AbortSignal.timeout(10000),
    }).then((response) => response.status, () => 0)

    if (status !== 0 && status !== 408 && status !== 429 && status < 500) return
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500 * Math.random()))
  }
}
```

A complete SDK adds 413 splitting, error samples, the retry queue cap and a one-time 401 warning.
