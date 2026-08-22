import { API_ENDPOINTS } from '@tabtin/config'
import { getApiClient } from './api-client'
import type {
  LoginRequest,
  LoginResponse,
  VerificationCodeLoginRequest,
  RegisterRequest,
  SendVerificationCodeRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  PasswordStrength,
  ApiResponse,
  UserInfo,
} from '@/types/auth'

export const authApi = {
  async getProfile(): Promise<UserInfo> {
    return getApiClient().raw<UserInfo>('GET', API_ENDPOINTS.AUTH.PROFILE)
  },

  async login(data: LoginRequest): Promise<LoginResponse> {
    return getApiClient().raw<LoginResponse>('POST', API_ENDPOINTS.AUTH.LOGIN, { body: data })
  },

  async loginWithVerificationCode(data: VerificationCodeLoginRequest): Promise<LoginResponse> {
    return getApiClient().raw<LoginResponse>('POST', API_ENDPOINTS.AUTH.LOGIN_VERIFICATION_CODE, {
      body: data,
    })
  },

  async register(data: RegisterRequest): Promise<LoginResponse> {
    return getApiClient().raw<LoginResponse>('POST', API_ENDPOINTS.AUTH.REGISTER, { body: data })
  },

  async redeemInviteCode(inviteCode: string): Promise<{ user: LoginResponse['user'] }> {
    return getApiClient().raw<{ user: LoginResponse['user'] }>(
      'POST',
      API_ENDPOINTS.AUTH.REDEEM_INVITE_CODE,
      { body: { invite_code: inviteCode } },
    )
  },

  async sendVerificationCode(data: SendVerificationCodeRequest): Promise<ApiResponse> {
    return getApiClient().raw<ApiResponse>('POST', API_ENDPOINTS.VERIFICATION.SEND_CODE, { body: data })
  },

  async forgotPassword(data: ForgotPasswordRequest): Promise<ApiResponse> {
    return getApiClient().raw<ApiResponse>('POST', API_ENDPOINTS.PASSWORD.FORGOT, { body: data })
  },

  async resetPassword(data: ResetPasswordRequest): Promise<ApiResponse> {
    return getApiClient().raw<ApiResponse>('POST', API_ENDPOINTS.PASSWORD.RESET, { body: data })
  },

  async checkPasswordStrength(password: string): Promise<PasswordStrength> {
    return getApiClient().raw<PasswordStrength>('GET', API_ENDPOINTS.PASSWORD.STRENGTH, {
      params: { password },
    })
  },

  async logout(): Promise<void> {
    try {
      await getApiClient().raw('POST', API_ENDPOINTS.AUTH.LOGOUT)
    } catch {
      // 登出失败不阻断本地清理
    }
  },
}
