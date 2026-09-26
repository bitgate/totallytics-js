import { afterEach, beforeEach, vi } from 'vitest'
import type { ErrorRow, IngestPayload, MetricRow } from '../src/index'

export const KEY = `tt_${'ab'.repeat(24)}`
export const MINUTE = Date.UTC(2026, 8, 26, 12, 0, 0)

export interface IngestCall {
  url: string
  headers: Record<string, string>
  raw: string
  payload: IngestPayload
}

type Responder = (call: IngestCall, index: number) => Response | Promise<Response>

export function accepted(): Response {
  return new Response(JSON.stringify({ accepted: { metrics: 1, errors: 0 }, rejected: 0 }), { status: 202 })
}

export function mockIngest(respond: Responder = accepted) {
  const calls: IngestCall[] = []
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body)
    const call: IngestCall = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      raw,
      payload: JSON.parse(raw) as IngestPayload,
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

export function metricsOf(calls: IngestCall[]): MetricRow[] {
  return calls.flatMap((call) => call.payload.metrics)
}

export function errorsOf(calls: IngestCall[]): ErrorRow[] {
  return calls.flatMap((call) => call.payload.errors)
}

export function findRow(calls: IngestCall[], route: string, status?: number): MetricRow | undefined {
  return metricsOf(calls).find((row) => row.route === route && (status === undefined || row.status === status))
}

export function warnSpy() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined)
}

export function warnings(spy: ReturnType<typeof warnSpy>): string[] {
  return spy.mock.calls.map((args) => String(args[0]))
}

export function resetSharedState(): void {
  beforeEach(() => {
    const state = (globalThis as Record<symbol, { warned: Set<string>; clients: Set<unknown> } | undefined>)[
      Symbol.for('totallytics.state')
    ]
    state?.warned.clear()
    state?.clients.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })
}
