import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('TabDoc force-close overlay boundary', () => {
  it('provides an application-local positioning boundary', () => {
    const shellSource = readFileSync(
      resolve(process.cwd(), 'src/editor/DocEditorViewShell.tsx'),
      'utf8',
    )

    expect(shellSource).toContain(
      '<div className="relative flex h-full flex-col overflow-hidden"',
    )
  })

  it('lets the Electron host replace an initial permission load error', () => {
    const shellSource = readFileSync(
      resolve(process.cwd(), 'src/editor/DocEditorViewShell.tsx'),
      'utf8',
    )

    expect(shellSource).toContain('loadErrorFallback?: React.ReactNode')
    expect(shellSource).toContain('{loadError && loadErrorFallback}')
  })
})
