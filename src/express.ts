import { Totallytics } from './core/client'
import { defaultKey, normalizeKey, warnNoKey } from './core/runtime'
import type { SharedOptions } from './core/types'
import { attempt, debugLogger, describeError } from './core/util'

export interface ExpressRequestLike {
  method: string
  originalUrl?: string
  url?: string
  baseUrl?: string
  route?: { path?: unknown }
  headers: Record<string, string | string[] | undefined>
}

export interface ExpressResponseLike {
  statusCode: number
  headersSent: boolean
  writableFinished?: boolean
  once(event: 'finish' | 'close', listener: () => void): unknown
}

export type NextFunctionLike = (error?: unknown) => void

export interface ExpressOptions<Req = ExpressRequestLike, Res = ExpressResponseLike> extends SharedOptions {
  /** Defaults to `process.env.TOTALLYTICS_API_KEY`. */
  apiKey?: string | (() => string | null | undefined)
  /** Opaque consumer id, called once the response has finished. */
  consumer?: (req: Req, res: Res) => string | null | undefined
  /** Overrides the detected route template. */
  route?: (req: Req, res: Res) => string | null | undefined
  /** Return true to skip the request. */
  ignore?: (req: Req, res: Res) => boolean
  /** Flush interval. Default 10000. */
  flushIntervalMs?: number
}

export type TotallyticsMiddleware<Req = ExpressRequestLike, Res = ExpressResponseLike> = ((
  req: Req,
  res: Res,
  next: NextFunctionLike,
) => void) & {
  /** Sends everything buffered and waits for in-flight batches. Never rejects. */
  flush(): Promise<void>
}

export type ErrorCaptureMiddleware = (error: unknown, req: object, res: unknown, next: NextFunctionLike) => void

const CLIENT_CLOSED_REQUEST = 499
const capturedErrors = new WeakMap<object, unknown>()

export function totallytics<
  Req extends ExpressRequestLike = ExpressRequestLike,
  Res extends ExpressResponseLike = ExpressResponseLike,
>(options: ExpressOptions<Req, Res> = {}): TotallyticsMiddleware<Req, Res> {
  const { apiKey, consumer, route, ignore, ...config } = options
  const client = new Totallytics({ ...config, integration: 'express' })
  const log = debugLogger(config.debug)

  const track = (req: Req, res: Res, startedAt: number, durationMs: number, aborted: boolean) => {
    try {
      const key = typeof apiKey === 'function' ? normalizeKey(attempt(apiKey, log)) : (normalizeKey(apiKey) ?? defaultKey())
      if (!key) return warnNoKey(config.debug)
      if (ignore && attempt(() => ignore(req, res), log)) return

      const userAgent = req.headers['user-agent']
      client.apiKey = key
      client.record({
        method: req.method,
        path: req.originalUrl ?? req.url ?? '/',
        route: (route && attempt(() => route(req, res), log)) || routeTemplate(req),
        status: aborted && !res.headersSent ? CLIENT_CLOSED_REQUEST : res.statusCode,
        durationMs,
        startedAt,
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
        consumer: consumer && attempt(() => consumer(req, res), log),
        error: capturedErrors.get(req),
      })
    } catch (error) {
      log?.(`tracking failed: ${describeError(error)}`)
    }
  }

  const middleware = (req: Req, res: Res, next: NextFunctionLike): void => {
    try {
      const startedAt = Date.now()
      const start = performance.now()
      let recorded = false

      const done = (aborted: boolean) => {
        if (recorded) return
        recorded = true
        track(req, res, startedAt, performance.now() - start, aborted)
      }

      res.once('finish', () => done(false))
      res.once('close', () => done(!res.writableFinished))
    } catch (error) {
      log?.(`tracking failed: ${describeError(error)}`)
    }
    next()
  }

  return Object.assign(middleware, { flush: () => client.flush() })
}

/** Error middleware that attaches `err.message` to error samples. Register it after your routes. */
export function totallyticsErrors(): ErrorCaptureMiddleware {
  return function totallyticsErrorCapture(error, req, _res, next) {
    try {
      capturedErrors.set(req, error)
    } catch {
      // Only object requests can carry a captured error
    }
    next(error)
  }
}

function routeTemplate(req: ExpressRequestLike): string | undefined {
  const path = req.route?.path
  if (typeof path !== 'string') return undefined
  const base = req.baseUrl ?? ''
  return base && path === '/' ? base : base + path
}
