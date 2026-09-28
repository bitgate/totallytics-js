import type { Context, Env, MiddlewareHandler } from 'hono'
import { Totallytics } from './core/client'
import { defaultKey, normalizeKey, warnNoKey } from './core/runtime'
import type { SharedOptions, WaitUntil } from './core/types'
import { attempt, debugLogger, describeError } from './core/util'

export interface HonoOptions<E extends Env = any> extends SharedOptions {
  /** Defaults to `c.env.TOTALLYTICS_API_KEY`, then `process.env.TOTALLYTICS_API_KEY`. */
  apiKey?: string | ((c: Context<E>) => string | null | undefined)
  /** Opaque consumer id, called after the response is ready. */
  consumer?: (c: Context<E>) => string | null | undefined
  /** Overrides the detected route template. */
  route?: (c: Context<E>) => string | null | undefined
  /** Return true to skip the request. */
  ignore?: (c: Context<E>) => boolean
  /** Flush interval without `executionCtx` (Node, Bun, Deno). Default 10000. */
  flushIntervalMs?: number
  /** Delay before a `waitUntil` flush on Workers, max 20000. Default 5000. */
  flushDelayMs?: number
}

export type TotallyticsMiddleware<E extends Env = any> = MiddlewareHandler<E> & {
  /** Sends everything buffered and waits for in-flight batches. Never rejects. */
  flush(): Promise<void>
}

interface MatchedRoute {
  method?: unknown
  path?: unknown
}

const CATCH_ALL_ROUTE = '/*'

export function totallytics<E extends Env = any>(options: HonoOptions<E> = {}): TotallyticsMiddleware<E> {
  const { apiKey, consumer, route, ignore, ...config } = options
  const client = new Totallytics({ ...config, integration: 'hono' })
  const log = debugLogger(config.debug)

  const track = (c: Context<E>, startedAt: number, durationMs: number, failed: boolean, thrown: unknown) => {
    try {
      const key =
        typeof apiKey === 'function'
          ? normalizeKey(attempt(() => apiKey(c), log))
          : (normalizeKey(apiKey) ?? defaultKey(c.env))
      if (!key) return warnNoKey(config.debug)
      if (ignore && attempt(() => ignore(c), log)) return

      client.apiKey = key
      client.record(
        {
          method: c.req.method,
          path: c.req.path,
          route: (route && attempt(() => route(c), log)) || attempt(() => routeTemplate(c), log) || CATCH_ALL_ROUTE,
          status: failed ? 500 : c.res.status,
          durationMs,
          startedAt,
          userAgent: c.req.header('User-Agent'),
          consumer: consumer && attempt(() => consumer(c), log),
          error: failed ? thrown : c.error,
        },
        waitUntilOf(c),
      )
    } catch (error) {
      log?.(`tracking failed: ${describeError(error)}`)
    }
  }

  const middleware: MiddlewareHandler<E> = async (c, next) => {
    const startedAt = Date.now()
    const start = performance.now()
    let failed = false
    let thrown: unknown

    try {
      await next()
    } catch (error) {
      failed = true
      thrown = error
      throw error
    } finally {
      track(c, startedAt, performance.now() - start, failed, thrown)
    }
  }

  return Object.assign(middleware, { flush: () => client.flush() })
}

// The route that responded, the first handler behind a middleware that short-circuited, else the wildcard that ran
function routeTemplate(c: Context): string | undefined {
  const req = c.req as unknown as { matchedRoutes?: MatchedRoute[]; routeIndex?: number }
  const routes = req.matchedRoutes
  if (!Array.isArray(routes)) return undefined

  let wildcard: string | undefined
  for (let i = req.routeIndex ?? 0; i < routes.length; i++) {
    const candidate = routes[i]
    if (!candidate || typeof candidate.path !== 'string') continue
    if (candidate.method === 'ALL' && candidate.path.endsWith('*')) {
      wildcard ??= candidate.path
      continue
    }
    return candidate.path
  }
  return wildcard
}

function waitUntilOf(c: Context): WaitUntil | undefined {
  try {
    const ctx = c.executionCtx
    return typeof ctx?.waitUntil === 'function' ? (promise) => ctx.waitUntil(promise) : undefined
  } catch {
    return undefined
  }
}
