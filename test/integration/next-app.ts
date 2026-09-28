import { type ChildProcess, spawn } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IngestPayload, MetricRow } from '../../src'
import { VERSION } from '../../src/version'
import { KEY } from '../helpers'

export interface NextSetup {
  next: string
  react: string
  typesReact: string
  hasAfter: boolean
}

interface Ingest {
  server: Server
  url: string
  calls: { headers: IncomingHttpHeaders; payload: IngestPayload }[]
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../fixtures/next-app/', import.meta.url))
const AFTER_UNAVAILABLE = 'after() from next/server is unavailable'

export function describeNextApp({ next, react, typesReact, hasAfter }: NextSetup): void {
  describe(`next ${next}`, () => {
    let dir: string
    let ingest: Ingest
    let app: ChildProcess | undefined
    let base: string
    let output = ''
    let callsDuringBuild = 0

    beforeAll(async () => {
      await access(join(ROOT, 'dist/next.js')).catch(() => {
        throw new Error('dist/ is missing, run `npm run build` first')
      })

      dir = await mkdtemp(join(tmpdir(), `totallytics-next-${next}-`))
      await cp(FIXTURE, dir, { recursive: true })
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          private: true,
          dependencies: { next, react, 'react-dom': react },
          devDependencies: { '@types/node': '^22.20.4', '@types/react': typesReact, typescript: '~5.9.3' },
        }),
      )
      await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir, process.env, 300_000)

      // We copy the build instead of linking it so the bundler resolves it like a registry install
      const installed = join(dir, 'node_modules/totallytics')
      await mkdir(installed, { recursive: true })
      await cp(join(ROOT, 'package.json'), join(installed, 'package.json'))
      await cp(join(ROOT, 'dist'), join(installed, 'dist'), { recursive: true })

      ingest = await startIngest()
      const env = {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        TOTALLYTICS_API_KEY: KEY,
        TOTALLYTICS_ENDPOINT: ingest.url,
      }

      await run(process.execPath, ['node_modules/next/dist/bin/next', 'build'], dir, env, 300_000)
      callsDuringBuild = ingest.calls.length

      const port = await freePort()
      base = `http://127.0.0.1:${port}`
      app = spawnGroup(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], dir, env)
      app.stdout?.on('data', (chunk) => (output += chunk))
      app.stderr?.on('data', (chunk) => (output += chunk))
      await waitFor(() => fetch(`${base}/ready`, { signal: AbortSignal.timeout(5_000) }).then(() => true), 60_000)
    })

    afterAll(async () => {
      if (app) await stopGroup(app)
      ingest?.server.close()
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    const rows = () => ingest.calls.flatMap((call) => call.payload.metrics)
    const find = (route: string, status: number) => rows().find((row) => row.route === route && row.status === status)
    const hit = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...init })

    it('sends nothing during next build', () => {
      expect(callsDuringBuild).toBe(0)
    })

    it('records route templates, statuses and errors', async () => {
      const responses = await Promise.all([
        hit('/users/42', { headers: { 'user-agent': 'okhttp/4.12.0' } }),
        hit('/orgs/acme/repos/api'),
        hit('/files/a/b.txt'),
        hit('/docs'),
        hit('/docs/intro/setup'),
        hit('/boom', { method: 'POST', headers: { 'user-agent': 'curl/8.7.1' } }),
        hit('/posts/7'),
        hit('/posts/missing'),
        hit('/go'),
        hit('/people/9'),
        hit('/static'),
        hit('/nope/123'),
        hit('/edge/5'),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 500, 200, 404, 307, 200, 200, 404, 200])

      const expected = [
        'GET /docs 200',
        'GET /docs/* 200',
        'GET /edge/:id 200',
        'GET /files/* 200',
        'GET /go 307',
        'GET /orgs/:org/repos/:repo 200',
        'GET /people/:personId 200',
        'GET /posts/:id 200',
        'GET /posts/:id 404',
        'GET /users/:id 200',
        'POST /boom 500',
      ]
      const recorded = () => rows().map((row: MetricRow) => `${row.method} ${row.route} ${row.status}`)
      await waitFor(() => recorded().length >= expected.length, 15_000)
      expect(recorded().sort()).toEqual(expected)

      const call = ingest.calls[0]
      expect(call?.headers.authorization).toBe(`Bearer ${KEY}`)
      expect(call?.payload.sdk).toBe(`totallytics-js/${VERSION} next`)

      const errors = ingest.calls.flatMap((each) => each.payload.errors)
      expect(errors.find((row) => row.status === 500)).toMatchObject({ route: '/boom', path: '/boom', message: 'TypeError: kaboom' })
      expect(errors.find((row) => row.status === 404)).toMatchObject({ route: '/posts/:id', path: '/posts/missing' })
    })

    it(hasAfter ? 'flushes through after() with user agents' : 'falls back to a background flush', () => {
      expect(output.includes(AFTER_UNAVAILABLE)).toBe(!hasAfter)
      expect(find('/boom', 500)?.user_agent).toBe('curl/8.7.1')
      expect(find('/users/:id', 200)?.user_agent).toBe(hasAfter ? 'okhttp/4.12.0' : undefined)
    })

    it('keeps ISR route handlers cacheable', async () => {
      const first = await hit('/cached')
      const { builtAt } = (await first.json()) as { builtAt: number }
      await new Promise((resolve) => setTimeout(resolve, 1_200))

      const statuses = new Set<number>()
      await waitFor(async () => {
        const response = await hit('/cached')
        statuses.add(response.status)
        return response.ok && ((await response.json()) as { builtAt: number }).builtAt > builtAt
      }, 15_000)
      expect([...statuses]).toEqual([200])
      expect(output).not.toContain('Invariant')
    })
  })
}

// Each child gets its own process group, so we can stop everything it spawned and none of its signals reach vitest
function spawnGroup(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return

  const exited = new Promise((resolve) => child.once('exit', resolve))
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, signal)
    } catch {
      // The group is already gone
    }
  }

  signalGroup('SIGTERM')
  const timer = setTimeout(() => signalGroup('SIGKILL'), 5_000)
  await exited
  clearTimeout(timer)
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnGroup(command, args, cwd, env)
    let output = ''
    child.stdout?.on('data', (chunk) => (output += chunk))
    child.stderr?.on('data', (chunk) => (output += chunk))

    const timer = setTimeout(() => {
      output += `\n[timed out after ${timeoutMs} ms]`
      void stopGroup(child)
    }, timeoutMs)

    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}\n${output}`))
    })
  })
}

async function startIngest(): Promise<Ingest> {
  const calls: Ingest['calls'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      calls.push({ headers: req.headers, payload: JSON.parse(body) as IngestPayload })
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":{"metrics":1,"errors":0},"rejected":0}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest` }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out after ${timeoutMs} ms`, { cause: lastError })
}
