import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Shell resize layering contract', () => {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const shellSource = readFileSync(join(currentDir, 'ShellResizableSplits.tsx'), 'utf8')
  const globalsSource = readFileSync(join(currentDir, '../../styles/globals.css'), 'utf8')

  it('raises resize handles only for scoped overlays that explicitly preserve shell resizing', () => {
    expect(shellSource).toContain('data-shell-resizable-split')
    expect(shellSource).toContain('data-shell-resize-handle')
    expect(globalsSource).toContain(
      '[data-shell-resizable-split]:has([data-shell-overlay-allows-resize]) [data-shell-resize-handle]',
    )
    expect(globalsSource).toMatch(/data-shell-resize-handle[\s\S]*?z-index:\s*var\(--z-dropdown\)/)
  })

  it('keeps real scoped modal dialogs above resize handles', () => {
    expect(globalsSource).toContain(
      '[data-shell-resizable-split]:has([role="dialog"][aria-modal="true"]) [data-shell-resize-handle]',
    )
    expect(globalsSource).toMatch(/aria-modal="true"[\s\S]*?z-index:\s*var\(--z-sticky\)/)
  })
})
