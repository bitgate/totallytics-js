const LOG_GROWTH = Math.log(1.08)

export const MAX_BUCKET = 250

export function bucket(ms: number): number {
  if (!(ms > 1)) return 0
  return Math.min(Math.ceil(Math.log(ms) / LOG_GROWTH), MAX_BUCKET)
}
