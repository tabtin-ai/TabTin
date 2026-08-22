import { describe, expect, it } from 'vitest'
import { reconstructPdfPageText } from '../workers/handlers.js'

describe('reconstructPdfPageText', () => {
  it('restores word boundaries and removes overlapping OCR text layers', () => {
    const text = reconstructPdfPageText([
      {
        str: 'How Anthropic teams',
        transform: [1, 0, 0, 1, 54, 678],
        width: 492,
        height: 53,
        hasEOL: true,
      },
      {
        str: 'How Anthropic',
        transform: [1, 0, 0, 1, 58, 678],
        width: 311,
        height: 43,
        hasEOL: false,
      },
      {
        str: 'teams',
        transform: [1, 0, 0, 1, 401, 678],
        width: 124,
        height: 43,
        hasEOL: true,
      },
      {
        str: 'developers and non-technical staff',
        transform: [1, 0, 0, 1, 54, 135],
        width: 450,
        height: 13,
        hasEOL: true,
      },
      {
        str: 'developers and non-technical',
        transform: [1, 0, 0, 1, 54, 135],
        width: 145,
        height: 12,
        hasEOL: false,
      },
      {
        str: 'staff',
        transform: [1, 0, 0, 1, 207, 135],
        width: 30,
        height: 12,
        hasEOL: true,
      },
      {
        str: 'Claude',
        transform: [1, 0, 0, 1, 54, 100],
        width: 42,
        height: 12,
        hasEOL: false,
      },
      {
        str: 'Code',
        transform: [1, 0, 0, 1, 104, 100],
        width: 28,
        height: 12,
        hasEOL: true,
      },
    ])

    expect(text).toContain('How Anthropic teams')
    expect(text.match(/How Anthropic teams/g)).toHaveLength(1)
    expect(text).toContain('developers and non-technical staff')
    expect(text.match(/developers and non-technical staff/g)).toHaveLength(1)
    expect(text).toContain('Claude Code')
  })
})
