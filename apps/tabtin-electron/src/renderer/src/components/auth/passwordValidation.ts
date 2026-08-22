import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en'
import {
  passwordContainsCjk,
  passwordHasWhitespace,
  passwordMeetsCharClassRule,
  PASSWORD_MIN_LENGTH,
} from '@tabtin/shared'

zxcvbnOptions.setOptions({
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
})

type Translate = (key: string, options?: Record<string, unknown>) => string

export function getResetPasswordLocalError(password: string, t: Translate): string | null {
  if (!password.trim()) {
    return t('forgotForm.errors.newPasswordRequired')
  }
  if (passwordContainsCjk(password)) {
    return t('forgotForm.errors.newPasswordNoCjk')
  }
  if (passwordHasWhitespace(password)) {
    return t('forgotForm.errors.newPasswordNoWhitespace')
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return t('forgotForm.errors.newPasswordTooShort')
  }
  if (!passwordMeetsCharClassRule(password)) {
    return t('forgotForm.errors.newPasswordNotComplex')
  }
  if (zxcvbn(password).score < 3) {
    return t('forgotForm.errors.newPasswordWeak')
  }
  return null
}
