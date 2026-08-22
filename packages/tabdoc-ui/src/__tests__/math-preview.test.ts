import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderMathPreview } from '../editor/math-preview'

describe('renderMathPreview', () => {
  it('returns empty preview for blank input', () => {
    expect(renderMathPreview('')).toEqual({ html: '', error: null })
    expect(renderMathPreview('   ')).toEqual({ html: '', error: null })
  })

  it('renders a simple formula to KaTeX HTML', () => {
    const result = renderMathPreview('E = mc^2')
    expect(result.error).toBeNull()
    expect(result.html).toContain('katex')
    expect(result.html.length).toBeGreaterThan(0)
  })
})

describe('slash math formula insert ', () => {
  it('does not hardcode E = mc^2; opens user input via slash action', () => {
    const source = readFileSync(
      resolve(__dirname, '../editor/slash-command.tsx'),
      'utf-8',
    )
    expect(source).not.toMatch(/setLatex\(\{\s*latex:\s*'E = mc\^2'\s*\}\)/)
    expect(source).toContain('onRequestMathFormula')
  })
})
