export interface User {
  id: string
  username: string
  email?: string
  phone?: string
  avatar?: string
  nickname?: string
  is_staff?: boolean
  is_superuser?: boolean
  role?: 'admin' | 'operator' | 'user'
}

export interface AdminPermissionResponse {
  role: string
  roles?: string[]
  permissions: string[]
  assigned_permissions?: string[]
  is_superuser: boolean
}

export interface LoginResponse {
  access_token: string
  refresh_token: string
  user: User
  expires_in?: number
}

export interface LoginRequest {
  username: string
  password: string
  remember_me?: boolean
}

export interface VerificationCodeLoginRequest {
  username: string // Phone number
  verification_code: string
  invite_code?: string
  remember_me?: boolean
}

export interface RegisterRequest {
  email?: string
  phone?: string
  password: string
  nickname?: string
  username?: string
  verification_code: string
  invite_code?: string
}

export interface ForgotPasswordRequest {
  username: string
}

export interface ResetPasswordRequest {
  username: string
  verification_code: string
  new_password: string
}

export interface SendVerificationCodeRequest {
  username: string
  code_type: 'login' | 'register' | 'reset_password' | 'phone_reservation'
  invite_code?: string
}

export interface ApiResponse<T = unknown> {
  success: boolean
  message?: string
  data?: T
  code?: number
}
