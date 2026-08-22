import type {
  UserInfo,
  LoginRequest,
  VerificationCodeLoginRequest as SharedVerificationCodeLoginRequest,
  RegisterRequest as SharedRegisterRequest,
  RegisterResponse,
  LoginResponse,
  RefreshTokenResponse,
  SendVerificationCodeRequest as SharedSendVerificationCodeRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  PasswordStrength,
  ApiResponse,
  VerificationCodeType,
  LoginMethod,
} from '@tabtin/shared'

export type {
  UserInfo,
  LoginRequest,
  RegisterResponse,
  LoginResponse,
  RefreshTokenResponse,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  PasswordStrength,
  ApiResponse,
  VerificationCodeType,
  LoginMethod,
}

export interface VerificationCodeLoginRequest extends SharedVerificationCodeLoginRequest {
  invite_code?: string
}

export interface RegisterRequest extends SharedRegisterRequest {
  invite_code?: string
}

export interface SendVerificationCodeRequest extends SharedSendVerificationCodeRequest {
  invite_code?: string
}

export interface PasswordChangeRequest {
  old_password: string
  new_password: string
}

export interface CurrentUserPasswordResetRequest {
  verification_code: string
  new_password: string
}

export interface UserProfileUpdateRequest {
  nickname?: string
  username?: string
  bio?: string
  /** @deprecated 后端已改为 avatar_file_id；保留仅为兼容旧调用 */
  avatar?: string
  avatar_file_id?: string
}

export interface UserProfileSettings {
  is_public_profile: boolean
  allow_email_notifications: boolean
  allow_sms_notifications: boolean
  timezone: string
  language: 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR' | 'de-DE' | 'fr-FR' | 'es-ES' | 'system' | null
  theme: 'light' | 'dark' | 'auto'
  homepage_template: string
  max_collections: number
}

export interface UserProfileSettingsUpdateRequest {
  is_public_profile?: boolean
  allow_email_notifications?: boolean
  allow_sms_notifications?: boolean
  timezone?: string
  language?: 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR' | 'de-DE' | 'fr-FR' | 'es-ES' | 'system'
  theme?: 'light' | 'dark' | 'auto'
  homepage_template?: string
  max_collections?: number
}

export interface EmailVerificationRequest {
  email: string
  verification_code: string
}

export interface BindEmailSendRequest {
  email: string
}

export interface BindEmailRequest {
  email: string
  verification_code: string
}

export interface PhoneVerificationRequest {
  phone: string
  verification_code: string
}

export interface UserSession {
  id: string
  session_type: 'web' | 'mobile' | 'api'
  ip_address: string
  user_agent: string
  device_info: {
    browser?: string
    os?: string
    device?: string
  }
  created_at: string
  last_activity: string
  expires_at: string
  is_active: boolean
}

export type AuthPhase = 'initializing' | 'authenticated' | 'unauthenticated'

export type LogoutReason =
  | 'manual'
  | 'token_expired'
  | 'token_refresh_failed'
  | 'session_revoked'
  | 'centrifugo_auth_failed'
  | 'gateway_auth_failed'
  | 'account_disabled'
  | 'force_logout'
  | 'password_changed'
  // Wave 3: WS gateway auth 失败（JWT 过期 / 被主动 revoke）由 WS 协议层触发
  | 'ws_auth_failed'
  // Wave 3: 用户被移出所有 organization，强制登出
  | 'organization_removed_from_all'

export interface AuthState {
  authPhase: AuthPhase
  user: UserInfo | null
  accessToken: string | null
  refreshToken: string | null
  isLoading: boolean
  error: string | null
  logoutReason: LogoutReason | null
}
