import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('main-window setWindowOpenHandler preview wiring', () => {
  it('routes http(s) window.open through sendResourceOpenFallback instead of unconditional openExternal', async () => {
    const source = await readFile(resolve(__dirname, '../main-window.ts'), 'utf8')
    expect(source).toContain('sendResourceOpenFallback')
    expect(source).toContain("source: 'main_window'")
    const handlerStart = source.indexOf('mainWindow.webContents.setWindowOpenHandler')
    const handler = source.slice(handlerStart, handlerStart + 1200)
    expect(handler).toContain('sendResourceOpenFallback(mainWindow')
    // mailto 仍可 openExternal；https 主路径应先走 fallback
    expect(handler.indexOf("parsed.protocol === 'mailto:'")).toBeLessThan(
      handler.indexOf('sendResourceOpenFallback'),
    )
  })
})
