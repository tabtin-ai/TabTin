import type { Cookie } from '../../types/cookies'
import type { ExtractedPassword } from '../../../shared/types/credential'

export type {
  BrowserProfile,
  DetectedBrowser,
  CookieDomainSummary,
  PartitionCookieSummary,
  ExtractedPassword,
  CredentialErrorCode,
} from '../../../shared/types/credential'
export { CREDENTIAL_ERROR_CODES } from '../../../shared/types/credential'

export interface ExtractOptions {
  domains?: string[]
  includeExpired?: boolean
}

export interface ExtractResult {
  success: boolean
  cookies: Cookie[]
  browserName: string
  profileName: string
  extractedAt: string
  error?: string
  errorCode?: string
}

export interface ICookieExtractor {
  extract(profilePath: string, options?: ExtractOptions): Promise<ExtractResult>
}

export interface PasswordExtractResult {
  success: boolean
  passwords: ExtractedPassword[]
  browserName: string
  profileName: string
  extractedAt: string
  error?: string
  errorCode?: string
}

export interface IPasswordExtractor {
  extractPasswords(profilePath: string): Promise<PasswordExtractResult>
}
