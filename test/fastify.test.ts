import fastify5 from 'fastify'
import fastify4 from 'fastify4'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { type FastifyOptions, totallytics } from '../src/fastify'
import { errorsOf, findRow, KEY, metricsOf, mockIngest, resetSharedState, warnSpy, warnings } from './helpers'

resetSharedState()

type Factory = typeof fastify5

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function buildApp(factory: Factory, options: FastifyOptions = { apiKey: KEY }) {
  const tt = totallytics({ consumer: (request) => request.headers['x-consumer'] as string | undefined, ...options })
  const app = factory()
  const handledErrors: string[] = []
  app.register(tt)

  app.get('/users/:id', async (request) => ({ id: (request.params as { id: string }).id }))
  app.get('/files/*', async () => 'file')
  app.post('/boom', async () => {
    throw new TypeError('x is undefined')
  })
  app.get('/forbidden', async () => {
    throw Object.assign(new Error('not yours'), { statusCode: 403 })
  })
  app.register(
    async (api) => {
      api.get('/posts/:postId', async () => 'post')
    },
    { prefix: '/api' },
  )
  app.setErrorHandler((error: Error, _request, reply) => {
    handledErrors.push(error.message)
    void reply.send(error)
  })

  return { app, tt, handledErrors }
}

describe.each([
  ['fastify 4', fastify4 as unknown as Factory],
  ['fastify 5', fastify5],
])('%s plugin', (_name, factory) => {
  it('records route templates, statuses and error samples', async () => {
    const { calls } = mockIngest()
    const { app, tt, handledErrors } = buildApp(factory)

    const ok = await app.inject({
      url: '/users/42?token=secret',
      headers: { 'user-agent': 'okhttp/4.12.0', 'x-consumer': 'cust_42' },
    })
    expect(ok.json()).toEqual({ id: '42' })
    expect((await app.inject({ method: 'POST', url: '/boom' })).statusCode).toBe(500)
    expect((await app.inject('/forbidden')).statusCode).toBe(403)
    expect((await app.inject('/api/posts/7')).statusCode).toBe(200)
    expect((await app.inject('/files/a/b.txt')).statusCode).toBe(200)
    expect((await app.inject('/nope/123?x=1')).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: '/users/1' })).statusCode).toBe(404)
    await tt.flush()

    expect(handledErrors).toEqual(['x is undefined', 'not yours'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.sdk).toBe('totallytics-js/0.2.0 fastify')
    expect(findRow(calls, '/users/:id')).toMatchObject({
      method: 'GET',
      status: 200,
      user_agent: 'okhttp/4.12.0',
      consumer: 'cust_42',
      count: 1,
    })
    expect(findRow(calls, '/boom')).toMatchObject({ method: 'POST', status: 500 })
    expect(findRow(calls, '/forbidden')?.status).toBe(403)
    expect(findRow(calls, '/api/posts/:postId')?.status).toBe(200)
    expect(findRow(calls, '/files/*')?.status).toBe(200)
    expect(
      metricsOf(calls)
        .filter((row) => row.route === '/*')
        .map((row) => `${row.method} ${row.status}`)
        .sort(),
    ).toEqual(['GET 404', 'PATCH 404'])
    expect(metricsOf(calls)).toHaveLength(7)

    const errors = errorsOf(calls)
    expect(errors.find((row) => row.status === 500)).toMatchObject({
      route: '/boom',
      path: '/boom',
      message: 'TypeError: x is undefined',
    })
    expect(errors.find((row) => row.status === 403)?.message).toBe('not yours')
    expect(
      errors
        .filter((row) => row.status === 404)
        .map((row) => row.path)
        .sort(),
    ).toEqual(['/nope/123', '/users/1'])
  })

  it('honors route, ignore and consumer overrides without letting them throw', async () => {
    const { calls } = mockIngest()
    const { app, tt } = buildApp(factory, {
      apiKey: () => KEY,
      route: (request) => (request.url.startsWith('/users/') ? '/people/:id' : undefined),
      ignore: (request) => request.url.startsWith('/files/'),
      consumer: () => {
        throw new Error('consumer lookup failed')
      },
    })
    await app.inject('/users/1')
    await app.inject('/files/a')
    await app.inject('/api/posts/1')
    await tt.flush()

    expect(metricsOf(calls).map((row) => row.route).sort()).toEqual(['/api/posts/:postId', '/people/:id'])
    expect(metricsOf(calls).every((row) => row.consumer === undefined)).toBe(true)
  })

  it('flushes when the app closes', async () => {
    const { calls } = mockIngest()
    const { app } = buildApp(factory)
    await app.inject('/users/1')
    await app.inject('/users/2')
    expect(calls).toHaveLength(0)

    await app.close()
    expect(calls).toHaveLength(1)
    expect(findRow(calls, '/users/:id')?.count).toBe(2)
  })

  it('records a request the client aborted as 499', async () => {
    const { calls } = mockIngest()
    const tt = totallytics({ apiKey: KEY })
    const app = factory()
    app.register(tt)
    app.get('/slow', async () => {
      await sleep(300)
      return 'late'
    })
    await app.listen({ port: 0, host: '127.0.0.1' })

    const { port } = app.server.address() as AddressInfo
    const request = httpRequest({ host: '127.0.0.1', port, path: '/slow' })
    request.on('error', () => undefined)
    request.end()
    await sleep(50)
    request.destroy()

    await vi.waitFor(async () => {
      await tt.flush()
      expect(findRow(calls, '/slow')).toMatchObject({ status: 499, count: 1 })
    })
    await sleep(400)
    await app.close()
    expect(metricsOf(calls)).toHaveLength(1)
  })

  it('is a no-op without a key', async () => {
    vi.stubEnv('TOTALLYTICS_API_KEY', '')
    const spy = warnSpy()
    const { calls } = mockIngest()
    const { app, tt } = buildApp(factory, { debug: true })
    expect((await app.inject('/users/1')).statusCode).toBe(200)
    expect((await app.inject('/users/2')).statusCode).toBe(200)
    await tt.flush()

    expect(calls).toHaveLength(0)
    expect(warnings(spy).filter((message) => message.includes('TOTALLYTICS_API_KEY'))).toHaveLength(1)
  })
})
