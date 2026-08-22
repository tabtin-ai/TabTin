import { describe, expect, it } from 'vitest'
import {
  getMonacoIdeThemeName,
  MONACO_IDE_FONT_SIZE,
  MONACO_IDE_LINE_HEIGHT,
} from '../monaco-ide-theme'

describe('monaco-ide-theme', () => {
  it('maps dark class to dark IDE theme', () => {
    expect(getMonacoIdeThemeName(true)).toBe('vs-dark')
    expect(getMonacoIdeThemeName(false)).toBe('vs')
  })

  it('exposes modern IDE density defaults', () => {
    expect(MONACO_IDE_FONT_SIZE).toBe(12)
    expect(MONACO_IDE_LINE_HEIGHT).toBe(18)
  })
})
