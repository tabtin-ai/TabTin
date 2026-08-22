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

export function getDisplayName(user: UserInfo | null | undefined, fallback = 'User'): string {
  return user?.nickname || user?.username || user?.email || fallback
}
