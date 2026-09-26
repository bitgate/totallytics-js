interface ProcessLike {
  env?: Record<string, string | undefined>
  pid?: number
  on?(event: string, listener: () => void): unknown
  removeListener?(event: string, listener: () => void): unknown
  listenerCount?(event: string): number
  kill?(pid: number, signal?: string): unknown
}

export interface Flushable {
  readonly hasBufferedData: boolean
  flush(): Promise<void>
}

interface SharedState {
  warned: Set<string>
  clients: Set<Flushable>
  hooked: boolean
  terminating: boolean
}

const STATE = Symbol.for('totallytics.state')
const SHUTDOWN_BUDGET_MS = 5_000

function shared(): SharedState {
  const scope = globalThis as unknown as Record<symbol, SharedState | undefined>
  return (scope[STATE] ??= { warned: new Set(), clients: new Set(), hooked: false, terminating: false })
}

function hostProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process
}

export function normalizeKey(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

export function defaultKey(env?: unknown): string | undefined {
  try {
    const bindings = env as { TOTALLYTICS_API_KEY?: unknown } | null | undefined
    return normalizeKey(bindings?.TOTALLYTICS_API_KEY) ?? normalizeKey(hostProcess()?.env?.TOTALLYTICS_API_KEY)
  } catch {
    return undefined
  }
}

export function warnOnce(id: string, message: string): void {
  const { warned } = shared()
  if (warned.has(id)) return
  warned.add(id)
  console.warn(`[totallytics] ${message}`)
}

export function warnNoKey(debug: boolean | undefined): void {
  if (debug) warnOnce('no-key', 'no API key (set TOTALLYTICS_API_KEY or pass apiKey), requests are not recorded')
}

export function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '')
  let id = ''
  while (id.length < 32) id += Math.random().toString(16).slice(2)
  return id.slice(0, 32)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unref(timer: unknown): void {
  try {
    const handle = timer as { unref?: () => void } | null | undefined
    if (typeof handle?.unref === 'function') return handle.unref()
    const deno = (globalThis as { Deno?: { unrefTimer?: (id: number) => void } }).Deno
    if (typeof timer === 'number') deno?.unrefTimer?.(timer)
  } catch {
    // Timers that can't be unref'd simply keep their default behavior
  }
}

export function startInterval(callback: () => void, ms: number): unknown {
  const timer: unknown = setInterval(callback, ms)
  unref(timer)
  return timer
}

export function flushOnShutdown(client: Flushable): void {
  const state = shared()
  state.clients.add(client)
  if (state.hooked) return

  const proc = hostProcess()
  if (typeof proc?.on !== 'function') return
  state.hooked = true

  const flushAll = () => Promise.all([...state.clients].map((each) => each.flush()))

  const onBeforeExit = () => {
    if ([...state.clients].some((each) => each.hasBufferedData)) void flushAll()
  }

  // Once a SIGTERM listener exists Node no longer exits by itself, so we re-raise when we're the only one
  const onSigterm = () => {
    if (state.terminating) return
    state.terminating = true
    try {
      const alone = proc.listenerCount?.('SIGTERM') === 1
      const budget = new Promise<void>((resolve) => unref(setTimeout(resolve, SHUTDOWN_BUDGET_MS)))
      Promise.race([flushAll(), budget])
        .then(() => {
          if (!alone || typeof proc.pid !== 'number') return
          proc.removeListener?.('SIGTERM', onSigterm)
          proc.kill?.(proc.pid, 'SIGTERM')
        })
        .catch(() => undefined)
    } catch {
      // Shutdown flushing is best effort
    }
  }

  try {
    proc.on('beforeExit', onBeforeExit)
    proc.on('SIGTERM', onSigterm)
  } catch {
    state.hooked = false
  }
}
