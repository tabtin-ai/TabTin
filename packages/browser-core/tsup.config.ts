import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/url-policy/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2020',
  clean: true,
})
