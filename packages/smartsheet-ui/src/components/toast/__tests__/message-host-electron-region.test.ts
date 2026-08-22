import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Electron 顶栏 WindowDragRegion 使用 -webkit-app-region: drag。
 * MessageHost 贴顶且无 no-drag 时，最上张 toast 的 × 会被原生拖拽命中吞掉。
 */
describe('MessageHost — Electron app-region', () => {
  it('viewport 与卡片必须声明 app-region-no-drag', () => {
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'message-host.tsx')
    const source = readFileSync(sourcePath, 'utf8')
    expect(source).toContain('app-region-no-drag pointer-events-none fixed top-0 z-toast-host')
    expect(source).toContain('app-region-no-drag pointer-events-auto relative flex w-full flex-col')
  })
})
