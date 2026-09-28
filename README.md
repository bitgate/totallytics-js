# totallytics

API analytics middleware for [Totallytics](https://totallytics.com): request counts, status codes, latency, clients and consumers for Hono, Cloudflare Workers, Express, Fastify and Next.js. Zero dependencies. Runs on Node 18+, Bun, Deno and Workers.

Requests are aggregated in memory and sent in small background batches. The middleware never throws into your code and never delays a response.

```sh
npm i totallytics
```

Set `TOTALLYTICS_API_KEY` as a Workers secret, or as an environment variable on Node, Bun and Deno (`--allow-env`). Without a key the middleware does nothing.

## Hono

```ts
import { Hono } from 'hono'
import { totallytics } from 'totallytics/hono'

const app = new Hono()
app.use('*', totallytics())

app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }))

export default app
```

Register it first so it sees every request. Routes are reported as templates (`/users/:id`), including sub-apps and `basePath`. When no concrete route answers (an `app.all('*')` catch-all, a 404, or middleware that responds on its own), the wildcard that ran is reported instead, like `/*` or `/api/*`, never the raw path. Pass `route` to split those further. On Workers the key comes from `c.env.TOTALLYTICS_API_KEY` and flushing goes through `c.executionCtx.waitUntil`.

## Cloudflare Workers

```ts
import { withTotallytics } from 'totallytics/workers'

export default withTotallytics({
  async fetch(request, env, ctx) {
    return new Response('hello')
  },
} satisfies ExportedHandler<Env>)
```

Other handlers (`scheduled`, `queue`, ...) pass through untouched. Plain Workers have no router, so the raw path is sent and Totallytics collapses id-like segments. Pass `route` to send your own templates.

## Express

```ts
import express from 'express'
import { totallytics, totallyticsErrors } from 'totallytics/express'

const app = express()
app.use(totallytics())

app.get('/users/:id', (req, res) => res.json({ id: req.params.id }))

app.use(totallyticsErrors())
app.use(errorHandler)
```

`totallyticsErrors()` is optional: it attaches `err.message` to error samples and passes the error on. Routes are `req.baseUrl + req.route.path`, so a mount path with params (`/orgs/:orgId`) shows up with the actual value, which Totallytics collapses when it looks like an id.

## Fastify

```ts
import Fastify from 'fastify'
import { totallytics } from 'totallytics/fastify'

const app = Fastify()
app.register(totallytics())

app.get('/users/:id', async (request) => request.params)
```

Fastify 4 and 5. Register it on the root instance: the hooks then cover every route, in any registration order, including prefixed plugins. Routes come from Fastify's router (`/users/:id`, `/api/posts/:postId`, `/files/*`), unmatched requests are reported as `/*`. Thrown errors are attached to error samples, and `app.close()` flushes what is buffered.

## Next.js

```ts
// app/users/[id]/route.ts
import { withTotallytics } from 'totallytics/next'

async function getUser(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return Response.json({ id })
}

export const GET = withTotallytics(getUser)
```

Wrap each App Router route handler, on Next.js 14 and up, in the Node.js or edge runtime. Pages Router API routes are not supported.

Next.js has no runtime API for the matched route, so the template is rebuilt from `params`: `/users/42` becomes `/users/:id` and a `[...slug]` catch-all becomes `*`. Pass `route: '/users/:id'` where that goes wrong, for example behind a rewrite. `notFound()` and `redirect()` are recorded with the status Next.js sends, other errors as 500, and they are rethrown.

- Next.js 15.1+ flushes after the response with `after()`, at most once per `flushDelayMs` (default 1000).
- Older versions have no `after()`, so the flush runs in the background: kept alive with `waitUntil` on Vercel, best-effort on other serverless hosts. GET and HEAD requests are recorded without a user agent there, since reading headers mid-request can break static and ISR route handlers.
- Cached responses and URLs that match no route never reach a handler, so they are not recorded. Nothing is recorded during `next build`.

## Options

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `TOTALLYTICS_API_KEY` | String or function: `(c)` on Hono, `(env)` on Workers, `()` on Express, Fastify and Next.js. One key per middleware |
| `consumer` | none | Returns an opaque id for the caller: `(c)`, `(request, env)`, `(req, res)`, `(request, reply)` or `(request, response)` |
| `route` | detected | Overrides the route template, same arguments as `consumer`. On Next.js a string or `(request)` |
| `ignore` | none | Return `true` to skip a request, same arguments as `consumer` |
| `endpoint` | `https://totallytics.com/api/ingest` | Ingest URL |
| `flushIntervalMs` | `10000` | Flush interval on Node, Bun and Deno |
| `flushDelayMs` | `5000` | Delay before the `waitUntil` flush on Workers. On Next.js the minimum gap between flushes, default `1000`. Max 20000 |
| `maxBatchRows` | `1000` | Metric rows per request, max 5000 |
| `errorSamples` | `true` | Send individual 4xx/5xx requests (per flush: 50 5xx, 20 4xx) |
| `debug` | `false` | Log diagnostics with `console.warn` |

```ts
app.use('*', totallytics({
  consumer: (c) => c.get('account')?.id,
  ignore: (c) => c.req.path === '/health',
}))
```

## Privacy

- Never sent: request or response bodies, headers other than `User-Agent`, query strings, IP addresses.
- `consumer` is whatever you return. Use an opaque id such as an internal account id, not an email address or API key.
- Error samples contain the raw path and the error message. If either can hold personal data, use `errorSamples: false`.

## How it behaves

- Duration runs from the middleware until your handler returns a response. Streaming bodies are not included, except on Express and Fastify, which measure until the response is sent. Deployed Workers only advance clocks on I/O, so purely CPU-bound handlers report about 0 ms.
- Node, Bun and Deno flush on an unref'd timer, plus a best-effort flush on `beforeExit` and `SIGTERM`. When no other `SIGTERM` listener exists, the signal is re-raised after the flush (5 s max), so the process still terminates. On runtimes that freeze between requests, call `await middleware.flush()` yourself.
- Workers use one shared flush per isolate, `flushDelayMs` after the first request, kept alive with `ctx.waitUntil` on every request. A full batch is sent right away.
- Failed sends (408, 429, 5xx, network errors, timeouts) are retried, up to 3 attempts in total, with the identical payload and `batch_id`, so the server can drop duplicates. 413 splits the batch, 400 drops it, 401 drops it and warns once.
- Express and Fastify requests aborted by the client before headers were sent are recorded as `499`.

## Other frameworks

```ts
import { Totallytics } from 'totallytics'

const tt = new Totallytics({ integration: 'koa' })

// After each response
tt.record({ method, path, route, status, durationMs, userAgent, consumer, error })

// On Workers-style runtimes, hand the flush to waitUntil
tt.record(entry, (promise) => ctx.waitUntil(promise))

// Before a serverless runtime freezes
await tt.flush()
```

The wire format is documented in [WIRE.md](./WIRE.md).

## License

MIT
