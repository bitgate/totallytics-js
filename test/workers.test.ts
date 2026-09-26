import { describe, expect, it, vi } from 'vitest'
import { type ExecutionContextLike, withTotallytics } from '../src/workers'
import { errorsOf, findRow, KEY, metricsOf, mockIngest, resetSharedState } from './helpers'

resetSharedState()

interface Env {
  TOTALLYTICS_API_KEY?: string
  CUSTOM_KEY?: string
}

const env: Env = { TOTALLYTICS_API_KEY: KEY }

function fakeCtx() {
  const promises: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void promises.push(promise),
    passThroughOnException() {},
  }
  return { ctx, promises }
}

const handler = {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContextLike): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/boom') throw new Error('kaboom')
    return new Response('ok', { status: pathname === '/missing' ? 404 : 200 })
  },
  scheduled: vi.fn(),
}

describe('withTotallytics', () => {
  it('passes other handler keys through untouched', () => {
    const worker = withTotallytics(handler)
    expect(worker.scheduled).toBe(handler.scheduled)
    expect(worker.fetch).not.toBe(handler.fetch)
  })

  it('shares one delayed flush across requests through every ctx.waitUntil', async () => {
    const { calls } = mockIngest()
    const worker = withTotallytics(handler, {
      flushDelayMs: 20,
      consumer: (request) => request.headers.get('x-consumer'),
    })
    const first = fakeCtx()
    const second = fakeCtx()

    const response = await worker.fetch(
      new Request('https://api.example.com/users/1?token=secret', {
        headers: { 'user-agent': 'okhttp/4.12.0', 'x-consumer': 'cust_42' },
      }),
      env,
      first.ctx,
    )
    expect(await response.text()).toBe('ok')
    await worker.fetch(new Request('https://api.example.com/missing'), env, second.ctx)

    expect(first.promises).toHaveLength(1)
    expect(second.promises).toHaveLength(1)
    expect(second.promises[0]).toBe(first.promises[0])
    expect(calls).toHaveLength(0)

    await Promise.all([...first.promises, ...second.promises])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.sdk).toBe('totallytics-js/0.1.0 workers')
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(findRow(calls, '/users/1')).toMatchObject({ status: 200, user_agent: 'okhttp/4.12.0', consumer: 'cust_42' })
    expect(findRow(calls, '/missing')?.status).toBe(404)

    const third = fakeCtx()
    await worker.fetch(new Request('https://api.example.com/users/2'), env, third.ctx)
    expect(third.promises[0]).not.toBe(first.promises[0])
    await Promise.all(third.promises)
    expect(calls).toHaveLength(2)
  })

  it('rethrows handler errors and records them as 500', async () => {
    const { calls } = mockIngest()
    const worker = withTotallytics(handler, { flushDelayMs: 0 })
    const { ctx, promises } = fakeCtx()

    await expect(worker.fetch(new Request('https://api.example.com/boom'), env, ctx)).rejects.toThrow('kaboom')
    await Promise.all(promises)

    expect(findRow(calls, '/boom')?.status).toBe(500)
    expect(errorsOf(calls)[0]).toMatchObject({ status: 500, path: '/boom', message: 'kaboom' })
  })

  it('flushes immediately through waitUntil when the buffer hits maxBatchRows', async () => {
    const { calls } = mockIngest()
    const worker = withTotallytics(handler, { maxBatchRows: 2, flushDelayMs: 20 })
    const first = fakeCtx()
    const second = fakeCtx()

    await worker.fetch(new Request('https://api.example.com/a'), env, first.ctx)
    await worker.fetch(new Request('https://api.example.com/b'), env, second.ctx)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.metrics).toHaveLength(2)
    expect(second.promises).toHaveLength(2)
    await Promise.all([...first.promises, ...second.promises])
    expect(calls).toHaveLength(1)
  })

  it('supports apiKey from env, route and ignore overrides', async () => {
    const { calls } = mockIngest()
    const worker = withTotallytics(handler, {
      apiKey: (bindings) => bindings.CUSTOM_KEY,
      route: (request) => new URL(request.url).pathname.replace(/\/\d+/g, '/:id'),
      ignore: (request) => new URL(request.url).pathname === '/health',
      flushDelayMs: 0,
    })
    const { ctx, promises } = fakeCtx()
    const custom: Env = { CUSTOM_KEY: 'tt_custom' }

    await worker.fetch(new Request('https://api.example.com/users/9'), custom, ctx)
    await worker.fetch(new Request('https://api.example.com/health'), custom, ctx)
    await Promise.all(promises)

    expect(calls[0]?.headers.authorization).toBe('Bearer tt_custom')
    expect(metricsOf(calls).map((row) => row.route)).toEqual(['/users/:id'])
  })

  it('does nothing without a key', async () => {
    const { calls } = mockIngest()
    const worker = withTotallytics(handler, { flushDelayMs: 0 })
    const { ctx, promises } = fakeCtx()

    const response = await worker.fetch(new Request('https://api.example.com/users/1'), {}, ctx)
    expect(response.status).toBe(200)
    expect(promises).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
})
