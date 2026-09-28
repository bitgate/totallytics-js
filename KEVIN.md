# KEVIN.md (totallytics-js)

Scratchpad. Not public-facing.

## What this is
- npm `totallytics` (https://www.npmjs.com/package/totallytics), first published as v0.1.1 on 2026-09-28, with provenance. MIT, zero runtime deps. Repo is PUBLIC since 2026-09-26.
- API analytics middleware for Totallytics (backend: bitgate/totallytics). Wire contract in WIRE.md is FINAL; never change it (its `0.1.0` sdk example strings included). Only edit so far: the 0.2.0 note that the server folds parameterless 404 routes into `/*`.
- Entries: `.` (core `Totallytics`, `bucket`, types), `./hono`, `./workers`, `./express`, `./fastify`, `./next`. tsup ESM+CJS+d.ts, `platform: neutral`.

## Status
- v0.2.0 on npm (`latest`, 2026-09-28): PR #2 squash b118425, tag v0.2.0, release run 36378668564, provenance verified. 0.1.1 was PR #1 squash 5ccefef. CI (.github/workflows/ci.yml: npm ci, typecheck, test, build, 6-entry smoke, `npm run test:integration`) green on master. Backend ingest live on prod (bitgate/totallytics PR #39); tests mock fetch.
- Consumers on npm `"totallytics": "^0.1.1"` (pnpm 10, frozen lockfiles), merged + deployed 2026-09-28 (`^0.1.1` doesn't float to 0.2.0; nothing they use changed): lucid.page PR189 (e611258), ship.page PR228 (3206e7f), webhooks.sh PR82 (db32acd). Deployed Worker bundles (lucid-page, html-drop, wsh-app, wsh-ingress) checked via CF script content: `VERSION = "0.1.1"`.
- Prod CH `analytics.api_requests` had 0 raw-path routes for all three sites before and after: each consumer's own `route` + `ignore` already templates everything it records (raw paths only in `api_errors.path`, by design). 0.1.1 matters for Hono apps without a full `route` override.

## Releases (tag -> workflow -> npm)
- Bump package.json, package-lock.json (top `version` + `packages[""]`), src/version.ts and the `totallytics-js/X` sdk strings in test/*.test.ts. PR, CI green, merge.
- `git tag -a vX.Y.Z <merge sha> && git push origin vX.Y.Z` (tag only). `.github/workflows/release.yml` checks tag == package.json version, runs npm ci/typecheck/test/build, then `npm publish --provenance --access public`.
- Auth: repo secret `NPM_TOKEN` = npm granular bypass-2FA publish token of user `aristotaloss` (set via REST sealed box, fine-grained PAT has secrets write). Token can publish but gets 403 on account calls (`npm profile get`).
- npm drops direct publish for bypass-2FA tokens ~Jan 2027 (github.blog changelog 2026-07-31). Before that: Bart sets up Trusted Publishing on npmjs.com (needs interactive 2FA: GitHub Actions, bitgate/totallytics-js, release.yml), workflow needs npm >= 11.5.1 (Node 22 ships 10.x), then drop NODE_AUTH_TOKEN.
- Verify a release: fresh dir `npm i totallytics@X`, ESM + CJS import of all 6 entries in a bare install (no frameworks needed: types are type-only imports, `next/server.js` is a lazy import), tsc under node16/nodenext/bundler/node10 with the frameworks installed, `npm audit signatures`. The tarball integrity equals local `npm pack` (tsup build is reproducible).
- Old git-install hack is dead: tag `v0.1.0` (ae728be, force-added dist, off master) stays for history, never on npm. Don't add a `prepare` script.
- Known limits: one API key per middleware instance (key resolved per request, last one wins at seal). Hono can't tell `app.all('/x/*', h)` from `app.use('/x/*', mw)`: both report their wildcard, so a catch-all app needs `route` to split `/*` further. Express sends the raw path when no route matched (404s, short-circuiting middleware); the server only folds parameterless 404s into `/*`.

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

## Fastify adapter (probed 4.0.0/4.10.2/4.15.0/4.29.1/5.0.0/5.12.5; tests run 4.29.1 via the `fastify4` alias + 5.x)
- Factory `totallytics(opts)` returns the plugin plus `.flush()`: `app.register(totallytics())`, not the `register(plugin, opts)` idiom. fastify-plugin symbols set by hand (skip-override, display-name, plugin-meta `{ name }`), no dependency, no `fastify` semver range so a future major doesn't refuse to register.
- Template: `request.routeOptions.url` (4.10+), `routerPath` only when `routeOptions` is absent (4.0-4.9; FSTDEP017 from 4.15, gone in 5). `request.is404` → `/*`. Prefixes are already in the url. `/api/` stays `/api/` on 4.x, `/api` on 5.
- Hooks: onRequest start (WeakMap), onError keeps the error, `reply.raw` finish/close records (499 when aborted before headers), onClose flushes. Covers routes registered before and after the plugin (verified v4 + v5).
- Dev-only audit noise: the EOL `fastify4` alias adds 2 high advisories (fastify <=5.12.0, find-my-way <=9.6.0). Not shipped.

## Next.js adapter (integration-tested 14.2.35, 15.5.26, 16.3.6; node + edge)
- `withTotallytics(handler, opts)` returns `H` unchanged (Next's route type checks keep passing). Template: decoded pathname segments, params right to left (catch-alls come last), arrays → `*`, strings → `:name`; `route` (string or fn) wins. Wrong when a param value equals a later static segment (`/users/[id]/posts` with id `posts`): user passes `route`.
- `next/server.js` via a module-level dynamic `import()`: a static `after` import breaks 14/15.0 edge builds (strict export presence), and webpack 15.x emits an empty `import * as` namespace (`next/server.js` is aliased to `next/dist/api/server`, an `export *` from CJS). Turbopack (16) handles both.
- Flush: `after()` (15.1+), leading edge then one shared trailing flush per `flushDelayMs` gap (default 1000, max 20000). Trackers shared across wrappers with identical JSON options (not for function apiKey). No `after()` (14, 15.0) or it throws: background task + `globalThis[Symbol.for('@vercel/request-context')].get().waitUntil`, plus the client's interval + shutdown hooks.
- Next 14 ISR trap: reading `request.headers` in a static/ISR GET sets `store.revalidate = 0` → `Invariant: invalid Cache-Control duration provided: 0 < 1` → 500. So without `after()`, GET/HEAD get no user agent (user `consumer`/`ignore`/`route` callbacks reading headers there can still poison ISR). With `after()` the read happens after the response; in revalidations it throws DynamicServerError, caught, no row.
- `NEXT_PHASE === 'phase-production-build'` → passthrough. Digests: `NEXT_NOT_FOUND` 404, `NEXT_REDIRECT;…;status;` status, `NEXT_HTTP_ERROR_FALLBACK;status` status (no error sample); other digests rethrown unrecorded; non-Response return → 500.
- Never recorded: cached/static responses, unmatched URLs (Next's 404 page), Next 14 default-static GETs (no dynamic API use, no `force-dynamic`). Pages Router API routes unsupported by choice.
- Integration: `npm run build && npm run test:integration`. Per version: temp dir, npm install pinned next/react, copy package.json + dist into node_modules/totallytics (no `file:` link), `next build` + `next start`, real ingest server. Fixture `next.config.mjs` pins `experimental.cpus: 2`. Children get their own process group and are group-killed.

## Verified manually (Sept 2026)
- workerd via miniflare@4 (miniflare@latest is a 5.x alpha with a different options shape): Workers + Hono, concurrent waves, no cross-request I/O warnings.
- Bun 1.4 (Hono + Express), Deno 2.9 (Hono, `--allow-env` needed for env key), Express 4.22 + 5.2, Node SIGTERM/beforeExit scenarios.

## Gotchas
- TypeScript pinned to ~5.9 (npm `typescript@7` is the Go compiler, tsup dts can't use it).
- vitest 5 needs Node >= 22.12; CI is Node 22.
- Tests: `resetSharedState()` clears warned/clients but keeps process hooks (avoids MaxListeners warnings).
- Don't test SIGTERM inside vitest: the handler re-raises SIGTERM and kills the runner.
- e2b sandboxes: PID 1 is `sleep infinity` (never reaps), cgroup pids.max 512. Killed process trees pile up zombies until `next build` workers hit `spawn EAGAIN`: use a fresh sandbox. Background jobs die when the e2b call ends. Never `pkill -f` a pattern that appears in your own script.
