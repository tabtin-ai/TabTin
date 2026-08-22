import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // Keep manifest.json import as runtime JSON, not inlined mystery blob.
  loader: {
    '.json': 'json',
  },
})
