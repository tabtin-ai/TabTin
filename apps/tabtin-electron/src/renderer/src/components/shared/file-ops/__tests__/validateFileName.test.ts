import { describe, it, expect, vi } from 'vitest'
import { validateFileName, INVALID_FILE_NAME_CHARS } from '../validateFileName'

describe('validateFileName', () => {
  it('accepts normal names', () => {
    expect(validateFileName('readme.md')).toBeNull()
    expect(validateFileName('src')).toBeNull()
  })

  it('rejects empty or whitespace-only names', () => {
    expect(validateFileName('')).not.toBeNull()
    expect(validateFileName('   ')).not.toBeNull()
  })

  it('rejects invalid path characters', () => {
    for (const ch of '/\\:*?"<>|') {
      expect(validateFileName(`bad${ch}name`)).not.toBeNull()
    }
    expect(INVALID_FILE_NAME_CHARS.test('/')).toBe(true)
  })

  it('rejects . and ..', () => {
    expect(validateFileName('.')).not.toBeNull()
    expect(validateFileName('..')).not.toBeNull()
  })

  it('rejects names longer than 255 characters', () => {
    expect(validateFileName('a'.repeat(256))).not.toBeNull()
    expect(validateFileName('a'.repeat(255))).toBeNull()
  })

  it('uses i18n when t is provided', () => {
    const t = vi.fn((key: string) => {
      if (key === 'fileOps.validate.empty') return '名称不能为空'
      return key
    })
    expect(validateFileName('', t)).toBe('名称不能为空')
    expect(t).toHaveBeenCalledWith('fileOps.validate.empty', expect.objectContaining({
      defaultValue: expect.any(String),
    }))
  })
})
