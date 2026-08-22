/** 中国大陆手机号位数上限 */
export const CN_MOBILE_PHONE_MAX_LENGTH = 11

/** 手机号输入：仅保留数字并截断至 11 位 */
export function sanitizeCnMobilePhoneInput(value: string): string {
  return value.replace(/\D/g, '').slice(0, CN_MOBILE_PHONE_MAX_LENGTH)
}
