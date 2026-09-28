import { notFound, redirect } from 'next/navigation.js'
import { NextRequest } from 'next/server.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type NextOptions, type RouteContext, withTotallytics } from '../src/next'
import { errorsOf, findRow, KEY, metricsOf, mockIngest, resetSharedState } from './helpers'

const { after } = vi.hoisted(() => ({ after: vi.fn() }))
vi.mock('next/server.js', async (importOriginal) => ({ ...(await importOriginal<object>()), after }))

resetSharedState()

let tasks: (() => Promise<void>)[] = []

beforeEach(() => {
  tasks = []
  after.mockReset()
  after.mockImplementation((task: () => Promise<void>) => void tasks.push(task))
})

async function runAfterTasks(): Promise<void> {
  const pending = tasks
  tasks = []
  await Promise.all(pending.map((task) => task()))
}

function request(path: string, init: { method?: string; userAgent?: string; basePath?: string } = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers: init.userAgent ? { 'user-agent': init.userAgent } : undefined,
    nextConfig: init.basePath ? { basePath: init.basePath } : undefined,
  })
}

type Handler = (request: Request, context: RouteContext) => Promise<Response>

const ok: Handler = async () => Response.json({ ok: true })

describe('next route handler wrapper', () => {
  it('derives route templates from params after the response', async () => {
    const { calls } = mockIngest()
    const GET = withTotallytics(ok, { apiKey: KEY, flushDelayMs: 0 })
    const cases: [string, RouteContext['params']][] = [
      ['/users/42', Promise.resolve({ id: '42' })],
      ['/users/43', { id: '43' }],
      ['/files/a/b.txt', Promise.resolve({ path: ['a', 'b.txt'] })],
      ['/orgs/acme/repos/api/issues/7', Promise.resolve({ org: 'acme', repo: 'api', number: '7' })],
      ['/tags/c%23', Promise.resolve({ tag: 'c#' })],
      ['/users/users', Promise.resolve({ id: 'users' })],
      ['/docs', Promise.resolve({ slug: undefined })],
      ['/shop/shoes/nike/air/', Promise.resolve({ category: 'shoes', rest: ['nike', 'air'] })],
      ['/health', Promise.resolve({})],
    ]

    for (const [path, params] of cases) {
      expect((await GET(request(path, { userAgent: 'okhttp/4.12.0' }), { params })).status).toBe(200)
    }
    expect(after).toHaveBeenCalledTimes(cases.length)
    expect(calls).toHaveLength(0)

    await runAfterTasks()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.sdk).toBe('totallytics-js/0.2.0 next')
    expect(findRow(calls, '/users/:id')).toMatchObject({ method: 'GET', status: 200, user_agent: 'okhttp/4.12.0', count: 3 })
    expect(metricsOf(calls).map((row) => row.route).sort()).toEqual([
      '/docs',
      '/files/*',
      '/health',
      '/orgs/:org/repos/:repo/issues/:number',
      '/shop/:category/*/',
      '/tags/:tag',
      '/users/:id',
    ])
  })

  it('keeps the basePath in paths and templates', async () => {
    const { calls } = mockIngest()
    const GET = withTotallytics(
      async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) =>
        Response.json({ id: (await params).id, path: req.nextUrl.pathname }),
      { apiKey: KEY, flushDelayMs: 0 },
    )
    const response = await GET(request('/app/users/42', { basePath: '/app' }), { params: Promise.resolve({ id: '42' }) })
    expect(await response.json()).toEqual({ id: '42', path: '/users/42' })
    await runAfterTasks()

    expect(findRow(calls, '/app/users/:id')?.count).toBe(1)
    expect(errorsOf(calls)).toHaveLength(0)
  })

  it('records thrown errors as 500 and rethrows them', async () => {
    const { calls } = mockIngest()
    const options: NextOptions = { apiKey: KEY, flushDelayMs: 0 }
    const POST = withTotallytics<Handler>(async () => {
      throw new TypeError('x is undefined')
    }, options)
    const PUT = withTotallytics<Handler>(async () => {
      throw 'boom'
    }, options)

    await expect(POST(request('/boom', { method: 'POST' }), {})).rejects.toThrow('x is undefined')
    await expect(PUT(request('/boom', { method: 'PUT' }), {})).rejects.toBe('boom')
    await runAfterTasks()

    expect(findRow(calls, '/boom')).toMatchObject({ method: 'POST', status: 500 })
    expect(
      errorsOf(calls)
        .map((row) => row.message)
        .sort(),
    ).toEqual(['TypeError: x is undefined', 'boom'])
  })

  it('records redirect() and notFound() with the status Next responds with', async () => {
    const { calls } = mockIngest()
    const options: NextOptions = { apiKey: KEY, flushDelayMs: 0 }
    const toLogin = withTotallytics<Handler>(async () => redirect('/login'), options)
    const missing = withTotallytics<Handler>(async () => notFound(), options)

    await expect(toLogin(request('/account'), {})).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;/) })
    await expect(missing(request('/posts/9'), { params: Promise.resolve({ id: '9' }) })).rejects.toBeDefined()
    await runAfterTasks()

    expect(findRow(calls, '/account')?.status).toBe(307)
    expect(findRow(calls, '/posts/:id')?.status).toBe(404)
    expect(errorsOf(calls).every((row) => !row.message)).toBe(true)
  })

  it('skips Next control flow errors and records a missing Response as 500', async () => {
    const { calls } = mockIngest()
    const options: NextOptions = { apiKey: KEY, flushDelayMs: 0 }
    const dynamic = Object.assign(new Error('Dynamic server usage'), { digest: 'DYNAMIC_SERVER_USAGE' })
    const bailout = withTotallytics<Handler>(async () => {
      throw dynamic
    }, options)
    const empty = withTotallytics<Handler>(async () => undefined as unknown as Response, options)

    await expect(bailout(request('/static'), {})).rejects.toBe(dynamic)
    await empty(request('/empty'), {})
    await runAfterTasks()

    expect(metricsOf(calls).map((row) => `${row.route} ${row.status}`)).toEqual(['/empty 500'])
  })

  it('honors route, ignore and consumer overrides without letting them throw', async () => {
    const { calls } = mockIngest()
    const base: NextOptions = { apiKey: KEY, flushDelayMs: 0 }
    const fixed = withTotallytics(ok, { ...base, route: '/people/:id' })
    const computed = withTotallytics(ok, { ...base, route: (req) => (req.method === 'POST' ? '/imports' : undefined) })
    const ignored = withTotallytics(ok, { ...base, ignore: () => true })
    const failing = withTotallytics(ok, {
      ...base,
      consumer: () => {
        throw new Error('consumer lookup failed')
      },
    })

    await fixed(request('/users/1'), { params: Promise.resolve({ id: '1' }) })
    await computed(request('/imports/9', { method: 'POST' }), { params: Promise.resolve({ id: '9' }) })
    await ignored(request('/internal'), {})
    await failing(request('/orders/5'), { params: Promise.resolve({ id: '5' }) })
    await runAfterTasks()

    expect(metricsOf(calls).map((row) => row.route).sort()).toEqual(['/imports', '/orders/:id', '/people/:id'])
    expect(metricsOf(calls).every((row) => row.consumer === undefined)).toBe(true)
  })

  it('flushes right away when idle and at most once per gap under load', async () => {
    const { calls } = mockIngest()
    const GET = withTotallytics(ok, { apiKey: KEY, flushDelayMs: 300 })

    await GET(request('/a'), {})
    await runAfterTasks()
    expect(calls).toHaveLength(1)

    await GET(request('/b'), {})
    await GET(request('/c'), {})
    const started = Date.now()
    const flushed = runAfterTasks()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toHaveLength(1)

    await flushed
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.payload.metrics.map((row) => row.route).sort()).toEqual(['/b', '/c'])
  })

  it('shares one client between wrappers with the same options', async () => {
    const { calls } = mockIngest()
    const users = withTotallytics(ok, { apiKey: KEY, flushDelayMs: 5 })
    const posts = withTotallytics(ok, { apiKey: KEY, flushDelayMs: 5 })

    await users(request('/users/1'), { params: Promise.resolve({ id: '1' }) })
    await posts(request('/posts/1'), { params: Promise.resolve({ id: '1' }) })
    await runAfterTasks()

    expect(calls).toHaveLength(1)
    expect(metricsOf(calls)).toHaveLength(2)
  })

  it('does not track during next build', async () => {
    vi.stubEnv('NEXT_PHASE', 'phase-production-build')
    const { calls } = mockIngest()
    const GET = withTotallytics(ok, { apiKey: KEY, flushDelayMs: 0 })

    expect((await GET(request('/sitemap'), {})).status).toBe(200)
    expect(after).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('records nothing when reading the request throws during static generation', async () => {
    const { calls } = mockIngest()
    const GET = withTotallytics(ok, { apiKey: KEY, flushDelayMs: 0 })
    const prerendering = new Proxy(request('/feed'), {
      get(target, property) {
        if (property === 'headers') throw Object.assign(new Error('Dynamic server usage'), { digest: 'DYNAMIC_SERVER_USAGE' })
        return Reflect.get(target, property, target)
      },
    })

    expect((await GET(prerendering, {})).status).toBe(200)
    await runAfterTasks()
    expect(calls).toHaveLength(0)
  })

  it('falls back to a background flush when after() is unavailable', async () => {
    after.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope.')
    })
    const { calls } = mockIngest()
    const GET = withTotallytics(ok, { apiKey: KEY, flushDelayMs: 0 })
    const waited: Promise<unknown>[] = []
    const vercel = Symbol.for('@vercel/request-context')
    const scope = globalThis as Record<symbol, unknown>
    scope[vercel] = { get: () => ({ waitUntil: (promise: Promise<unknown>) => void waited.push(promise) }) }

    try {
      await GET(request('/users/1', { userAgent: 'okhttp/4.12.0' }), { params: { id: '1' } })
      expect(waited).toHaveLength(1)
      await Promise.all(waited)
      expect(findRow(calls, '/users/:id')?.count).toBe(1)
      expect(findRow(calls, '/users/:id')?.user_agent).toBeUndefined()
    } finally {
      delete scope[vercel]
    }

    await GET(request('/users/2', { method: 'POST', userAgent: 'okhttp/4.12.0' }), { params: { id: '2' } })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]?.payload.metrics[0]).toMatchObject({ method: 'POST', route: '/users/:id', user_agent: 'okhttp/4.12.0' })
  })

  it('is a no-op without a key', async () => {
    vi.stubEnv('TOTALLYTICS_API_KEY', '')
    const { calls } = mockIngest()
    const GET = withTotallytics(ok)
    expect((await GET(request('/users/1'), {})).status).toBe(200)
    await runAfterTasks()
    expect(calls).toHaveLength(0)
  })
})
