# KEVIN.md (totallytics-js)

Scratchpad. Not public-facing.

## What this is
- npm `totallytics` (NOT published, no npm token; don't publish; name still unclaimed). v0.1.0, MIT, zero runtime deps. Repo is PUBLIC since 2026-09-26.
- API analytics middleware for Totallytics (backend: bitgate/totallytics). Wire contract in WIRE.md is FINAL; never change it.
- Entries: `.` (core `Totallytics`, `bucket`, types), `./hono`, `./workers`, `./express`. tsup ESM+CJS+d.ts, `platform: neutral`.

## Status
- v0.1.0 done, CI green on master (.github/workflows/ci.yml: npm ci, typecheck, test, build, entry smoke). Backend ingest not deployed yet; tests mock fetch.
- Known limits: one API key per middleware instance (key resolved per request, last one wins at seal). Hono `app.all('/x/*', handler)` reports the raw path (indistinguishable from middleware).

## Layout
- `src/core/client.ts`: `Totallytics` (record/flush, Workers waitUntil scheduling vs Node interval).
- `src/core/aggregator.ts`: buffer keyed (minute, method, route, status, ua, consumer), 10k key cap, error sample caps 50/20.
- `src/core/transport.ts`: batches serialized once (immutable body), 3 attempts + backoff/jitter, 413 halving, 401 warnOnce, 20 pending cap.
- `src/core/runtime.ts`: env key lookup, process shutdown hooks (beforeExit + SIGTERM re-raise when alone), shared state on `Symbol.for('totallytics.state')`.

## Hono route extraction (verified 4.0.0 and 4.13.9)
- After `await next()`: `c.req.matchedRoutes` (deprecated getter, exists in all v4) + `c.req.routeIndex` (last dispatched handler).
- Walk from routeIndex forward, skip `method === 'ALL' && path.endsWith('*')` (middleware). Paths already include basePath/sub-app mount.
- `hono/route` helper only exists from 4.8, so we don't import it (peer is >=4). If Hono 5 drops `matchedRoutes`, switch to `matchedRoutes(c)` from `hono/route`.

## Verified manually (Sept 2026)
- workerd via miniflare@4 (miniflare@latest is a 5.x alpha with a different options shape): Workers + Hono, concurrent waves, no cross-request I/O warnings.
- Bun 1.4 (Hono + Express), Deno 2.9 (Hono, `--allow-env` needed for env key), Express 4.22 + 5.2, Node SIGTERM/beforeExit scenarios.

## Gotchas
- TypeScript pinned to ~5.9 (npm `typescript@7` is the Go compiler, tsup dts can't use it).
- vitest 5 needs Node >= 22.12; CI is Node 22.
- Tests: `resetSharedState()` clears warned/clients but keeps process hooks (avoids MaxListeners warnings).
- Don't test SIGTERM inside vitest: the handler re-raises SIGTERM and kills the runner.
