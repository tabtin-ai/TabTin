/**
 * Auth 表单共享逻辑（hooks + 纯规则）——跨 electron / web 单一口径。
 *
 * 注意：本模块的 hooks 依赖 React，**只能** 经 `@tabtin/shared/auth-forms` 子路径导入，
 * 绝不从顶层 `@tabtin/shared` index 再导出（否则 main 进程 import 顶层 barrel 时会连带
 * 加载 react，packaged app 里 main 无 react 依赖会 ERR_MODULE_NOT_FOUND，启动崩溃；
 * 与 use-countdown 同样的约束）。
 */
export {
  CN_MOBILE_PHONE_MAX_LENGTH,
  SMS_CODE_MAX_LENGTH,
  sanitizeCnMobilePhoneInput,
  sanitizeSmsCodeInput,
  isValidCnPhone,
  isValidSmsCode,
  allFilled,
  normalizeRegisterErrorMessage,
  parseEmailLoginEnabled,
  isValidEmail,
  sanitizeAuthIdentifierInput,
  normalizeAuthIdentifier,
  isValidAuthIdentifier,
  splitRegisterContact,
  type AuthTranslate,
} from './rules.js'
export { useLoginForm } from './use-login-form.js'
export type { LoginUiMethod, UseLoginFormDeps, UseLoginFormResult } from './use-login-form.js'
export { useRegisterForm } from './use-register-form.js'
export type { UseRegisterFormDeps, UseRegisterFormResult } from './use-register-form.js'
export { useForgotPasswordForm } from './use-forgot-password-form.js'
export type {
  UseForgotPasswordFormDeps,
  UseForgotPasswordFormResult,
} from './use-forgot-password-form.js'
