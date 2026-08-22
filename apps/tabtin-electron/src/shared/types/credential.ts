/**
 * Credential IPC 交互类型
 * main / preload / renderer 共享，避免三处重复定义。
 */

// ==================== Browser Detection ====================

export interface BrowserProfile {
  name: string
  path: string
  isDefault: boolean
}

export interface DetectedBrowser {
  name: string
  displayName: string
  installed: boolean
  version?: string
  profiles: BrowserProfile[]
}

export interface DetectBrowsersResult {
  success: boolean
  browsers: DetectedBrowser[]
  error?: string
}

// ==================== Cookie Extraction ====================

export interface IPCCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: string
  session?: boolean
  size?: number
}

export interface ExtractCookiesResult {
  success: boolean
  cookies: IPCCookie[]
  browserName: string
  profileName: string
  extractedAt: string
  error?: string
  errorCode?: string
}

// ==================== Password Extraction ====================

export interface ExtractedPassword {
  url: string
  username: string
  password: string
  signon_realm: string
  date_created?: number
}

export interface ExtractPasswordsResult {
  success: boolean
  passwords: ExtractedPassword[]
  browserName?: string
  profileName?: string
  extractedAt?: string
  error?: string
  errorCode?: string
}

// ==================== Partition / Domain Summary ====================

export interface CookieDomainSummary {
  domain: string
  count: number
  hasExpired: boolean
  expiredCount: number
}

export interface PartitionCookieSummary {
  partition: string
  totalCount: number
  domains: CookieDomainSummary[]
}

// ==================== Error Codes ====================

export const CREDENTIAL_ERROR_CODES = {
  UNSUPPORTED_BROWSER: 'UNSUPPORTED_BROWSER',
  COOKIE_DB_MISSING: 'COOKIE_DB_MISSING',
  DECRYPT_KEY_UNAVAILABLE: 'DECRYPT_KEY_UNAVAILABLE',
  PASSWORD_EXTRACT_UNSUPPORTED: 'PASSWORD_EXTRACT_UNSUPPORTED',
} as const

export type CredentialErrorCode = typeof CREDENTIAL_ERROR_CODES[keyof typeof CREDENTIAL_ERROR_CODES]
