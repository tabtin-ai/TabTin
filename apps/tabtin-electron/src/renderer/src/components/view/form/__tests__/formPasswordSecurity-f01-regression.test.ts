/**
 * 回归测试：密码保护表单修复 (AS-001, AS-005, BS-002/003/009)
 *
 * 验证：
 * - submitForm 函数在传入 password 时附加 X-Form-Password header (AS-001①)
 * - PasswordGate 组件存在且正确导出 (AS-001②)
 * - 提交按钮不再依赖 formFields.length > 0 条件 (AS-005)
 * - ensureShareId 返回 hasPassword 字段
 * - effectiveFormFields / effectiveFormConfig 正确处理 verifiedFormMeta
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import { buildPublicFormSubmitHeaders } from '../formSubmitValues'

const SOURCE_PATH = 'src/renderer/src/components/view/form/FormPreviewer.tsx'
const source = fs.readFileSync(SOURCE_PATH, 'utf-8')

describe('AS-001①: submitForm sends X-Form-Password header', () => {
  it('submitForm accepts optional password parameter', () => {
    expect(source).toContain('password?: string')
    expect(buildPublicFormSubmitHeaders('secret')).toMatchObject({
      'X-Form-Password': 'secret',
    })
  })

  it('handleSubmit passes localPasswordRef to submitForm', () => {
    expect(source).toContain('localPasswordRef.current || undefined')
    expect(source).toContain('await submitForm(')
  })
})

describe('AS-001②: PasswordGate component exists', () => {
  it('PasswordGate renders Lock icon and password input', () => {
    expect(source).toContain('const PasswordGate')
    expect(source).toContain('type="password"')
    expect(source).toContain('<Lock')
  })

  it('PasswordGate calls verifyFormPassword on verify', () => {
    expect(source).toContain('verifyFormPassword(shareId, password)')
  })

  it('verifyFormPassword function sends POST to verify endpoint', () => {
    expect(source).toContain('/tabdata/forms/${shareId}/verify')
  })

  it('PasswordGate is rendered when needsPassword is true', () => {
    expect(source).toContain('needsPassword')
    expect(source).toContain('<PasswordGate')
  })
})

describe('AS-005: submit button no longer gated by formFields.length', () => {
  it('does not contain formFields.length > 0 condition on submit button', () => {
    expect(source).not.toMatch(/formFields\.length\s*>\s*0\s*&&/)
  })

  it('submit button div has no conditional wrapper', () => {
    const submitButtonSection = source.match(
      /\{\/\* Submit button \*\/\}[\s\S]{0,200}?<Button/,
    )
    expect(submitButtonSection).toBeTruthy()
    const snippet = submitButtonSection![0]
    expect(snippet).not.toContain('&&')
  })
})

describe('ensureShareId returns hasPassword', () => {
  it('return type includes hasPassword', () => {
    expect(source).toContain('Promise<{ shareId: string; hasPassword: boolean }>')
  })

  it('reads has_password or password from share response', () => {
    expect(source).toContain('has_password')
  })
})

describe('effectiveFormFields and effectiveFormConfig', () => {
  it('effectiveFormFields is computed from verifiedFormMeta or formFields', () => {
    expect(source).toContain('effectiveFormFields')
    expect(source).toContain('verifiedFormMeta?.fields')
  })

  it('effectiveFormConfig merges verifiedFormMeta over formConfig', () => {
    expect(source).toContain('effectiveFormConfig')
    expect(source).toContain('{ ...formConfig, ...verifiedFormMeta }')
  })

  it('form fields render uses effectiveFormFields', () => {
    expect(source).toContain('effectiveFormFields.map(field')
  })

  it('cover_url and logo_url use effectiveFormConfig', () => {
    expect(source).toContain('effectiveFormConfig.cover_url')
    expect(source).toContain('effectiveFormConfig.logo_url')
  })
})
