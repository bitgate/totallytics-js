import express, { type NextFunction, type Request, type Response } from 'express'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { totallytics, totallyticsErrors } from '../src/express'
import type { IngestPayload, MetricRow } from '../src/index'
import { KEY, resetSharedState } from './helpers'

resetSharedState()

const received: { authorization?: string; userAgent?: string; payload: IngestPayload }[] = []
let ingest: Server
let api: Server
let apiUrl: string
let tt: ReturnType<typeof totallytics>

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeAll(async () => {
  ingest = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      received.push({
        authorization: req.headers.authorization,
        userAgent: req.headers['user-agent'],
        payload: JSON.parse(body) as IngestPayload,
      })
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: { metrics: 1, errors: 0 }, rejected: 0 }))
    })
  })
  const endpoint = `${await listen(ingest)}/api/ingest`

  tt = totallytics({
    apiKey: KEY,
    endpoint,
    consumer: (req) => req.headers['x-consumer'] as string | undefined,
  })

  const app = express()
  app.use(tt)
  app.get('/users/:id', (req, res) => {
    res.json({ id: req.params.id })
  })
  app.get('/boom', () => {
    throw new Error('kaboom')
  })
  app.get('/slow', (_req, res) => {
    setTimeout(() => res.send('late'), 300)
  })

  const router = express.Router()
  router.get('/', (_req, res) => {
    res.send('index')
  })
  router.get('/posts/:postId', (_req, res) => {
    res.status(201).send('post')
  })
  app.use('/api', router)

  app.use(totallyticsErrors())
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).send('error')
  })

  api = createServer(app)
  apiUrl = await listen(api)
})

afterAll(() => {
  api?.close()
  ingest?.close()
})

function rows(): MetricRow[] {
  return received.flatMap((batch) => batch.payload.metrics)
}

function total(): number {
  return rows().reduce((sum, row) => sum + row.count, 0)
}

describe('express middleware', () => {
  it('records requests over a real http server', async () => {
    const ok = await fetch(`${apiUrl}/users/42?token=secret`, {
      headers: { 'user-agent': 'okhttp/4.12.0', 'x-consumer': 'cust_42' },
    })
    expect(await ok.json()).toEqual({ id: '42' })
    expect((await fetch(`${apiUrl}/api/posts/7`)).status).toBe(201)
    expect((await fetch(`${apiUrl}/api`)).status).toBe(200)
    expect((await fetch(`${apiUrl}/boom`)).status).toBe(500)
    expect((await fetch(`${apiUrl}/missing/123?x=1`)).status).toBe(404)

    const aborted = new AbortController()
    const slow = fetch(`${apiUrl}/slow`, { signal: aborted.signal }).catch(() => undefined)
    setTimeout(() => aborted.abort(), 50)
    await slow

    await vi.waitFor(async () => {
      await tt.flush()
      expect(total()).toBe(6)
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    await tt.flush()
    expect(total()).toBe(6)

    expect(received[0]?.authorization).toBe(`Bearer ${KEY}`)
    expect(received[0]?.userAgent).toBe('totallytics-js/0.1.1')
    expect(received[0]?.payload.sdk).toBe('totallytics-js/0.1.1 express')

    const byRoute = new Map(rows().map((row) => [row.route, row]))
    expect(byRoute.get('/users/:id')).toMatchObject({
      method: 'GET',
      status: 200,
      user_agent: 'okhttp/4.12.0',
      consumer: 'cust_42',
      count: 1,
    })
    expect(byRoute.get('/api/posts/:postId')?.status).toBe(201)
    expect(byRoute.get('/api')?.status).toBe(200)
    expect(byRoute.get('/boom')?.status).toBe(500)
    expect(byRoute.get('/missing/123')?.status).toBe(404)
    expect(byRoute.get('/slow')).toMatchObject({ status: 499, count: 1 })

    const errors = received.flatMap((batch) => batch.payload.errors)
    expect(errors.find((row) => row.status === 500)).toMatchObject({ route: '/boom', path: '/boom', message: 'kaboom' })
    expect(errors.find((row) => row.status === 404)?.path).toBe('/missing/123')
  })
})
