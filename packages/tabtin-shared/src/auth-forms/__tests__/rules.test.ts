import { describe, expect, it } from 'vitest'
import {
  SMS_CODE_MAX_LENGTH,
  isValidCnPhone,
  isValidSmsCode,
  sanitizeCnMobilePhoneInput,
  sanitizeSmsCodeInput,
  parseEmailLoginEnabled,
  isValidEmail,
  sanitizeAuthIdentifierInput,
  normalizeAuthIdentifier,
  isValidAuthIdentifier,
  splitRegisterContact,
} from '../rules.js'

describe('auth-forms rules', () => {
  it('sanitizeCnMobilePhoneInput strips non-digits and truncates', () => {
    expect(sanitizeCnMobilePhoneInput('abc13800138000xyz')).toBe('13800138000')
    expect(sanitizeCnMobilePhoneInput('138001380001234')).toBe('13800138000')
  })

  it('sanitizeSmsCodeInput strips non-digits and truncates to 6', () => {
    expect(SMS_CODE_MAX_LENGTH).toBe(6)
    expect(sanitizeSmsCodeInput('asdsad')).toBe('')
    expect(sanitizeSmsCodeInput('12ab34cd56')).toBe('123456')
    expect(sanitizeSmsCodeInput('123456789')).toBe('123456')
  })

  it('isValidCnPhone / isValidSmsCode match product rules', () => {
    expect(isValidCnPhone('13800138000')).toBe(true)
    expect(isValidCnPhone('11111111111')).toBe(false)
    expect(isValidSmsCode('123456')).toBe(true)
    expect(isValidSmsCode('12ab34')).toBe(false)
    expect(isValidSmsCode('12345')).toBe(false)
  })
})

describe('email-or-phone identifier rules', () => {
  it('parseEmailLoginEnabled treats only lowercase false as off', () => {
    expect(parseEmailLoginEnabled(undefined)).toBe(true)
    expect(parseEmailLoginEnabled('')).toBe(true)
    expect(parseEmailLoginEnabled('true')).toBe(true)
    expect(parseEmailLoginEnabled('false')).toBe(false)
    expect(parseEmailLoginEnabled(' FALSE ')).toBe(false)
  })

  it('isValidEmail accepts local@domain.tld', () => {
    expect(isValidEmail('user@example.com')).toBe(true)
    expect(isValidEmail('not-an-email')).toBe(false)
    expect(isValidEmail('user@')).toBe(false)
  })

  it('sanitizeAuthIdentifierInput keeps email text when enabled', () => {
    expect(sanitizeAuthIdentifierInput('User@Example.com', true)).toBe('User@Example.com')
    expect(sanitizeAuthIdentifierInput('user@x.com', false)).toBe(
      sanitizeCnMobilePhoneInput('user@x.com'),
    )
  })

  it('sanitizeAuthIdentifierInput keeps in-progress email letters when enabled', () => {
    expect(sanitizeAuthIdentifierInput('u', true)).toBe('u')
    expect(sanitizeAuthIdentifierInput('user', true)).toBe('user')
    expect(sanitizeAuthIdentifierInput('user@', true)).toBe('user@')
    expect(sanitizeAuthIdentifierInput('13800138000', true)).toBe('13800138000')
    expect(sanitizeAuthIdentifierInput('abc13800138000xyz', false)).toBe('13800138000')
  })

  it('normalizeAuthIdentifier lowercases email only', () => {
    expect(normalizeAuthIdentifier('  User@Example.COM ')).toBe('user@example.com')
    expect(normalizeAuthIdentifier('13800138000')).toBe('13800138000')
  })

  it('isValidAuthIdentifier respects the switch', () => {
    expect(isValidAuthIdentifier('user@example.com', true)).toBe(true)
    expect(isValidAuthIdentifier('user@example.com', false)).toBe(false)
    expect(isValidAuthIdentifier('13800138000', true)).toBe(true)
    expect(isValidAuthIdentifier('13800138000', false)).toBe(true)
  })

  it('splitRegisterContact routes email vs phone', () => {
    expect(splitRegisterContact('User@Example.com')).toEqual({ email: 'user@example.com' })
    expect(splitRegisterContact('13800138000')).toEqual({ phone: '13800138000' })
  })
})
