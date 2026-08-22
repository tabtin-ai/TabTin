import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readBubbleMenuSource() {
  return readFileSync(resolve(process.cwd(), 'src/editor/bubble-menu.tsx'), 'utf8')
}

function readSelectorSource(filename: string) {
  return readFileSync(resolve(process.cwd(), 'src/editor/selectors', filename), 'utf8')
}

describe('DocBubbleMenu placement', () => {
  it('keeps the toolbar above the selection when nested popovers open', () => {
    const source = readBubbleMenuSource()

    expect(source).toContain("placement: 'top'")
    expect(source).toContain('offset: [0, 10]')
    expect(source).not.toContain('bottom-start')
    expect(source).not.toMatch(/placement:\s*open\s*\?/)
  })

  it.each(['node-selector.tsx', 'color-selector.tsx', 'link-selector.tsx'])(
    'opens %s without vertical slide motion',
    (filename) => {
      const source = readSelectorSource(filename)

      expect(source).toContain('data-[side=bottom]:!slide-in-from-top-0')
      expect(source).toContain('data-[side=top]:!slide-in-from-bottom-0')
    },
  )
})
