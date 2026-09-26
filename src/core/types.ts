export interface MetricRow {
  minute: number
  method: string
  route: string
  status: number
  user_agent?: string
  consumer?: string
  count: number
  duration_ms_sum: number
  histogram: Record<string, number>
}

export interface ErrorRow {
  ts: number
  method: string
  route: string
  path: string
  status: number
  duration_ms: number
  user_agent?: string
  consumer?: string
  message?: string
}

export interface IngestPayload {
  v: 1
  batch_id: string
  sdk?: string
  metrics: MetricRow[]
  errors: ErrorRow[]
}

export interface RequestEntry {
  method: string
  /** Raw request path or URL. The query string is stripped. */
  path: string
  /** Route template such as `/users/:id`. Falls back to `path`. */
  route?: string | null
  status: number
  durationMs: number
  /** Request start in unix milliseconds. Defaults to now minus `durationMs`. */
  startedAt?: number
  userAgent?: string | null
  consumer?: string | null
  /** Thrown error or message, attached to 4xx/5xx samples. */
  error?: unknown
}

export type WaitUntil = (promise: Promise<unknown>) => void

export interface SharedOptions {
  /** Ingest URL. Default `https://totallytics.com/api/ingest`. */
  endpoint?: string
  /** Max metric rows per batch, 1 to 5000. Default 1000. */
  maxBatchRows?: number
  /** Send individually sampled 4xx/5xx requests. Default true. */
  errorSamples?: boolean
  /** Log diagnostics with console.warn. Default false. */
  debug?: boolean
}

export interface TotallyticsOptions extends SharedOptions {
  apiKey?: string
  /** Flush interval when running without waitUntil (Node, Bun, Deno). Default 10000. */
  flushIntervalMs?: number
  /** Delay before a waitUntil flush (Workers), max 20000. Default 5000. */
  flushDelayMs?: number
  /** Appended to the `sdk` field, e.g. `fastify`. */
  integration?: string
}
