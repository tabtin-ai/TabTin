const STRENGTH_LEVEL_MAP: Record<string, string> = {
  '很弱': 'veryWeak',
  '弱': 'weak',
  '中': 'medium',
  '强': 'strong',
  'very weak': 'veryWeak',
  'very_weak': 'veryWeak',
  'weak': 'weak',
  'medium': 'medium',
  'moderate': 'medium',
  'strong': 'strong',
}

export function resolveStrengthKey(level: string): string | null {
  const trimmed = level.trim()
  return STRENGTH_LEVEL_MAP[trimmed] ?? STRENGTH_LEVEL_MAP[trimmed.toLowerCase()] ?? null
}

const SUGGESTION_KEY_MAP: Record<string, string> = {
  great: 'great',
  addLength: 'addLength',
  moreCharTypes: 'moreCharTypes',
  tooSimple: 'tooSimple',
  useMixedChars: 'useMixedChars',
  wayTooSimple: 'wayTooSimple',
  requireMixedCase: 'requireMixedCase',
  requireDigits: 'requireDigits',
  requireSpecialChars: 'requireSpecialChars',
  minLength8: 'minLength8',
  '密码强度很好！': 'great',
  '建议增加密码长度': 'addLength',
  '建议使用更多字符类型': 'moreCharTypes',
  '密码太简单': 'tooSimple',
  // ：新旧中文建议并存，兼容仍回传旧文案的后端 / 缓存
  '建议包含大写/小写/数字/特殊字符中的至少3种': 'useMixedChars',
  '建议使用大小写字母、数字和特殊字符': 'useMixedChars',
  '密码过于简单': 'wayTooSimple',
  '必须包含大小写字母': 'requireMixedCase',
  '必须包含数字': 'requireDigits',
  '必须包含特殊字符': 'requireSpecialChars',
  '长度至少8位': 'minLength8',
}

export function resolveSuggestionKey(suggestion: string): string | null {
  return SUGGESTION_KEY_MAP[suggestion.trim()] ?? null
}

/**
 * @deprecated  起特殊字符改为「非字母/非数字/非空白」语义，不再用白名单判定。
 * 常量保留供对照旧文档与迁移期引用；新逻辑请用 {@link passwordHasSpecialChar}。
 */
export const PASSWORD_SPECIAL_CHARS = '!@#$%^&*()_+-=[]{}|;:,.<>?'

/**
 * 密码是否包含「特殊字符」——与后端 `validate_user_password` 对齐：
 * Python `not c.isalnum() and not c.isspace()`，即任意非 Unicode 字母/数字且非空白。
 * 因此 `` ` ``、`·`、`~` 等均计入；空格不计入（空白整体另有禁止规则）。
 */
export function passwordHasSpecialChar(password: string): boolean {
  return /[^\p{L}\p{N}\s]/u.test(password)
}

/**
 * 密码是否包含任意空白字符（空格 / Tab / 换行等）。
 *
 * 与后端 `validate_user_password` 的 `any(c.isspace() for c in password)`
 * 口径对齐：设密 / 改密 / 重置一律禁止空白；登录走精确匹配不受此限。
 * 前端各 auth 表单提交前共用此函数，避免各自重复实现导致口径漂移。
 */
export function passwordHasWhitespace(password: string): boolean {
  return /\s/.test(password)
}

/**
 * 从密码里剔除所有空白字符（空格 / Tab / 换行等），返回净化后的值。
 *
 * 用于「设密 / 改密 / 重置」场景的密码输入框 onChange：用户敲入或粘贴空白时
 * 即时过滤，从源头杜绝空白进入密码，而非等到提交才报错。口径与
 * {@link passwordHasWhitespace} 一致（同一套 `\s` 判定）。
 *
 * 注意：登录密码框与「修改密码」里的旧密码框不应调用此函数——存量用户的
 * 密码可能本就含空白，需保留原样精确匹配，否则会导致其无法登录 / 改密。
 */
export function stripPasswordWhitespace(password: string): string {
  return password.replace(/\s/g, '')
}

/**
 * 是否含中日韩汉字（含扩展 A / 兼容区）。
 *
 * ：改密/设密场景禁止把 Agent 报错等中文散文粘进密码框；
 * 与后端 `validate_user_password` 的 CJK 拒绝口径对齐。
 */
export function passwordContainsCjk(password: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(password)
}

export type NewPasswordInputNotice = 'whitespace' | 'cjk' | null

/**
 * 新密码 / 确认密码输入净化（注册、忘记密码、改密共用）：
 * - 剔除空白；若原文含空白 → notice=`whitespace`（调用方提示「已将空格过滤」）
 * - 含汉字 → 清空并 notice=`cjk`（避免报错文案留在密码框）
 */
export function sanitizeNewPasswordInput(raw: string): {
  value: string
  notice: NewPasswordInputNotice
} {
  const hadWhitespace = passwordHasWhitespace(raw)
  const stripped = stripPasswordWhitespace(raw)
  if (passwordContainsCjk(stripped)) {
    return { value: '', notice: 'cjk' }
  }
  return {
    value: stripped,
    notice: hadWhitespace ? 'whitespace' : null,
  }
}

/** 新密码最短长度——与后端 `validate_user_password` 对齐。 */
export const PASSWORD_MIN_LENGTH = 8

/**
 * 新密码最少字符类别数——与后端 SSOT 对齐：
 * 大写 / 小写 / 数字 / 特殊字符 四类中至少命中 {@link PASSWORD_MIN_CHAR_CLASSES} 类。
 * 注意：大小写字母分属两类，故「混合大小写 + 数字」已是 3 类，可合法通过。
 */
export const PASSWORD_MIN_CHAR_CLASSES = 3

/**
 * 统计密码命中的字符类别数（大写 / 小写 / 数字 / 特殊字符），
 * 与后端复杂度口径一致：特殊字符走 {@link passwordHasSpecialChar}，
 * 空白字符不计入任何类别。
 */
export function countPasswordCharClasses(password: string): number {
  const hasUpper = /[A-Z]/.test(password)
  const hasLower = /[a-z]/.test(password)
  const hasDigit = /[0-9]/.test(password)
  const hasSpecial = passwordHasSpecialChar(password)
  return [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length
}

/**
 * 是否满足「至少三类字符」复杂度规则（不含长度 / 空白；调用方自行叠加）。
 * 与后端 `validate_user_password` 的 complexity_count >= 3 口径一致。
 */
export function passwordMeetsCharClassRule(password: string): boolean {
  return countPasswordCharClasses(password) >= PASSWORD_MIN_CHAR_CLASSES
}
