import { describe, it, expect } from 'vitest'
import {
  passwordHasWhitespace,
  stripPasswordWhitespace,
  passwordHasSpecialChar,
  passwordContainsCjk,
  sanitizeNewPasswordInput,
  countPasswordCharClasses,
  passwordMeetsCharClassRule,
  resolveSuggestionKey,
  PASSWORD_SPECIAL_CHARS,
  PASSWORD_MIN_CHAR_CLASSES,
} from '../password-strength.js'

describe('passwordHasWhitespace ()', () => {
  it('rejects leading / trailing / middle space', () => {
    expect(passwordHasWhitespace(' Abc12345')).toBe(true)
    expect(passwordHasWhitespace('Abc12345 ')).toBe(true)
    expect(passwordHasWhitespace('Abc 12345')).toBe(true)
  })

  it('rejects tab and newline', () => {
    expect(passwordHasWhitespace('Abc1234\t5')).toBe(true)
    expect(passwordHasWhitespace('Abc1234\n5')).toBe(true)
  })

  it('accepts password without any whitespace', () => {
    expect(passwordHasWhitespace('Abcd1234!')).toBe(false)
    expect(passwordHasWhitespace('Abcd1234')).toBe(false)
  })
})

describe('stripPasswordWhitespace ()', () => {
  it('removes leading / trailing / middle space', () => {
    expect(stripPasswordWhitespace(' Abc12345')).toBe('Abc12345')
    expect(stripPasswordWhitespace('Abc12345 ')).toBe('Abc12345')
    expect(stripPasswordWhitespace('Abc 12345')).toBe('Abc12345')
  })

  it('removes tab and newline (e.g. pasted content)', () => {
    expect(stripPasswordWhitespace('Abc1234\t5')).toBe('Abc12345')
    expect(stripPasswordWhitespace('Abc1234\n5')).toBe('Abc12345')
    expect(stripPasswordWhitespace('A b\tc\n1')).toBe('Abc1')
  })

  it('leaves a whitespace-free password untouched', () => {
    expect(stripPasswordWhitespace('Abcd1234!')).toBe('Abcd1234!')
    expect(stripPasswordWhitespace('')).toBe('')
  })

  it('result never trips passwordHasWhitespace', () => {
    expect(passwordHasWhitespace(stripPasswordWhitespace('A b c 1 2 3'))).toBe(false)
  })
})

describe('countPasswordCharClasses', () => {
  it('does not count whitespace as a special character', () => {
    // 仅大写 + 小写 + 数字 = 3 类；空格不计入特殊字符
    expect(countPasswordCharClasses('Abc 1234')).toBe(3)
  })

  it('counts upper / lower / digit / special (non-alnum non-whitespace)', () => {
    expect(countPasswordCharClasses('Abcd1234!')).toBe(4)
    expect(countPasswordCharClasses('abcd')).toBe(1)
  })

  it('special whitelist excludes the space character', () => {
    expect(PASSWORD_SPECIAL_CHARS.includes(' ')).toBe(false)
  })

  // ：反引号 / 间隔号等白名单外符号也计入特殊字符
  it('counts backtick and interpunct as special characters', () => {
    expect(passwordHasSpecialChar('niwota0512`')).toBe(true)
    expect(passwordHasSpecialChar('niwota0512·')).toBe(true)
    expect(countPasswordCharClasses('niwota0512`')).toBe(3)
    expect(countPasswordCharClasses('niwota0512·')).toBe(3)
    expect(passwordMeetsCharClassRule('niwota0512`')).toBe(true)
    expect(passwordMeetsCharClassRule('niwota0512·')).toBe(true)
  })

  it('does not treat CJK letters as special (align with Python isalnum)', () => {
    expect(passwordHasSpecialChar('密码abc')).toBe(false)
    expect(countPasswordCharClasses('密码abc')).toBe(1)
  })

  it('detects CJK in pasted prose ()', () => {
    expect(passwordContainsCjk('这个报错的原因是你的特征列里有Education')).toBe(true)
    expect(passwordContainsCjk('niwota0512`')).toBe(false)
  })

  it('sanitizeNewPasswordInput strips spaces and clears CJK', () => {
    expect(sanitizeNewPasswordInput('Abcd 1234!')).toEqual({
      value: 'Abcd1234!',
      notice: 'whitespace',
    })
    expect(sanitizeNewPasswordInput('这个报错 Education.')).toEqual({
      value: '',
      notice: 'cjk',
    })
    expect(sanitizeNewPasswordInput('niwota0512`')).toEqual({
      value: 'niwota0512`',
      notice: null,
    })
  })

  // ：1 / 2 类必须拒绝，3 类（含「混合大小写+数字」）可通过
  it('treats 1-class passwords as below the minimum', () => {
    expect(countPasswordCharClasses('12345678')).toBe(1)
    expect(countPasswordCharClasses('abcdefgh')).toBe(1)
    expect(countPasswordCharClasses('ABCDEFGH')).toBe(1)
    expect(passwordMeetsCharClassRule('12345678')).toBe(false)
    expect(passwordMeetsCharClassRule('abcdefgh')).toBe(false)
  })

  it('treats 2-class passwords as below the minimum (letters+digits without mixed case)', () => {
    expect(countPasswordCharClasses('abcdefg1')).toBe(2)
    expect(countPasswordCharClasses('ABCDEFG1')).toBe(2)
    expect(countPasswordCharClasses('Abcdefgh')).toBe(2)
    expect(countPasswordCharClasses('xyz!!!!!')).toBe(2)
    expect(passwordMeetsCharClassRule('abcdefg1')).toBe(false)
    expect(passwordMeetsCharClassRule('ABCDEFG1')).toBe(false)
    expect(passwordMeetsCharClassRule('Abcdefgh')).toBe(false)
  })

  it('accepts 3-class passwords including mixed-case letters + digits', () => {
    expect(PASSWORD_MIN_CHAR_CLASSES).toBe(3)
    expect(countPasswordCharClasses('Xyz12345')).toBe(3)
    expect(countPasswordCharClasses('xyz1234!')).toBe(3)
    expect(countPasswordCharClasses('Xyz!!!!!')).toBe(3)
    expect(passwordMeetsCharClassRule('Xyz12345')).toBe(true)
    expect(passwordMeetsCharClassRule('xyz1234!')).toBe(true)
    expect(passwordMeetsCharClassRule('Xyz!!!!!')).toBe(true)
  })
})

describe('resolveSuggestionKey', () => {
  it('accepts stable suggestion keys and legacy Chinese suggestions', () => {
    expect(resolveSuggestionKey('great')).toBe('great')
    expect(resolveSuggestionKey('requireMixedCase')).toBe('requireMixedCase')
    expect(resolveSuggestionKey('密码强度很好！')).toBe('great')
    expect(resolveSuggestionKey('必须包含大小写字母')).toBe('requireMixedCase')
  })

  // ：强度建议文案改为「至少 3 种」后，新旧中文均应解析到 useMixedChars
  it('maps new and legacy mixed-chars Chinese suggestions to useMixedChars', () => {
    expect(resolveSuggestionKey('useMixedChars')).toBe('useMixedChars')
    expect(
      resolveSuggestionKey('建议包含大写/小写/数字/特殊字符中的至少3种'),
    ).toBe('useMixedChars')
    expect(
      resolveSuggestionKey('建议使用大小写字母、数字和特殊字符'),
    ).toBe('useMixedChars')
  })
})
