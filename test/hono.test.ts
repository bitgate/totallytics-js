import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it, vi } from 'vitest'
import { type HonoOptions, totallytics } from '../src/hono'
import { errorsOf, findRow, KEY, metricsOf, mockIngest, resetSharedState } from './helpers'

resetSharedState()

function buildApp(options: HonoOptions = { apiKey: KEY }) {
  const tt = totallytics({ consumer: (c) => c.req.header('x-consumer'), ...options })
  const app = new Hono()
  app.use('*', tt)

  app.use('/api/*', async (c, next) => {
    if (c.req.header('x-deny')) return c.text('denied', 401)
    await next()
  })
  app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }))
  app.post('/boom', () => {
    throw new TypeError('x is undefined')
  })
  app.get('/forbidden', () => {
    throw new HTTPException(403, { message: 'not yours' })
  })
  app.get('/thrown-string', () => {
    throw 'boom'
  })

  const api = new Hono()
  api.get('/posts/:postId', (c) => c.text('post'))
  app.route('/api', api)

  const v1 = new Hono().basePath('/v1')
  v1.get('/items/:itemId', (c) => c.text('item'))
  app.route('/', v1)

  return { app, tt }
}

describe('hono middleware', () => {
  it('records route templates, statuses and error samples', async () => {
    const { calls } = mockIngest()
    const { app, tt } = buildApp()

    const ok = await app.request('/users/42?token=secret', {
      headers: { 'user-agent': 'okhttp/4.12.0', 'x-consumer': 'cust_42' },
    })
    expect(await ok.json()).toEqual({ id: '42' })
    expect((await app.request('/boom', { method: 'POST' })).status).toBe(500)
    expect((await app.request('/forbidden')).status).toBe(403)
    expect((await app.request('/api/posts/7')).status).toBe(200)
    expect((await app.request('/api/posts/8', { headers: { 'x-deny': '1' } })).status).toBe(401)
    expect((await app.request('/v1/items/3')).status).toBe(200)
    expect((await app.request('/nope/123?x=1')).status).toBe(404)
    await tt.flush()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.sdk).toBe('totallytics-js/0.2.0 hono')
    expect(findRow(calls, '/users/:id')).toMatchObject({
      method: 'GET',
      status: 200,
      user_agent: 'okhttp/4.12.0',
      consumer: 'cust_42',
      count: 1,
    })
    expect(findRow(calls, '/boom')).toMatchObject({ method: 'POST', status: 500 })
    expect(findRow(calls, '/forbidden')?.status).toBe(403)
    expect(findRow(calls, '/api/posts/:postId', 200)?.count).toBe(1)
    expect(findRow(calls, '/api/posts/:postId', 401)?.count).toBe(1)
    expect(findRow(calls, '/v1/items/:itemId')?.status).toBe(200)
    expect(findRow(calls, '/*', 404)?.count).toBe(1)
    expect(metricsOf(calls)).toHaveLength(7)

    const errors = errorsOf(calls)
    expect(errors.find((row) => row.status === 500)).toMatchObject({
      route: '/boom',
      path: '/boom',
      message: 'TypeError: x is undefined',
    })
    expect(errors.find((row) => row.status === 403)?.message).toBe('not yours')
    expect(errors.find((row) => row.status === 401)?.path).toBe('/api/posts/8')
  })

  it('reports the wildcard of a catch-all handler, not the raw path', async () => {
    const { calls } = mockIngest()
    const tt = totallytics({
      apiKey: KEY,
      route: (c) => (c.req.path.startsWith('/docs/') ? '/docs/:slug' : undefined),
    })
    const app = new Hono()
    app.use('*', tt)
    app.get('/users/:id', (c) => c.text('user'))
    app.all('/x/*', (c) => c.text('x'))
    app.all('*', (c) => c.text('page'))

    await app.request('/some-slug')
    await app.request('/another/deep/slug?ref=1')
    await app.request('/some-slug', { method: 'POST' })
    await app.request('/x/anything/here')
    await app.request('/users/5')
    await app.request('/docs/hello')
    await tt.flush()

    expect(metricsOf(calls).map((row) => `${row.method} ${row.route} ${row.count}`).sort()).toEqual([
      'GET /* 2',
      'GET /docs/:slug 1',
      'GET /users/:id 1',
      'GET /x/* 1',
      'POST /* 1',
    ])
  })

  it('reports unmatched requests as the middleware wildcard', async () => {
    const { calls } = mockIngest()
    const tt = totallytics({ apiKey: KEY })
    const app = new Hono()
    app.use('*', tt)

    expect((await app.request('/wp-login.php')).status).toBe(404)
    expect((await app.request('/.env?probe=1')).status).toBe(404)
    await tt.flush()

    expect(metricsOf(calls).map((row) => `${row.route} ${row.status} ${row.count}`)).toEqual(['/* 404 2'])
  })

  it('reports a short-circuiting middleware by its wildcard when no route is behind it', async () => {
    const { calls } = mockIngest()
    const { app, tt } = buildApp()

    expect((await app.request('/api/unknown/9', { headers: { 'x-deny': '1' } })).status).toBe(401)
    expect((await app.request('/api/unknown/9')).status).toBe(404)
    expect((await app.request('/api/posts/8', { headers: { 'x-deny': '1' } })).status).toBe(401)
    await tt.flush()

    expect(metricsOf(calls).map((row) => `${row.route} ${row.status}`).sort()).toEqual([
      '/api/* 401',
      '/api/* 404',
      '/api/posts/:postId 401',
    ])
  })

  it('counts a non-Error throw as 500 and rethrows it', async () => {
    const { calls } = mockIngest()
    const { app, tt } = buildApp()
    await expect(app.request('/thrown-string')).rejects.toBe('boom')
    await tt.flush()
    expect(findRow(calls, '/thrown-string')?.status).toBe(500)
    expect(errorsOf(calls)[0]?.message).toBe('boom')
  })

  it('honors route, ignore and consumer overrides without letting them throw', async () => {
    const { calls } = mockIngest()
    const { app, tt } = buildApp({
      apiKey: KEY,
      route: (c) => (c.req.path.startsWith('/users/') ? '/people/:id' : undefined),
      ignore: (c) => c.req.path.startsWith('/v1/'),
      consumer: () => {
        throw new Error('consumer lookup failed')
      },
    })
    await app.request('/users/1')
    await app.request('/v1/items/1')
    await app.request('/api/posts/1')
    await tt.flush()

    expect(metricsOf(calls).map((row) => row.route).sort()).toEqual(['/api/posts/:postId', '/people/:id'])
    expect(metricsOf(calls).every((row) => row.consumer === undefined)).toBe(true)
  })

  it('uses c.env and executionCtx.waitUntil on Workers', async () => {
    const { calls } = mockIngest()
    const { app } = buildApp({ flushDelayMs: 0 })
    const waited: Promise<unknown>[] = []
    const executionCtx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise), passThroughOnException() {}, props: {} }
    const env = { TOTALLYTICS_API_KEY: KEY }

    await app.request('/users/1', {}, env, executionCtx)
    await app.request('/users/2', {}, env, executionCtx)
    expect(waited).toHaveLength(2)
    expect(waited[0]).toBe(waited[1])
    expect(calls).toHaveLength(0)

    await Promise.all(waited)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(findRow(calls, '/users/:id')?.count).toBe(2)
  })

  it('is a no-op without a key', async () => {
    vi.stubEnv('TOTALLYTICS_API_KEY', '')
    const { calls } = mockIngest()
    const { app, tt } = buildApp({})
    expect((await app.request('/users/1')).status).toBe(200)
    await tt.flush()
    expect(calls).toHaveLength(0)
  })
})
