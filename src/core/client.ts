import { Aggregator, MAX_KEYS, type Measurement } from './aggregator'
import { defaultKey, flushOnShutdown, normalizeKey, sleep, startInterval, warnNoKey } from './runtime'
import { type Batch, createBatch, Transport, USER_AGENT } from './transport'
import type { RequestEntry, TotallyticsOptions, WaitUntil } from './types'
import { clip, describeError, pathOf } from './util'

export const DEFAULT_ENDPOINT = 'https://totallytics.com/api/ingest'

const MAX_SDK = 64
const MAX_PATH = 512
const MAX_USER_AGENT = 512
const MAX_CONSUMER = 128
const MAX_MESSAGE = 1000
const STALE_FLUSH_MS = 60_000

export class Totallytics {
  apiKey: string | undefined

  private readonly sdk: string
  private readonly debug: boolean
  private readonly maxBatchRows: number
  private readonly flushIntervalMs: number
  private readonly flushDelayMs: number
  private readonly aggregator: Aggregator
  private readonly transport: Transport
  private timer: unknown
  private scheduled: Promise<void> | undefined
  private scheduledAt = 0

  constructor(options: TotallyticsOptions = {}) {
    this.apiKey = normalizeKey(options.apiKey) ?? defaultKey()
    this.sdk = clip(options.integration ? `${USER_AGENT} ${options.integration}` : USER_AGENT, MAX_SDK)
    this.debug = options.debug === true
    this.maxBatchRows = clampInt(options.maxBatchRows, 1, 5_000, 1_000)
    this.flushIntervalMs = clampInt(options.flushIntervalMs, 100, 3_600_000, 10_000)
    this.flushDelayMs = clampInt(options.flushDelayMs, 0, 20_000, 5_000)
    this.aggregator = new Aggregator(options.errorSamples !== false)
    this.transport = new Transport(options.endpoint || DEFAULT_ENDPOINT, this.debug)
  }

  get hasBufferedData(): boolean {
    return this.aggregator.size > 0
  }

  /** Records one finished request. Pass `ctx.waitUntil` on Workers, omit it on long-lived servers. */
  record(entry: RequestEntry, waitUntil?: WaitUntil): void {
    try {
      if (!this.apiKey) return warnNoKey(this.debug)

      const measurement = measure(entry)
      if (!measurement || !this.aggregator.add(measurement)) return

      if (waitUntil) this.scheduleWithWaitUntil(waitUntil)
      else this.scheduleWithTimer()
    } catch (error) {
      this.log(`record failed: ${describeError(error)}`)
    }
  }

  /** Sends everything buffered and waits for in-flight batches. Never rejects. */
  flush(): Promise<void> {
    return this.flushBuffer().then(() => this.transport.settle())
  }

  private flushBuffer(): Promise<void> {
    try {
      const deliveries = this.seal().map((batch) => this.transport.deliver(batch))
      return Promise.all(deliveries).then(() => undefined)
    } catch (error) {
      this.log(`flush failed: ${describeError(error)}`)
      return Promise.resolve()
    }
  }

  private seal(): Batch[] {
    const apiKey = this.apiKey
    if (this.aggregator.size === 0 || !apiKey) return []

    const { metrics, errors } = this.aggregator.drain()
    const batches: Batch[] = []
    for (let start = 0; start < metrics.length; start += this.maxBatchRows) {
      const rows = metrics.slice(start, start + this.maxBatchRows)
      batches.push(createBatch(apiKey, this.sdk, rows, start === 0 ? errors : []))
    }
    return batches
  }

  // Workers: the shared flush is created inside a request that also waitUntil's it
  private scheduleWithWaitUntil(waitUntil: WaitUntil): void {
    const now = Date.now()
    const stale = now - this.scheduledAt > this.flushDelayMs + STALE_FLUSH_MS

    if (this.aggregator.size >= this.maxBatchRows) waitUntil(this.flushBuffer())
    else if (!this.scheduled || stale) {
      const scheduled: Promise<void> = sleep(this.flushDelayMs)
        .then(() => this.flushBuffer())
        .finally(() => {
          if (this.scheduled === scheduled) this.scheduled = undefined
        })
      this.scheduled = scheduled
      this.scheduledAt = now
    }

    if (this.scheduled) waitUntil(this.scheduled)
  }

  private scheduleWithTimer(): void {
    if (this.aggregator.size >= MAX_KEYS) void this.flushBuffer()
    if (this.timer !== undefined) return

    this.timer = startInterval(() => void this.flushBuffer(), this.flushIntervalMs)
    flushOnShutdown(this)
  }

  private log(message: string): void {
    if (this.debug) console.warn(`[totallytics] ${message}`)
  }
}

function measure(entry: RequestEntry): Measurement | undefined {
  const status = Number(entry.status)
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined

  const durationMs = Number.isFinite(entry.durationMs) && entry.durationMs > 0 ? entry.durationMs : 0
  const startedAt = Number(entry.startedAt)
  const path = clip(pathOf(String(entry.path || '/')), MAX_PATH)
  const measurement: Measurement = {
    ts: Math.floor(Number.isFinite(startedAt) ? startedAt : Date.now() - durationMs),
    method: String(entry.method || 'GET').toUpperCase(),
    route: entry.route ? clip(String(entry.route), MAX_PATH) : path,
    path,
    status,
    durationMs,
  }

  if (entry.userAgent) measurement.userAgent = clip(String(entry.userAgent), MAX_USER_AGENT)
  if (entry.consumer != null && entry.consumer !== '') measurement.consumer = clip(String(entry.consumer), MAX_CONSUMER)

  const message = describeError(entry.error)
  if (message) measurement.message = clip(message, MAX_MESSAGE)
  return measurement
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}
