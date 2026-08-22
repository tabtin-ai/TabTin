import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const electronRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const startupSurfaces = [
  'src/renderer/index.html',
  'src/renderer/src/main.tsx',
]

const developmentOnlyCopy = [
  /编译依赖/,
  /\b(?:npm|pnpm|vite)\b/i,
  /约需\s*\d/,
]

function extractStartupCopySurface(relativePath, source) {
  const match = relativePath.endsWith('.html')
    ? source.match(/<div class="boot-screen">[\s\S]*?<\/div>\s*<\/div>/)
    : source.match(/function BootScreen\(\) \{[\s\S]*?\n\}/)

  assert.ok(match, `未找到启动页结构：${relativePath}`)
  return match[0]
}

describe('客户端启动页文案契约', () => {
  for (const relativePath of startupSurfaces) {
    it(`${relativePath} 不向用户暴露开发构建细节`, () => {
      const source = readFileSync(join(electronRoot, relativePath), 'utf8')
      const startupCopySurface = extractStartupCopySurface(relativePath, source)

      for (const pattern of developmentOnlyCopy) {
        assert.doesNotMatch(startupCopySurface, pattern)
      }
    })
  }
})
