import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tabdocHandler } from '../registry/handlers/tabdoc'

describe('tabdoc keepAliveSuspendMode ', () => {
  it('declares visibility keepAlive so SpaceContextArea skips Activity cleanup', () => {
    expect(tabdocHandler.keepAlive).toBe(true)
    expect(tabdocHandler.keepAliveSuspendMode).toBe('visibility')
  })

  it('keeps pane overlays mounted while a persistent page tab is active', () => {
    const source = readFileSync(resolve(
      process.cwd(),
      'src/renderer/src/components/context-space/SpaceContextArea.tsx',
    ), 'utf8')
    expect(source).toContain('{!shouldShowCanvasGroup && paneOverlays}')
    expect(source).not.toContain('mainContent = paneOverlays')
  })
})
