import { Totallytics } from './core/client'
import { defaultKey, normalizeKey, sleep, warnNoKey, warnOnce } from './core/runtime'
import type { SharedOptions, WaitUntil } from './core/types'
import { attempt, debugLogger, describeError, pathOf } from './core/util'

export interface RouteContext {
  params?: unknown
}

interface RouteHandlerMethod {
  // Method syntax keeps the parameters bivariant, so handlers typed with NextRequest still fit
  handle(request: Request, context: RouteContext): unknown
}

export type RouteHandler = RouteHandlerMethod['handle']

export interface NextOptions extends SharedOptions {
  /** Defaults to `process.env.TOTALLYTICS_API_KEY`. */
  apiKey?: string | (() => string | null | undefined)
  /** Opaque consumer id, called once the handler has returned. */
  consumer?: (request: Request, response: Response | undefined) => string | null | undefined
  /** Route template such as `/users/:id`. Wins over the template derived from `params`. */
  route?: string | ((request: Request) => string | null | undefined)
  /** Return true to skip the request. */
  ignore?: (request: Request, response: Response | undefined) => boolean
  /** Minimum gap between the flushes that run after responses. Default 1000. */
  flushDelayMs?: number
}

interface Exchange {
  request: Request
  context: RouteContext | undefined
  response: Response | undefined
  thrown: unknown
  failed: boolean
  startedAt: number
  durationMs: number
}

interface Tracker {
  client: Totallytics
  flushSoon: () => Promise<void>
}

interface NextServer {
  after?: (task: () => Promise<void>) => void
}

interface VercelRequestContext {
  get?: () => { waitUntil?: WaitUntil } | undefined
}

const BUILD_PHASE = 'phase-production-build'
const CACHEABLE_METHODS = new Set(['GET', 'HEAD'])
const DEFAULT_FLUSH_GAP_MS = 1_000
const MAX_FLUSH_GAP_MS = 20_000
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context')

const trackers = new Map<string, Tracker>()

// Imported lazily: bundlers reject a static `after` import on versions without it (14, 15.0)
const nextServer: Promise<NextServer | undefined> = import('next/server.js').catch(() => undefined)

export function withTotallytics<H extends RouteHandler>(handler: H, options: NextOptions = {}): H {
  const { apiKey, consumer, route, ignore, debug } = options
  const log = debugLogger(debug)
  const { client, flushSoon } = trackerFor(options)

  const track = async ({ request, context, response, thrown, failed, startedAt, durationMs }: Exchange, settled: boolean) => {
    try {
      const status = failed ? thrownStatus(thrown) : responseStatus(response)
      if (status === undefined) return

      const key = typeof apiKey === 'function' ? normalizeKey(attempt(apiKey, log)) : (normalizeKey(apiKey) ?? defaultKey())
      if (!key) return warnNoKey(debug)
      if (ignore && attempt(() => ignore(request, response), log)) return

      // Before the response settles, reading headers would break static and ISR GET routes
      const readsHeaders = settled || !CACHEABLE_METHODS.has(request.method)
      const userAgent = readsHeaders ? (request.headers.get('user-agent') ?? undefined) : undefined
      const path = pathnameOf(request)
      const template = (typeof route === 'function' ? attempt(() => route(request), log) : route) || (await routeTemplate(path, context))

      client.apiKey = key
      client.record({
        method: request.method,
        path,
        route: template,
        status,
        durationMs,
        startedAt,
        userAgent,
        consumer: consumer && attempt(() => consumer(request, response), log),
        error: failed && status >= 500 ? thrown : undefined,
      })
    } catch (error) {
      return log?.(`tracking failed: ${describeError(error)}`)
    }
    return flushSoon()
  }

  const wrapped = async (request: Request, context: RouteContext) => {
    if (isBuilding()) return handler(request, context)

    const after = (await nextServer)?.after
    const startedAt = Date.now()
    const start = performance.now()
    let response: Response | undefined
    let thrown: unknown
    let failed = false

    try {
      response = (await handler(request, context)) as Response | undefined
      return response
    } catch (error) {
      failed = true
      thrown = error
      throw error
    } finally {
      const exchange = { request, context, response, thrown, failed, startedAt, durationMs: performance.now() - start }
      runAfterResponse(after, (settled) => track(exchange, settled), debug)
    }
  }

  return wrapped as H
}

