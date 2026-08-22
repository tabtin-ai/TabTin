import { describe, expect, it } from 'vitest'
import {
  DOC_EDITOR_MAX_CONTENT_BYTES,
  DOC_EDITOR_MAX_TOP_LEVEL_BLOCKS,
  assessDocumentContentBudget,
  formatDocumentContentBudgetError,
} from '../documentContentBudget'
import { TEXT_IMPORT_MAX_BYTES } from '../editor/import-file-utils'

describe('documentContentBudget', () => {
  it('aligns byte budget with text import max', () => {
    expect(DOC_EDITOR_MAX_CONTENT_BYTES).toBe(TEXT_IMPORT_MAX_BYTES)
    expect(DOC_EDITOR_MAX_CONTENT_BYTES).toBe(5 * 1024 * 1024)
  })

  it('accepts normal small documents', () => {
    const result = assessDocumentContentBudget(
      {
        type: 'doc',
        content: Array.from({ length: 17 }, () => ({
          type: 'paragraph',
          content: [{ type: 'text', text: '荷塘月色' }],
        })),
      },
      '荷塘月色',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.topLevelBlocks).toBe(17)
    }
  })

  it('rejects amplified top-level block counts at the boundary', () => {
    const over = assessDocumentContentBudget({
      type: 'doc',
      content: Array.from({ length: DOC_EDITOR_MAX_TOP_LEVEL_BLOCKS + 1 }, () => ({
        type: 'paragraph',
      })),
    })
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.reason).toBe('top_level_blocks')
      expect(over.topLevelBlocks).toBe(DOC_EDITOR_MAX_TOP_LEVEL_BLOCKS + 1)
    }

    const atLimit = assessDocumentContentBudget({
      type: 'doc',
      content: Array.from({ length: DOC_EDITOR_MAX_TOP_LEVEL_BLOCKS }, () => ({
        type: 'paragraph',
      })),
    })
    expect(atLimit.ok).toBe(true)
  })

  it('rejects content over the shared 5MB budget', () => {
    const hugeText = 'x'.repeat(DOC_EDITOR_MAX_CONTENT_BYTES + 1)
    const result = assessDocumentContentBudget(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
      hugeText,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('content_bytes')
      const message = formatDocumentContentBudgetError(result, (_k, o) => {
        const template = String(o?.defaultValue ?? _k)
        return template
          .replace('{{sizeMb}}', String(o?.sizeMb ?? ''))
          .replace('{{maxMb}}', String(o?.maxMb ?? ''))
      })
      expect(message).toContain('5')
      expect(result.contentBytes).toBeGreaterThan(DOC_EDITOR_MAX_CONTENT_BYTES)
    }
  })
})
