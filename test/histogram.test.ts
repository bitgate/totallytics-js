import { describe, expect, it } from 'vitest'
import { bucket } from '../src/index'

const reference = (ms: number) => (ms <= 1 ? 0 : Math.min(Math.ceil(Math.log(ms) / Math.log(1.08)), 250))

describe('bucket', () => {
  it('puts <=1ms, negative and NaN durations in bucket 0', () => {
    for (const ms of [0, 0.2, 1, -3, Number.NaN, Number.NEGATIVE_INFINITY]) expect(bucket(ms)).toBe(0)
  })

  it('covers (1.08^(i-1), 1.08^i] with bucket i', () => {
    expect(bucket(1.0001)).toBe(1)
    expect(bucket(1.08)).toBe(1)
    expect(bucket(1.09)).toBe(2)
    expect(bucket(100)).toBe(60)
    expect(bucket(1000)).toBe(90)
  })

  it('caps at bucket 250', () => {
    expect(bucket(1.08 ** 250 * 2)).toBe(250)
    expect(bucket(Number.POSITIVE_INFINITY)).toBe(250)
  })

  it('matches the wire formula exactly', () => {
    for (let ms = 0; ms < 120_000; ms = ms * 1.013 + 0.017) expect(bucket(ms)).toBe(reference(ms))
  })
})
