import { describe, expect, it } from 'vitest'
import {
  formatLinkRecordLabel,
  isIdLikeLinkTitle,
  resolveLinkGridCellText,
  UNNAMED_RECORD_DISPLAY_NAME,
} from './linkRecordLabel'

describe('link record display labels', () => {
  const id = '6cdd953d-1234-4abc-8def-0123456789ab'

  it('recognizes empty and UUID-derived labels as non-readable record titles', () => {
    expect(isIdLikeLinkTitle(id, '')).toBe(true)
    expect(isIdLikeLinkTitle(id, id)).toBe(true)
    expect(isIdLikeLinkTitle(id, '6cdd953d')).toBe(true)
  })

  it('shows the shared placeholder instead of a UUID', () => {
    expect(formatLinkRecordLabel(id, '')).toBe(UNNAMED_RECORD_DISPLAY_NAME)
    expect(formatLinkRecordLabel(id, id)).toBe(UNNAMED_RECORD_DISPLAY_NAME)
  })

  it('keeps real record labels and explicit caller fallbacks', () => {
    expect(formatLinkRecordLabel(id, 'Department A')).toBe('Department A')
    expect(formatLinkRecordLabel(id, '', 'Untitled')).toBe('Untitled')
  })

  it('keeps an empty configured display column empty', () => {
    expect(resolveLinkGridCellText('')).toBe('')
    expect(resolveLinkGridCellText('Notes')).toBe('Notes')
  })
})
