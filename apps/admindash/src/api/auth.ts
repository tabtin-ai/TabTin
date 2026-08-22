import type {
  AdminPermissionResponse,
  ApiResponse,
  ForgotPasswordRequest,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  ResetPasswordRequest,
} from '@/types/auth'
import { rawJson } from './raw-json'
import { getApiClient } from './tabtin-client'

export const authApi = {
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const client = getApiClient()
    const { data: result, error } = await client.POST('/auth/login', {
      body: data,
    })
    if (error) throw error
    return result
  },

  loginWithVerificationCode: async (data: {
    username: string
    verification_code: string
    invite_code?: string
    remember_me?: boolean
  }): Promise<LoginResponse> => {
    const client = getApiClient()
    const { data: result, error } = await client.POST('/auth/login/verification-code', {
      body: data,
    })
    if (error) throw error
    return result
  },

  sendVerificationCode: async (data: {
    username: string
    code_type: string
    invite_code?: string
  }): Promise<ApiResponse> => {
    return rawJson<ApiResponse>('POST', '/auth/send-verification-code', data)
  },

  register: async (data: RegisterRequest): Promise<LoginResponse> => {
    const client = getApiClient()
    const { data: result, error } = await client.POST('/auth/register', {
      body: data,
    })
    if (error) throw error
    return result
  },

  forgotPassword: async (data: ForgotPasswordRequest): Promise<ApiResponse> => {
    return rawJson<ApiResponse>('POST', '/auth/forgot-password', data)
  },

  resetPassword: async (data: ResetPasswordRequest): Promise<ApiResponse> => {
    return rawJson<ApiResponse>('POST', '/auth/reset-password', data)
  },

  logout: async (): Promise<ApiResponse> => {
    return rawJson<ApiResponse>('POST', '/auth/logout')
  },

  getAdminPermissions: async (): Promise<AdminPermissionResponse> => {
    return getApiClient().raw<AdminPermissionResponse>('GET', '/auth/admin/me/permissions')
  },

  probeLegacyAdminAccess: async (): Promise<boolean> => {
    try {
      const response = (await getApiClient().raw('GET', '/auth/admin/users', {
        params: { page: 1, page_size: 1 },
        rawResponse: true,
      })) as Response
      return response.ok
    } catch {
      return false
    }
  },

  getProfile: async () => {
    const client = getApiClient()
    const { data: result, error } = await client.GET('/auth/profile')
    if (error) throw error
    return result
  },
}
