import { VERSION } from '../version'
import { randomId, sleep, warnOnce } from './runtime'
import type { ErrorRow, IngestPayload, MetricRow } from './types'
import { describeError } from './util'

export const USER_AGENT = `totallytics-js/${VERSION}`

const MAX_ATTEMPTS = 3
const MAX_PENDING = 20
const TIMEOUT_MS = 10_000
const BACKOFF_BASE_MS = 1_000

export interface Batch {
  readonly id: string
  readonly apiKey: string
  readonly body: string
}

interface Delivery {
  readonly batch: Batch
  dropped: boolean
  done: Promise<void>
}

type Outcome = 'done' | 'drop' | 'retry' | 'split'

export function createBatch(apiKey: string, sdk: string | undefined, metrics: MetricRow[], errors: ErrorRow[]): Batch {
  const id = randomId()
  const payload: IngestPayload = { v: 1, batch_id: id, sdk, metrics, errors }
  return { id, apiKey, body: JSON.stringify(payload) }
}

export class Transport {
  private readonly pending: Delivery[] = []

  constructor(
    private readonly endpoint: string,
    private readonly debug: boolean,
  ) {}

  deliver(batch: Batch): Promise<void> {
    const delivery: Delivery = { batch, dropped: false, done: Promise.resolve() }
    this.pending.push(delivery)

    while (this.pending.length > MAX_PENDING) {
      const oldest = this.pending.shift()
      if (!oldest) break
      oldest.dropped = true
      this.log(`dropped batch ${oldest.batch.id}: more than ${MAX_PENDING} batches pending`)
    }

    delivery.done = this.run(delivery)
      .catch((error: unknown) => this.log(`batch ${batch.id} failed: ${describeError(error)}`))
      .finally(() => this.forget(delivery))
    return delivery.done
  }

  settle(): Promise<void> {
    return Promise.all(this.pending.map((delivery) => delivery.done)).then(() => undefined)
  }

  private forget(delivery: Delivery): void {
    const index = this.pending.indexOf(delivery)
    if (index !== -1) this.pending.splice(index, 1)
  }

  // Every attempt sends the same serialized body, so the server can dedup on batch_id
  private async run(delivery: Delivery): Promise<void> {
    const { batch } = delivery
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.send(batch)
      if (delivery.dropped || outcome === 'done' || outcome === 'drop') return
      if (outcome === 'split') return this.split(delivery)
      if (attempt >= MAX_ATTEMPTS) return this.log(`dropped batch ${batch.id} after ${MAX_ATTEMPTS} attempts`)

      await sleep(backoff(attempt))
      if (delivery.dropped) return
    }
  }

  private async split(delivery: Delivery): Promise<void> {
    this.forget(delivery)
    const halves = halve(delivery.batch)
    if (!halves) return this.log(`dropped batch ${delivery.batch.id}: too large and cannot be split`)
    await Promise.all(halves.map((half) => this.deliver(half)))
  }

  private async send(batch: Batch): Promise<Outcome> {
    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${batch.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: batch.body,
        signal: timeoutSignal(),
      })
    } catch (error) {
      this.log(`batch ${batch.id} failed: ${describeError(error)}`)
      return 'retry'
    }

    const { status } = response
    const text = await response.text().catch(() => '')

    if (status >= 200 && status < 300) {
      this.reportRejected(batch, text)
      return 'done'
    }
    if (status === 401) {
      warnOnce('unauthorized', 'ingest rejected the API key (401), analytics are being dropped. Check TOTALLYTICS_API_KEY.')
      return 'drop'
    }
    if (status === 413) return 'split'

    const retry = status === 408 || status === 429 || status >= 500
    this.log(`batch ${batch.id} got HTTP ${status}, ${retry ? 'retrying' : 'dropping'}: ${text.slice(0, 200)}`)
    return retry ? 'retry' : 'drop'
  }

  private reportRejected(batch: Batch, text: string): void {
    if (!this.debug) return
    try {
      const { rejected } = JSON.parse(text) as { rejected?: unknown }
      if (typeof rejected === 'number' && rejected > 0) this.log(`batch ${batch.id}: server rejected ${rejected} rows`)
    } catch {
      // A 2xx without a JSON body still counts as delivered
    }
  }

  private log(message: string): void {
    if (this.debug) console.warn(`[totallytics] ${message}`)
  }
}

function halve(batch: Batch): Batch[] | undefined {
  const { sdk, metrics, errors } = JSON.parse(batch.body) as IngestPayload
  if (metrics.length + errors.length < 2) return undefined

  const metricsCut = Math.ceil(metrics.length / 2)
  const errorsCut = Math.floor(errors.length / 2)
  return [
    createBatch(batch.apiKey, sdk, metrics.slice(0, metricsCut), errors.slice(0, errorsCut)),
    createBatch(batch.apiKey, sdk, metrics.slice(metricsCut), errors.slice(errorsCut)),
  ]
}

function backoff(attempt: number): number {
  const base = BACKOFF_BASE_MS * 2 ** (attempt - 1)
  return base / 2 + Math.random() * base
}

function timeoutSignal(): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined
  return AbortSignal.timeout(TIMEOUT_MS)
}
