import { describe, expect, it } from 'vitest'
import {
  MATERIALIZE_MAX_BYTES,
  PREVIEW_KIND,
  SIGNED_URL_TTL_SECONDS,
  guessMaterializePreviewKind,
  isSharedSessionFileTooLargeForPreview,
} from '../session-share-preview-contract'

describe('session-share-preview-contract', () => {
  it('aligns numeric limits with Django workspace_file.constants', () => {
    expect(MATERIALIZE_MAX_BYTES).toBe(50 * 1024 * 1024)
    expect(SIGNED_URL_TTL_SECONDS).toBe(15 * 60)
  })

  it('routes materialize preview kinds', () => {
    expect(guessMaterializePreviewKind('a.pdf')).toBe(PREVIEW_KIND.pdf)
    expect(guessMaterializePreviewKind('a.png')).toBe(PREVIEW_KIND.image)
    expect(guessMaterializePreviewKind('a.xlsx')).toBe(PREVIEW_KIND.xlsx)
    expect(guessMaterializePreviewKind('a.bin')).toBe(PREVIEW_KIND.binary)
  })

  it('flags shared preview too-large at materialize hard cap', () => {
    expect(isSharedSessionFileTooLargeForPreview(undefined)).toBe(false)
    expect(isSharedSessionFileTooLargeForPreview(MATERIALIZE_MAX_BYTES)).toBe(false)
    expect(isSharedSessionFileTooLargeForPreview(MATERIALIZE_MAX_BYTES + 1)).toBe(true)
  })
})
