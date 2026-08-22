import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/theme-bundle.ts', 'src/wrapper.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: false,
})
