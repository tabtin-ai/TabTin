import { describe, expect, it } from 'vitest'
import { CN_MOBILE_PHONE_MAX_LENGTH, sanitizeCnMobilePhoneInput } from '../phoneInput'

describe('sanitizeCnMobilePhoneInput', () => {
  it('strips non-digit characters', () => {
    expect(sanitizeCnMobilePhoneInput('abc13800138000xyz')).toBe('13800138000')
    expect(sanitizeCnMobilePhoneInput('138-0013-8000')).toBe('13800138000')
  })

  it('truncates to CN mobile phone length', () => {
    expect(CN_MOBILE_PHONE_MAX_LENGTH).toBe(11)
    expect(sanitizeCnMobilePhoneInput('138001380001234')).toBe('13800138000')
  })

  it('returns empty string for empty or non-digit input', () => {
    expect(sanitizeCnMobilePhoneInput('')).toBe('')
    expect(sanitizeCnMobilePhoneInput('abc')).toBe('')
  })
})
