import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify'
import { Totallytics } from './core/client'
import { defaultKey, normalizeKey, warnNoKey } from './core/runtime'
import type { SharedOptions } from './core/types'
import { attempt, debugLogger, describeError } from './core/util'

export interface FastifyOptions extends SharedOptions {
  /** Defaults to `process.env.TOTALLYTICS_API_KEY`. */
  apiKey?: string | (() => string | null | undefined)
  /** Opaque consumer id, called once the response has finished. */
  consumer?: (request: FastifyRequest, reply: FastifyReply) => string | null | undefined
  /** Overrides the detected route template. */
  route?: (request: FastifyRequest, reply: FastifyReply) => string | null | undefined
  /** Return true to skip the request. */
  ignore?: (request: FastifyRequest, reply: FastifyReply) => boolean
  /** Flush interval. Default 10000. */
  flushIntervalMs?: number
}

export type TotallyticsPlugin = FastifyPluginCallback & {
  /** Sends everything buffered and waits for in-flight batches. Never rejects. */
  flush(): Promise<void>
}

interface RoutedRequest {
  is404?: boolean
  routeOptions?: { url?: unknown }
  routerPath?: unknown
}

const CATCH_ALL_ROUTE = '/*'
const CLIENT_CLOSED_REQUEST = 499

export function totallytics(options: FastifyOptions = {}): TotallyticsPlugin {
  const { apiKey, consumer, route, ignore, ...config } = options
  const client = new Totallytics({ ...config, integration: 'fastify' })
  const log = debugLogger(config.debug)
  const capturedErrors = new WeakMap<FastifyRequest, unknown>()

  const track = (request: FastifyRequest, reply: FastifyReply, startedAt: number, durationMs: number, aborted: boolean) => {
    try {
      const key = typeof apiKey === 'function' ? normalizeKey(attempt(apiKey, log)) : (normalizeKey(apiKey) ?? defaultKey())
      if (!key) return warnNoKey(config.debug)
      if (ignore && attempt(() => ignore(request, reply), log)) return

      client.apiKey = key
      client.record({
        method: request.method,
        path: request.url,
        route: (route && attempt(() => route(request, reply), log)) || routeTemplate(request) || CATCH_ALL_ROUTE,
        status: aborted && !reply.raw.headersSent ? CLIENT_CLOSED_REQUEST : reply.statusCode,
        durationMs,
        startedAt,
        userAgent: request.headers['user-agent'],
        consumer: consumer && attempt(() => consumer(request, reply), log),
        error: capturedErrors.get(request),
      })
    } catch (error) {
      log?.(`tracking failed: ${describeError(error)}`)
    }
  }

  const plugin: FastifyPluginCallback = (instance, _options, done) => {
    instance.addHook('onRequest', (request, reply, next) => {
      try {
        const startedAt = Date.now()
        const start = performance.now()
        let recorded = false

        const finish = (aborted: boolean) => {
          if (recorded) return
          recorded = true
          track(request, reply, startedAt, performance.now() - start, aborted)
        }

        reply.raw.once('finish', () => finish(false))
        reply.raw.once('close', () => finish(!reply.raw.writableFinished))
      } catch (error) {
        log?.(`tracking failed: ${describeError(error)}`)
      }
      next()
    })

    instance.addHook('onError', (request, _reply, error, next) => {
      capturedErrors.set(request, error)
      next()
    })

    instance.addHook('onClose', (_instance, next) => {
      void client.flush().then(() => next())
    })

    done()
  }

  // The fastify-plugin symbols, so the hooks apply to the parent context instead of an encapsulated one
  return Object.assign(plugin, {
    flush: () => client.flush(),
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'totallytics',
    [Symbol.for('plugin-meta')]: { name: 'totallytics' },
  })
}

// Fastify 4.10+ exposes `routeOptions.url`, older 4.x only the deprecated `routerPath`
function routeTemplate(request: FastifyRequest): string | undefined {
  const routed = request as unknown as RoutedRequest
  if (routed.is404) return undefined
  const url = routed.routeOptions ? routed.routeOptions.url : routed.routerPath
  return typeof url === 'string' && url ? url : undefined
}
