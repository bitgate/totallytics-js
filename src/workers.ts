import { Totallytics } from './core/client'
import { defaultKey, normalizeKey, warnNoKey } from './core/runtime'
import type { SharedOptions, WaitUntil } from './core/types'
import { attempt, debugLogger, describeError } from './core/util'

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

export interface WorkersHandler<Env = any> {
  fetch?(request: Request, env: Env, ctx: ExecutionContextLike): Response | Promise<Response>
}

export interface WorkersOptions<Env = any> extends SharedOptions {
  /** Defaults to `env.TOTALLYTICS_API_KEY`. */
  apiKey?: string | ((env: Env) => string | null | undefined)
  /** Opaque consumer id, called after the response is ready. */
  consumer?: (request: Request, env: Env) => string | null | undefined
  /** Route template. Defaults to the raw path, which the server templates. */
  route?: (request: Request, env: Env) => string | null | undefined
  /** Return true to skip the request. */
  ignore?: (request: Request, env: Env) => boolean
  /** Delay before flushing through `ctx.waitUntil`, max 20000. Default 5000. */
  flushDelayMs?: number
}

type EnvOf<H> = H extends { fetch?: (request: any, env: infer E, ...rest: any[]) => any } ? E : any

export function withTotallytics<H extends WorkersHandler>(handler: H, options: WorkersOptions<EnvOf<H>> = {}): H {
  const original = handler.fetch
  if (typeof original !== 'function') return handler

  const { apiKey, consumer, route, ignore, ...config } = options
  const client = new Totallytics({ ...config, integration: 'workers' })
  const log = debugLogger(config.debug)

  const track = (
    request: Request,
    env: EnvOf<H>,
    ctx: ExecutionContextLike | undefined,
    status: number | undefined,
    startedAt: number,
    durationMs: number,
    error: unknown,
  ) => {
    try {
      const key =
        typeof apiKey === 'function'
          ? normalizeKey(attempt(() => apiKey(env), log))
          : (normalizeKey(apiKey) ?? defaultKey(env))
      if (!key) return warnNoKey(config.debug)
      if (ignore && attempt(() => ignore(request, env), log)) return

      client.apiKey = key
      client.record(
        {
          method: request.method,
          path: request.url,
          route: route && attempt(() => route(request, env), log),
          status: status ?? 0,
          durationMs,
          startedAt,
          userAgent: request.headers.get('User-Agent'),
          consumer: consumer && attempt(() => consumer(request, env), log),
          error,
        },
        waitUntilOf(ctx),
      )
    } catch (trackingError) {
      log?.(`tracking failed: ${describeError(trackingError)}`)
    }
  }

  const fetch = async (request: Request, env: EnvOf<H>, ctx: ExecutionContextLike): Promise<Response> => {
    const startedAt = Date.now()
    const start = performance.now()
    let response: Response

    try {
      response = await original.call(handler, request, env, ctx)
    } catch (error) {
      track(request, env, ctx, 500, startedAt, performance.now() - start, error)
      throw error
    }

    track(request, env, ctx, response?.status, startedAt, performance.now() - start, undefined)
    return response
  }

  return { ...handler, fetch }
}

function waitUntilOf(ctx: ExecutionContextLike | undefined): WaitUntil | undefined {
  return typeof ctx?.waitUntil === 'function' ? (promise) => ctx.waitUntil(promise) : undefined
}
