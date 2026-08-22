import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * AdminDash 路由是 BrowserRouter（见 App.tsx），React Router 的 useBlocker
 * 只能在 data router 下使用；误用会在渲染期抛错导致整页白屏。
 */
describe('RuntimeConfigPage router contract', () => {
  it('does not import or call useBlocker', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'RuntimeConfigPage.tsx'),
      'utf8'
    )
    expect(src).not.toMatch(/import\s*\{[^}]*\buseBlocker\b/)
    expect(src).not.toMatch(/\buseBlocker\s*\(/)
  })
})
