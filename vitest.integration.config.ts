import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.integration.ts'],
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
})
