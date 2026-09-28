# KEVIN.md (totallytics-js)

Scratchpad. Not public-facing.

## What this is
- npm `totallytics` (https://www.npmjs.com/package/totallytics), first published as v0.1.1 on 2026-09-28, with provenance. MIT, zero runtime deps. Repo is PUBLIC since 2026-09-26.
- API analytics middleware for Totallytics (backend: bitgate/totallytics). Wire contract in WIRE.md is FINAL; never change it (its `0.1.0` sdk example strings included).
- Entries: `.` (core `Totallytics`, `bucket`, types), `./hono`, `./workers`, `./express`. tsup ESM+CJS+d.ts, `platform: neutral`.

## Status
- v0.1.1 on npm (`latest`), PR #1 squash 5ccefef. CI (.github/workflows/ci.yml: npm ci, typecheck, test, build, entry smoke) green on master. Backend ingest live on prod (bitgate/totallytics PR #39); tests mock fetch.
- Consumers on npm `"totallytics": "^0.1.1"` (pnpm 10, frozen lockfiles), merged + deployed 2026-09-28: lucid.page PR189 (e611258), ship.page PR228 (3206e7f), webhooks.sh PR82 (db32acd). Deployed Worker bundles (lucid-page, html-drop, wsh-app, wsh-ingress) checked via CF script content: `VERSION = "0.1.1"`.
- Prod CH `analytics.api_requests` had 0 raw-path routes for all three sites before and after: each consumer's own `route` + `ignore` already templates everything it records (raw paths only in `api_errors.path`, by design). 0.1.1 matters for Hono apps without a full `route` override.

## Releases (tag -> workflow -> npm)
- Bump package.json, package-lock.json (top `version` + `packages[""]`), src/version.ts and the `totallytics-js/X` sdk strings in test/*.test.ts. PR, CI green, merge.
- `git tag -a vX.Y.Z <merge sha> && git push origin vX.Y.Z` (tag only). `.github/workflows/release.yml` checks tag == package.json version, runs npm ci/typecheck/test/build, then `npm publish --provenance --access public`.
- Auth: repo secret `NPM_TOKEN` = npm granular bypass-2FA publish token of user `aristotaloss` (set via REST sealed box, fine-grained PAT has secrets write). Token can publish but gets 403 on account calls (`npm profile get`).
- npm drops direct publish for bypass-2FA tokens ~Jan 2027 (github.blog changelog 2026-07-31). Before that: Bart sets up Trusted Publishing on npmjs.com (needs interactive 2FA: GitHub Actions, bitgate/totallytics-js, release.yml), workflow needs npm >= 11.5.1 (Node 22 ships 10.x), then drop NODE_AUTH_TOKEN.
- Verify a release: fresh dir `npm i totallytics@X`, ESM + CJS import of all 4 entries, tsc under node16/nodenext/bundler/node10, `npm audit signatures`. The tarball integrity equals local `npm pack` (tsup build is reproducible).
- Old git-install hack is dead: tag `v0.1.0` (ae728be, force-added dist, off master) stays for history, never on npm. Don't add a `prepare` script.
- Known limits: one API key per middleware instance (key resolved per request, last one wins at seal). Hono can't tell `app.all('/x/*', h)` from `app.use('/x/*', mw)`: both report their wildcard, so a catch-all app needs `route` to split `/*` further.

## Layout
- `src/core/client.ts`: `Totallytics` (record/flush, Workers waitUntil scheduling vs Node interval).
- `src/core/aggregator.ts`: buffer keyed (minute, method, route, status, ua, consumer), 10k key cap, error sample caps 50/20.
- `src/core/transport.ts`: batches serialized once (immutable body), 3 attempts + backoff/jitter, 413 halving, 401 warnOnce, 20 pending cap.
- `src/core/runtime.ts`: env key lookup, process shutdown hooks (beforeExit + SIGTERM re-raise when alone), shared state on `Symbol.for('totallytics.state')`.

## Hono route extraction (verified 4.0.0 and 4.13.9)
- After `await next()`: `c.req.matchedRoutes` (deprecated getter, exists in all v4) + `c.req.routeIndex` (last dispatched handler; stays 0 on Hono's single-match fast path).
- Walk from routeIndex forward: first route that isn't `ALL` + `*` wins (the handler, or the one behind a short-circuiting middleware). None: the first `ALL` wildcard from routeIndex, i.e. the one that ran (`/*`, `/api/*`). Nothing usable: `/*`. Never the raw path (v0.1.0 fell back to it, so catch-alls, 404s and scanner junk leaked raw paths).
- `use('*')` / `all('*')` are stored as `/*`. Paths already include basePath/sub-app mount.
- Other Hono versions: `npm i hono@4.0.0` in a temp dir, swap it into node_modules/hono, run vitest, swap back.
- `hono/route` helper only exists from 4.8, so we don't import it (peer is >=4). If Hono 5 drops `matchedRoutes`, switch to `matchedRoutes(c)` from `hono/route`.

## Verified manually (Sept 2026)
- workerd via miniflare@4 (miniflare@latest is a 5.x alpha with a different options shape): Workers + Hono, concurrent waves, no cross-request I/O warnings.
- Bun 1.4 (Hono + Express), Deno 2.9 (Hono, `--allow-env` needed for env key), Express 4.22 + 5.2, Node SIGTERM/beforeExit scenarios.

## Gotchas
- TypeScript pinned to ~5.9 (npm `typescript@7` is the Go compiler, tsup dts can't use it).
- vitest 5 needs Node >= 22.12; CI is Node 22.
- Tests: `resetSharedState()` clears warned/clients but keeps process hooks (avoids MaxListeners warnings).
- Don't test SIGTERM inside vitest: the handler re-raises SIGTERM and kills the runner.
