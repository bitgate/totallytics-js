import { bucket } from './histogram'
import type { ErrorRow, MetricRow } from './types'

export const MAX_KEYS = 10_000
export const MAX_SERVER_ERROR_SAMPLES = 50
export const MAX_CLIENT_ERROR_SAMPLES = 20

export interface Measurement {
  ts: number
  method: string
  route: string
  path: string
  status: number
  durationMs: number
  userAgent?: string
  consumer?: string
  message?: string
}

export class Aggregator {
  private rows = new Map<string, MetricRow>()
  private serverErrors: ErrorRow[] = []
  private clientErrors: ErrorRow[] = []

  constructor(private readonly sampleErrors: boolean) {}

  get size(): number {
    return this.rows.size
  }

  add(measurement: Measurement): boolean {
    const { ts, method, route, status, durationMs, userAgent, consumer } = measurement
    const minute = Math.floor(ts / 60_000) * 60
    const key = `${minute}\u0000${method}\u0000${route}\u0000${status}\u0000${userAgent ?? ''}\u0000${consumer ?? ''}`

    let row = this.rows.get(key)
    if (!row) {
      if (this.rows.size >= MAX_KEYS) return false
      row = { minute, method, route, status, count: 0, duration_ms_sum: 0, histogram: {} }
      if (userAgent) row.user_agent = userAgent
      if (consumer) row.consumer = consumer
      this.rows.set(key, row)
    }

    const index = bucket(durationMs)
    row.count += 1
    row.duration_ms_sum += durationMs
    row.histogram[index] = (row.histogram[index] ?? 0) + 1

    if (this.sampleErrors && status >= 400) this.sample(measurement)
    return true
  }

  drain(): { metrics: MetricRow[]; errors: ErrorRow[] } {
    const metrics = [...this.rows.values()]
    for (const row of metrics) row.duration_ms_sum = round(row.duration_ms_sum)
    const errors = [...this.serverErrors, ...this.clientErrors]

    this.rows = new Map()
    this.serverErrors = []
    this.clientErrors = []
    return { metrics, errors }
  }

  private sample(measurement: Measurement): void {
    const serverError = measurement.status >= 500
    const samples = serverError ? this.serverErrors : this.clientErrors
    if (samples.length >= (serverError ? MAX_SERVER_ERROR_SAMPLES : MAX_CLIENT_ERROR_SAMPLES)) return

    const { ts, method, route, path, status, durationMs, userAgent, consumer, message } = measurement
    const row: ErrorRow = { ts, method, route, path, status, duration_ms: round(durationMs) }
    if (userAgent) row.user_agent = userAgent
    if (consumer) row.consumer = consumer
    if (message) row.message = message
    samples.push(row)
  }
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000
}
