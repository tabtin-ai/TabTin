import { readFileSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

/**
 * esbuild/tsup 打包时会把 `import … from 'node:sqlite'` 写成裸 `sqlite`
 * ，Node / Electron 都解析不了。external 挡不住这次改写，故在
 * onSuccess 里把 dist 里的裸 `sqlite` 规格化器还原为 `node:sqlite`。
 * worker 内联源码字符串本来就保留 `node:sqlite`，不受影响。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  platform: 'node',
  external: [/^node:/],
  async onSuccess() {
    const file = 'dist/index.js'
    const text = readFileSync(file, 'utf8')
    const next = text
      .replace(/\bfrom\s+["']sqlite["']/g, 'from "node:sqlite"')
      .replace(/\bimport\s+["']sqlite["']/g, 'import "node:sqlite"')
    if (next === text) {
      if (!/\bfrom\s+["']node:sqlite["']/.test(text)) {
        throw new Error('[tsup] dist/index.js 未包含 node:sqlite import，请检查打包配置')
      }
      return
    }
    writeFileSync(file, next)
    console.log('[tsup] restored node:sqlite imports in dist/index.js')
  },
})
