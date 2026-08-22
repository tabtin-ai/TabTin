/**
 * 冒烟：dist 不得把 `node:sqlite` 打成不可解析的 `sqlite`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distJs = join(root, 'dist', 'index.js')
const text = readFileSync(distJs, 'utf8')

if (!/\bfrom\s+['"]node:sqlite['"]/.test(text)) {
  console.error('[assert-dist-node-sqlite] dist/index.js 缺少 from "node:sqlite"')
  process.exit(1)
}
if (/\bfrom\s+['"]sqlite['"]/.test(text)) {
  console.error('[assert-dist-node-sqlite] dist/index.js 仍含裸 from "sqlite"（tsup 剥离了 node:）')
  process.exit(1)
}

const mod = await import(pathToFileURL(distJs).href)
if (typeof mod.NodeImportIO !== 'function') {
  console.error('[assert-dist-node-sqlite] dist 加载失败：NodeImportIO 缺失')
  process.exit(1)
}

console.log('[assert-dist-node-sqlite] ok')
