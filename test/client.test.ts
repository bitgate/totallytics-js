import { describe, expect, it, vi } from 'vitest'
import { bucket, DEFAULT_ENDPOINT, type RequestEntry, Totallytics } from '../src/index'
import {
  accepted,
  findRow,
  KEY,
  metricsOf,
  MINUTE,
  mockIngest,
  resetSharedState,
  warnings,
  warnSpy,
} from './helpers'

resetSharedState()

function entry(overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    method: 'get',
    path: '/users/1?token=secret',
    route: '/users/:id',
    status: 200,
    durationMs: 10,
    startedAt: MINUTE + 5_000,
    userAgent: 'okhttp/4.12.0',
    consumer: 'cust_42',
    ...overrides,
  }
}

describe('payload', () => {
  it('sends the wire format with auth, content type and user agent', async () => {
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY, integration: 'test' })
    client.record(entry())
    await client.flush()

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe(DEFAULT_ENDPOINT)
    expect(call?.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      'user-agent': 'totallytics-js/0.1.0',
    })
    expect(call?.payload).toEqual({
      v: 1,
      batch_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/),
      sdk: 'totallytics-js/0.1.0 test',
      metrics: [
        {
          minute: MINUTE / 1000,
          method: 'GET',
          route: '/users/:id',
          status: 200,
          user_agent: 'okhttp/4.12.0',
          consumer: 'cust_42',
          count: 1,
          duration_ms_sum: 10,
          histogram: { [bucket(10)]: 1 },
        },
      ],
      errors: [],
    })
  })

  it('reads TOTALLYTICS_API_KEY from process.env by default', async () => {
    vi.stubEnv('TOTALLYTICS_API_KEY', KEY)
    const { calls } = mockIngest()
    const client = new Totallytics()
    client.record(entry())
    await client.flush()
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('is a silent no-op without a key', async () => {
    vi.stubEnv('TOTALLYTICS_API_KEY', '')
    const warn = warnSpy()
    const { calls } = mockIngest()
    const client = new Totallytics()
    client.record(entry())
    await client.flush()
    expect(calls).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('aggregation', () => {
  it('aggregates by minute, method, route, status, user agent and consumer', async () => {
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY })

    client.record(entry({ durationMs: 0.5 }))
    client.record(entry({ durationMs: 12, startedAt: MINUTE + 59_999 }))
    client.record(entry({ startedAt: MINUTE + 60_000 }))
    client.record(entry({ method: 'POST' }))
    client.record(entry({ route: '/teams/:id' }))
    client.record(entry({ status: 201 }))
    client.record(entry({ userAgent: 'curl/8.9.1' }))
    client.record(entry({ consumer: 'cust_7' }))
    client.record(entry({ userAgent: null, consumer: undefined }))
    await client.flush()

    const metrics = metricsOf(calls)
    expect(metrics).toHaveLength(8)
    expect(metrics[0]).toEqual({
      minute: MINUTE / 1000,
      method: 'GET',
      route: '/users/:id',
      status: 200,
      user_agent: 'okhttp/4.12.0',
      consumer: 'cust_42',
      count: 2,
      duration_ms_sum: 12.5,
      histogram: { 0: 1, [bucket(12)]: 1 },
    })
    expect(metrics.find((row) => row.minute === MINUTE / 1000 + 60)?.count).toBe(1)
    expect(metrics.at(-1)).not.toHaveProperty('user_agent')
    expect(metrics.at(-1)).not.toHaveProperty('consumer')

    for (const row of metrics) {
      const histogramTotal = Object.values(row.histogram).reduce((sum, count) => sum + count, 0)
      expect(histogramTotal).toBe(row.count)
    }
  })

  it('falls back to the raw path without query string and truncates long fields', async () => {
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY })
    client.record(
      entry({
        path: 'https://api.example.com/orders/9?card=4111#frag',
        route: null,
        status: 500,
        userAgent: 'u'.repeat(600),
        consumer: 'c'.repeat(200),
        error: new TypeError('m'.repeat(1_200)),
      }),
    )
    await client.flush()

    const [row] = metricsOf(calls)
    expect(row?.route).toBe('/orders/9')
    expect(row?.user_agent).toHaveLength(512)
    expect(row?.consumer).toHaveLength(128)

    const [sample] = calls[0]?.payload.errors ?? []
    expect(sample?.path).toBe('/orders/9')
    expect(sample?.message).toHaveLength(1_000)
    expect(sample?.message?.startsWith('TypeError: mmm')).toBe(true)
  })

  it('ignores entries with an invalid status and survives garbage input', async () => {
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY })
    client.record(entry({ status: 0 }))
    client.record(entry({ status: 600 }))
    client.record(entry({ durationMs: Number.NaN, route: '/nan' }))
    client.record(null as unknown as RequestEntry)
    await client.flush()

    expect(metricsOf(calls)).toHaveLength(1)
    expect(findRow(calls, '/nan')).toMatchObject({ duration_ms_sum: 0, histogram: { 0: 1 } })
  })

  it('splits the buffer into batches of at most maxBatchRows', async () => {
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY, maxBatchRows: 1_000 })
    for (let i = 0; i < 2_500; i++) client.record(entry({ route: `/r/${i}`, status: i === 0 ? 500 : 200 }))
    await client.flush()

    expect(calls.map((call) => call.payload.metrics.length)).toEqual([1_000, 1_000, 500])
    expect(calls.map((call) => call.payload.errors.length)).toEqual([1, 0, 0])
    expect(new Set(calls.map((call) => call.payload.batch_id)).size).toBe(3)
  })

  it('flushes early when the buffer reaches 10k distinct keys', () => {
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY })
    for (let i = 0; i < 10_000; i++) client.record(entry({ route: `/r/${i}` }))
    expect(calls).toHaveLength(10)
  })

  it('flushes on an interval without waitUntil', async () => {
    vi.useFakeTimers()
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY, flushIntervalMs: 1_000 })
    client.record(entry())
    expect(calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toHaveLength(1)
  })
})

