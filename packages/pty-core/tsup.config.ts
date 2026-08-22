import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  tsconfig: 'tsconfig.build.json',
  dts: true,
  external: ['node-pty', '@tabtin/env-sanitize'],
})
