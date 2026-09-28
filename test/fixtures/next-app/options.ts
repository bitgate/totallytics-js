import type { NextOptions } from 'totallytics/next'

export const options: NextOptions = {
  endpoint: process.env.TOTALLYTICS_ENDPOINT,
  flushDelayMs: 0,
  debug: true,
}
