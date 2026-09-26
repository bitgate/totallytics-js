const ORIGIN = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i

export function pathOf(url: string): string {
  const path = url.replace(ORIGIN, '')
  const end = path.search(/[?#]/)
  return (end === -1 ? path : path.slice(0, end)) || '/'
}

export function clip(value: string, max: number): string {
  if (value.length <= max) return value
  const last = value.charCodeAt(max - 1)
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

export function describeError(error: unknown): string | undefined {
  if (error == null) return undefined
  try {
    const { name, message } = error as { name?: unknown; message?: unknown }
    if (typeof message !== 'string') return String(error)
    return typeof name === 'string' && name && name !== 'Error' ? `${name}: ${message}` : message
  } catch {
    return undefined
  }
}

export function attempt<T>(callback: () => T, log?: (message: string) => void): T | undefined {
  try {
    return callback()
  } catch (error) {
    log?.(`callback threw: ${describeError(error)}`)
    return undefined
  }
}

export function debugLogger(debug: boolean | undefined): ((message: string) => void) | undefined {
  return debug ? (message) => console.warn(`[totallytics] ${message}`) : undefined
}
