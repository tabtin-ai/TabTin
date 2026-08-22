import { describe, expect, it } from 'vitest'
import { convertPasteValue } from '../useDataGridClipboard'

describe('convertPasteValue url/email/phone ', () => {
  it('trims pasted url whitespace so click can open in built-in browser', () => {
    expect(convertPasteValue(' https://example.com\n', 'url')).toBe('https://example.com')
    expect(convertPasteValue('\texample.com ', 'url')).toBe('example.com')
  })

  it('returns null for whitespace-only paste', () => {
    expect(convertPasteValue('   ', 'url')).toBeNull()
    expect(convertPasteValue('\n\t', 'email')).toBeNull()
  })

  it('trims email and phone the same way', () => {
    expect(convertPasteValue(' a@b.com\n', 'email')).toBe('a@b.com')
    expect(convertPasteValue(' 13800138000 ', 'phone')).toBe('13800138000')
  })
})