function trackerFor(options: NextOptions): Tracker {
  const { apiKey, endpoint, maxBatchRows, errorSamples, debug, flushDelayMs } = options
  const signature =
    typeof apiKey === 'function' ? undefined : JSON.stringify([apiKey, endpoint, maxBatchRows, errorSamples, debug, flushDelayMs])

  const cached = signature === undefined ? undefined : trackers.get(signature)
  if (cached) return cached

  const client = new Totallytics({ endpoint, maxBatchRows, errorSamples, debug, integration: 'next' })
  const tracker = { client, flushSoon: flushScheduler(client, flushGap(flushDelayMs)) }
  if (signature !== undefined) trackers.set(signature, tracker)
  return tracker
}

// Flushes right away when idle, otherwise at most once per gap
function flushScheduler(client: Totallytics, gapMs: number): () => Promise<void> {
  let lastFlushAt = 0
  let pending: Promise<void> | undefined

  return () =>
    (pending ??= sleep(Math.max(0, lastFlushAt + gapMs - Date.now())).then(() => {
      pending = undefined
      lastFlushAt = Date.now()
      return client.flush()
    }))
}

function runAfterResponse(
  after: NextServer['after'],
  task: (settled: boolean) => Promise<void>,
  debug: boolean | undefined,
): void {
  try {
    if (typeof after === 'function') return after(() => task(true))
  } catch {
    // `after` needs a request scope, so we fall back to a background flush below
  }
  if (debug) warnOnce('next-after', 'after() from next/server is unavailable, flushing in the background')

  const promise = task(false)
  const context = (globalThis as Record<symbol, VercelRequestContext | undefined>)[VERCEL_REQUEST_CONTEXT]
  attempt(() => context?.get?.()?.waitUntil?.(promise))
}

function isBuilding(): boolean {
  return typeof process !== 'undefined' && process.env?.NEXT_PHASE === BUILD_PHASE
}

function flushGap(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_FLUSH_GAP_MS
  return Math.min(Math.max(ms, 0), MAX_FLUSH_GAP_MS)
}

// Next resolves redirect() and notFound() into responses, other digests are internal control flow
function thrownStatus(error: unknown): number | undefined {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest
  if (typeof digest !== 'string') return 500
  if (digest === 'NEXT_NOT_FOUND') return 404

  const parts = digest.split(';')
  if (parts[0] === 'NEXT_REDIRECT') return httpStatus(parts.at(-2), 307)
  if (parts[0] === 'NEXT_HTTP_ERROR_FALLBACK') return httpStatus(parts[1], 404)
  return undefined
}

function responseStatus(response: unknown): number {
  const status = (response as { status?: unknown } | null | undefined)?.status
  return typeof status === 'number' ? status : 500
}

function httpStatus(value: string | undefined, fallback: number): number {
  const status = Number(value)
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : fallback
}

function pathnameOf(request: Request): string {
  const nextUrl = (request as { nextUrl?: { basePath?: unknown; pathname?: unknown } }).nextUrl
  if (typeof nextUrl?.pathname !== 'string') return pathOf(request.url)

  const base = typeof nextUrl.basePath === 'string' ? nextUrl.basePath : ''
  return base && nextUrl.pathname === '/' ? base : base + nextUrl.pathname
}

// Maps the resolved params back onto the path, right to left since catch-alls come last
async function routeTemplate(path: string, context: RouteContext | undefined): Promise<string | undefined> {
  const params: unknown = await context?.params
  if (!params || typeof params !== 'object') return undefined

  const segments = path.split('/')
  let end = segments.at(-1) === '' ? segments.length - 1 : segments.length

  for (const [name, value] of Object.entries(params as Record<string, unknown>).reverse()) {
    if (Array.isArray(value)) {
      const start = end - value.length
      if (value.length === 0 || start < 1) continue
      if (value.some((part, offset) => decode(segments[start + offset]) !== part)) continue
      segments.splice(start, value.length, '*')
      end = start
    } else if (typeof value === 'string') {
      let index = end - 1
      while (index > 0 && decode(segments[index]) !== value) index--
      if (index < 1) continue
      segments[index] = `:${name}`
      end = index
    }
  }

  return segments.join('/')
}

function decode(segment: string | undefined): string | undefined {
  try {
    return segment === undefined ? undefined : decodeURIComponent(segment)
  } catch {
    return segment
  }
}
