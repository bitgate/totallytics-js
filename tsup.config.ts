import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    hono: 'src/hono.ts',
    workers: 'src/workers.ts',
    express: 'src/express.ts',
    fastify: 'src/fastify.ts',
    next: 'src/next.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
})
