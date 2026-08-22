/**
 * Auth 表单的纯校验 / 规范化规则——跨 electron / web 单一口径。
 *
 * 这些函数不依赖 React，可被 hook 或任意逻辑复用；不含任何 UI / store / api。
 * 各端历史上各写一份手机号正则、6 位验证码正则、错误映射，极易漂移；
 * 统一到此处后，改一处全端生效。
 */

/** 中国大陆手机号位数上限 */
export const CN_MOBILE_PHONE_MAX_LENGTH = 11

/** 短信验证码位数上限 */
export const SMS_CODE_MAX_LENGTH = 6

/** 手机号输入：仅保留数字并截断至 11 位（用于 onChange 即时净化） */
export function sanitizeCnMobilePhoneInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, CN_MOBILE_PHONE_MAX_LENGTH)
}

/** 验证码输入：仅保留数字并截断至 6 位（用于 onChange 即时净化） */
export function sanitizeSmsCodeInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, SMS_CODE_MAX_LENGTH)
}

/** 是否为合法中国大陆手机号 */
export function isValidCnPhone(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value.trim())
}

/** 是否为合法 6 位数字验证码 */
export function isValidSmsCode(value: string): boolean {
  return /^\d{6}$/.test(value.trim())
}

/** 全部字段 trim 后非空（用于主按钮 canSubmit 门控的统一判定） */
export function allFilled(...values: string[]): boolean {
  return values.every((value) => value.trim().length > 0)
}

/** Auth 表单使用的最小 i18n 翻译函数签名（与 react-i18next 的 t 兼容） */
export type AuthTranslate = (key: string, options?: Record<string, unknown>) => string

export type AuthFormFeedback =
  | { type: 'i18n'; key: string; options?: Record<string, unknown> }
  | { type: 'message'; message: string }

export function authFeedbackKey(key: string, options?: Record<string, unknown>): AuthFormFeedback {
  return { type: 'i18n', key, options }
}

export function authFeedbackMessage(message: string): AuthFormFeedback {
  return { type: 'message', message }
}

export function resolveAuthFormFeedback(
  feedback: AuthFormFeedback | undefined,
  translate: AuthTranslate,
): string {
  if (!feedback) return ''
  if (feedback.type === 'message') return feedback.message
  return translate(feedback.key, feedback.options)
}

export function resolveAuthFormFeedbacks(
  feedbacks: Record<string, AuthFormFeedback>,
  translate: AuthTranslate,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(feedbacks).map(([field, feedback]) => [
      field,
      resolveAuthFormFeedback(feedback, translate),
    ]),
  )
}

/**
 * 注册场景「手机号已被注册」的多语言/多措辞错误归一化。
 * 后端在不同路径会返回中英文、不同字段名（email/phone、手机号）的措辞，
 * 这里统一收敛到 registerForm.errors.phoneAlreadyRegistered 文案。
 */
export function normalizeRegisterErrorMessage(
  message: string,
  translate: AuthTranslate,
): string {
  const normalized = message.toLowerCase()
  if (normalized.includes('email/phone') && normalized.includes('already registered')) {
    return translate('registerForm.errors.phoneAlreadyRegistered')
  }
  if (message.includes('邮箱/手机号') && message.includes('已被注册')) {
    return translate('registerForm.errors.phoneAlreadyRegistered')
  }
  if (message.includes('手机号') && message.includes('已被注册')) {
    return translate('registerForm.errors.phoneAlreadyRegistered')
  }
  return message
}

export function normalizeRegisterErrorKey(message: string): string | null {
  const normalized = message.toLowerCase()
  if (normalized.includes('email/phone') && normalized.includes('already registered')) {
    return 'registerForm.errors.phoneAlreadyRegistered'
  }
  if (message.includes('邮箱/手机号') && message.includes('已被注册')) {
    return 'registerForm.errors.phoneAlreadyRegistered'
  }
  if (message.includes('手机号') && message.includes('已被注册')) {
    return 'registerForm.errors.phoneAlreadyRegistered'
  }
  return null
}

// ── 邮箱登录入口开关 ──────────────────────────────────────────────────────

/**
 * 解析 VITE_AUTH_EMAIL_LOGIN_ENABLED 环境变量。
 * 去掉空白后小写等于 `false` 才关闭；未设置或其它值都打开。
 */
export function parseEmailLoginEnabled(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() !== 'false'
}

/** 简单邮箱格式校验（至少 local@domain.tld） */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/**
 * 标识符输入即时净化。
 * 开关打开时：含字母或 @ 则保留原样（邮箱输入中，避免 `user` 被剥成空串）；
 * 否则当手机号清洗。开关关闭时：沿用现有 `sanitizeCnMobilePhoneInput`。
 */
export function sanitizeAuthIdentifierInput(
  value: string,
  emailLoginEnabled: boolean,
): string {
  if (!emailLoginEnabled) return sanitizeCnMobilePhoneInput(value)
  if (/[a-zA-Z@]/.test(value)) return value
  return sanitizeCnMobilePhoneInput(value)
}

/**
 * 标识符提交前归一化。
 * 含 @ 则 trim + 小写；否则只 trim（手机号不做大小写变换）。
 */
export function normalizeAuthIdentifier(value: string): string {
  const trimmed = value.trim()
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed
}

/**
 * 标识符合法性校验。
 * 开关关闭时只认大陆手机号；开关打开时含 @ 走邮箱校验，否则走手机号校验。
 */
export function isValidAuthIdentifier(
  value: string,
  emailLoginEnabled: boolean,
): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (emailLoginEnabled && trimmed.includes('@')) return isValidEmail(trimmed)
  return isValidCnPhone(trimmed)
}

/**
 * 注册 payload 字段分流。
 * 含 @ 归入 `email`，否则归入 `phone`。
 */
export function splitRegisterContact(
  value: string,
): { email?: string; phone?: string } {
  const normalized = normalizeAuthIdentifier(value)
  if (normalized.includes('@')) return { email: normalized }
  return { phone: normalized }
}
