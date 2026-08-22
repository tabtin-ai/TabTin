import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const BULLET_CYCLE = ['disc', 'circle', 'square'] as const
const ORDERED_CYCLE = ['decimal', 'lower-alpha', 'lower-roman'] as const

function readProseMirrorCss() {
  return readFileSync(resolve(process.cwd(), 'src/editor/prosemirror.css'), 'utf8')
}

/** Resolve list-style-type for a list nested `depth` levels (1-based). */
function resolveListStyleType(
  css: string,
  tag: 'ul' | 'ol',
  depth: number,
): string | null {
  const ruleRe = new RegExp(
    `\\.ProseMirror(?:\\s+${tag})+\\s*\\{\\s*list-style-type:\\s*([a-z-]+)\\s*;`,
    'g',
  )
  let bestType: string | null = null
  let bestCount = 0
  for (const match of css.matchAll(ruleRe)) {
    const selector = match[0].slice(0, match[0].indexOf('{'))
    const count = (selector.match(new RegExp(`\\b${tag}\\b`, 'g')) || []).length
    if (count <= depth && count >= bestCount) {
      bestCount = count
      bestType = match[1]
    }
  }
  return bestType
}

describe('TabDoc nested list marker cycles ', () => {
  it('cycles bullet markers disc → circle → square across 9 depths', () => {
    const css = readProseMirrorCss()
    for (let depth = 1; depth <= 9; depth += 1) {
      expect(resolveListStyleType(css, 'ul', depth)).toBe(
        BULLET_CYCLE[(depth - 1) % BULLET_CYCLE.length],
      )
    }
  })

  it('cycles ordered markers decimal → lower-alpha → lower-roman across 9 depths', () => {
    const css = readProseMirrorCss()
    for (let depth = 1; depth <= 9; depth += 1) {
      expect(resolveListStyleType(css, 'ol', depth)).toBe(
        ORDERED_CYCLE[(depth - 1) % ORDERED_CYCLE.length],
      )
    }
  })

  it('keeps ~1.5rem nest indent on lists', () => {
    const css = readProseMirrorCss()
    expect(css).toMatch(
      /\.ProseMirror ul,\s*\n\.ProseMirror ol \{\s*\n\s*padding-left:\s*1\.5rem;/,
    )
  })
})