describe('error samples', () => {
  it('caps samples per flush at 50 for 5xx and 20 for 4xx', async () => {
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY })
    for (let i = 0; i < 80; i++) client.record(entry({ status: 503, error: new Error('upstream down') }))
    for (let i = 0; i < 40; i++) client.record(entry({ status: 404 }))
    for (let i = 0; i < 10; i++) client.record(entry({ status: 200 }))
    await client.flush()

    const { errors } = calls[0]?.payload ?? { errors: [] }
    expect(errors.filter((row) => row.status >= 500)).toHaveLength(50)
    expect(errors.filter((row) => row.status < 500)).toHaveLength(20)
    expect(findRow(calls, '/users/:id', 503)?.count).toBe(80)
    expect(errors[0]).toEqual({
      ts: MINUTE + 5_000,
      method: 'GET',
      route: '/users/:id',
      path: '/users/1',
      status: 503,
      duration_ms: 10,
      user_agent: 'okhttp/4.12.0',
      consumer: 'cust_42',
      message: 'upstream down',
    })

    client.record(entry({ status: 500 }))
    await client.flush()
    expect(calls[1]?.payload.errors).toHaveLength(1)
  })

  it('sends no samples when errorSamples is false', async () => {
    const { calls } = mockIngest()
    const client = new Totallytics({ apiKey: KEY, errorSamples: false })
    client.record(entry({ status: 500 }))
    await client.flush()
    expect(calls[0]?.payload.errors).toEqual([])
    expect(calls[0]?.payload.metrics).toHaveLength(1)
  })
})

describe('delivery', () => {
  it('retries with the byte-identical payload and never merges new data into it', async () => {
    vi.useFakeTimers()
    const { calls } = mockIngest((_call, index) => {
      if (index === 0) return new Response('busy', { status: 503 })
      if (index === 1) throw new TypeError('fetch failed')
      return accepted()
    })
    const client = new Totallytics({ apiKey: KEY })

    client.record(entry())
    const flushed = client.flush()
    await vi.advanceTimersByTimeAsync(0)
    client.record(entry({ route: '/late' }))
    await vi.advanceTimersByTimeAsync(10_000)
    await flushed
    await client.flush()

    expect(calls).toHaveLength(4)
    expect(calls[1]?.raw).toBe(calls[0]?.raw)
    expect(calls[2]?.raw).toBe(calls[0]?.raw)
    expect(calls[0]?.payload.metrics.map((row) => row.route)).toEqual(['/users/:id'])
    expect(calls[3]?.payload.metrics.map((row) => row.route)).toEqual(['/late'])
    expect(calls[3]?.payload.batch_id).not.toBe(calls[0]?.payload.batch_id)
  })

  it.each([408, 429, 500, 503])('retries HTTP %i up to 3 attempts', async (status) => {
    vi.useFakeTimers()
    const { calls } = mockIngest(() => new Response('', { status }))
    const client = new Totallytics({ apiKey: KEY })
    client.record(entry())
    const flushed = client.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    await flushed

    expect(calls).toHaveLength(3)
    expect(new Set(calls.map((call) => call.raw)).size).toBe(1)
  })

  it('drops a 400 without retrying', async () => {
    vi.useFakeTimers()
    const { calls } = mockIngest(() => new Response('{"error":"invalid"}', { status: 400 }))
    const client = new Totallytics({ apiKey: KEY })
    client.record(entry())
    const flushed = client.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    await flushed
    expect(calls).toHaveLength(1)
  })

  it('drops a 401 without retrying and warns once per process', async () => {
    vi.useFakeTimers()
    const warn = warnSpy()
    const { calls } = mockIngest(() => new Response('', { status: 401 }))
    const first = new Totallytics({ apiKey: KEY })
    const second = new Totallytics({ apiKey: KEY })

    for (const client of [first, second, first]) {
      client.record(entry())
      const flushed = client.flush()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushed
    }

    expect(calls).toHaveLength(3)
    expect(warnings(warn).filter((message) => message.includes('401'))).toHaveLength(1)
  })

  it('splits a 413 in half until it fits, with fresh batch ids', async () => {
    const { calls } = mockIngest((call) =>
      call.payload.metrics.length + call.payload.errors.length > 2 ? new Response('', { status: 413 }) : accepted(),
    )
    const client = new Totallytics({ apiKey: KEY })
    const routes = Array.from({ length: 7 }, (_, i) => `/r/${i}`)
    for (const route of routes) client.record(entry({ route }))
    await client.flush()

    const delivered = calls.filter((call) => call.payload.metrics.length + call.payload.errors.length <= 2)
    expect(metricsOf(delivered).map((row) => row.route).sort()).toEqual([...routes].sort())
    expect(new Set(calls.map((call) => call.payload.batch_id)).size).toBe(calls.length)
    expect(calls.length).toBeGreaterThan(delivered.length)
  })

  it('caps pending batches at 20 and drops the oldest', async () => {
    vi.useFakeTimers()
    const warn = warnSpy()
    const { calls } = mockIngest(() => new Response('', { status: 503 }))
    const client = new Totallytics({ apiKey: KEY, debug: true })

    const flushes: Promise<void>[] = []
    for (let i = 0; i < 21; i++) {
      client.record(entry({ route: `/r/${i}` }))
      flushes.push(client.flush())
    }
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all(flushes)

    expect(calls).toHaveLength(1 + 20 * 3)
    expect(warnings(warn).some((message) => message.includes('more than 20 batches pending'))).toBe(true)
  })
})
