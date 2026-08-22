import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  external: [
    'electron',
    // '@tabtin/crawl-extension' removed (Phase 3 cleanup)
    'puppeteer-core',
  ],
  target: 'es2020',
  clean: true,
})
