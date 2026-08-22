import { describe, expect, it } from 'vitest'
import { validateBeforeSave, validateFieldRules } from '../cellValueUtils'

describe('validateFieldRules', () => {
  it('min_length / max_length / pattern 对非空值生效', () => {
    expect(validateFieldRules('ab', { min_length: 3 })).toMatchObject({
      valid: false,
      errorCode: 'min_length',
      params: { minLength: 3 },
    })
    expect(validateFieldRules('abcd', { max_length: 3 })).toMatchObject({
      valid: false,
      errorCode: 'max_length',
      params: { maxLength: 3 },
    })
    expect(validateFieldRules('ab12', { pattern: '^[A-Z]{2}\\d{4}$' })).toEqual({
      valid: false,
      errorCode: 'pattern',
    })
    expect(validateFieldRules('AB1234', { pattern: '^[A-Z]{2}\\d{4}$' }).valid).toBe(true)
  })

  it('字符串数字阈值与纯数字单元格值也触发长度规则', () => {
    expect(validateFieldRules('ab', { min_length: '3' })).toMatchObject({
      valid: false,
      errorCode: 'min_length',
      params: { minLength: 3 },
    })
    expect(validateFieldRules('abcd', { max_length: '3' })).toMatchObject({
      valid: false,
      errorCode: 'max_length',
      params: { maxLength: 3 },
    })
    // 文本编辑器偶发交出 number
    expect(validateFieldRules(12, { min_length: 3 })).toMatchObject({
      valid: false,
      errorCode: 'min_length',
      params: { minLength: 3 },
    })
    expect(validateFieldRules(1234, { max_length: 3 })).toMatchObject({
      valid: false,
      errorCode: 'max_length',
    })
  })

  it('空值且允许空白时跳过格式规则', () => {
    expect(validateFieldRules('', { min_length: 3, pattern: '^\\d+$' }).valid).toBe(true)
  })

  it('兼容 JS 正则字面量 /[0-9]+/g', () => {
    expect(validateFieldRules('1233', { pattern: '/[0-9]+/g' }).valid).toBe(true)
    expect(validateFieldRules('abc', { pattern: '/[0-9]+/g' }).valid).toBe(false)
    // 与 re.match 一致：只要求开头匹配，不要求整串
    expect(validateFieldRules('1233x', { pattern: '/[0-9]+/g' }).valid).toBe(true)
    expect(validateFieldRules('x1233', { pattern: '/[0-9]+/g' }).valid).toBe(false)
  })

  it('规则描述 message 优先作为失败提示', () => {
    expect(
      validateFieldRules('abc', {
        pattern: '^[0-9]+$',
        message: '请输入数字工号',
      }),
    ).toEqual({
      valid: false,
      errorCode: 'pattern',
      params: { message: '请输入数字工号' },
    })
  })
})

describe('validateBeforeSave', () => {
  it('先跑 validation_rules 再跑类型校验', () => {
    expect(
      validateBeforeSave('text', 'nope', {
        validation_rules: { pattern: '^\\d+$' },
      }),
    ).toEqual({ valid: false, errorCode: 'pattern' })

    expect(
      validateBeforeSave('email', 'not-an-email', {
        validation_rules: { min_length: 3 },
      }),
    ).toEqual({ valid: false, errorCode: 'invalid_email' })
  })

  it('number 拒绝非法字符串与 NaN（与 email 同路径）', () => {
    expect(validateBeforeSave('number', 'abc')).toEqual({
      valid: false,
      errorCode: 'invalid_number',
    })
    expect(validateBeforeSave('number', Number.NaN)).toEqual({
      valid: false,
      errorCode: 'invalid_number',
    })
    expect(validateBeforeSave('number', 12).valid).toBe(true)
  })

  it('phone 接受手机号/固话/400·800，拒绝乱码与过短号', () => {
    expect(validateBeforeSave('phone', '聪明后天')).toEqual({
      valid: false,
      errorCode: 'invalid_phone',
    })
    expect(validateBeforeSave('phone', '12341')).toEqual({
      valid: false,
      errorCode: 'invalid_phone',
    })
    expect(validateBeforeSave('phone', '138-0013-8000').valid).toBe(true)
    expect(validateBeforeSave('phone', '13800138000').valid).toBe(true)
    expect(validateBeforeSave('phone', '010-1234-5678').valid).toBe(true)
    expect(validateBeforeSave('phone', '0755-87654321').valid).toBe(true)
    expect(validateBeforeSave('phone', '400-123-4567').valid).toBe(true)
    expect(validateBeforeSave('phone', '').valid).toBe(true)
  })
})
