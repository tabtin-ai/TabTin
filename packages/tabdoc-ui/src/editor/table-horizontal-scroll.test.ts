import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readProseMirrorStyles(): string {
  return readFileSync(resolve(process.cwd(), 'src/editor/prosemirror.css'), 'utf8')
}

function cssRule(styles: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))
  return match?.[1] ?? ''
}

describe('TabDoc table horizontal scroll contract', () => {
  it('keeps tableWrapper as a real touch scroller', () => {
    const styles = readProseMirrorStyles()
    const wrapper = cssRule(styles, '.ProseMirror .tableWrapper')

    expect(wrapper).toContain('overflow-x: auto')
    expect(wrapper).toContain('overflow-y: hidden')
    expect(wrapper).toContain('-webkit-overflow-scrolling: touch')
    expect(wrapper).toContain('overscroll-behavior-x: contain')
    expect(wrapper).toContain('touch-action: pan-x pan-y')
  })

  it('lets narrow screens scroll tables instead of clipping cell content', () => {
    const styles = readProseMirrorStyles()
    const table = cssRule(styles, '.ProseMirror table')
    const cells = cssRule(styles, '.ProseMirror table td,\n.ProseMirror table th')

    expect(table).toContain('width: max-content')
    expect(table).toContain('min-width: 100%')
    expect(table).toContain('max-width: none')
    expect(cells).toContain('min-width: 10rem')
  })
})
