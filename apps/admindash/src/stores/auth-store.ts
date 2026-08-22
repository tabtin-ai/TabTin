import { authApi } from '@/api/auth'
import type {
  AdminPermissionResponse,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  User,
  VerificationCodeLoginRequest,
} from '@/types/auth'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthState {
  isAuthenticated: boolean
  user: User | null
  adminPermissions: string[] | null
  adminPermissionsLoaded: boolean
  adminRole: string | null
  isLoading: boolean
  error: string | null

  // Actions
  login: (data: LoginRequest) => Promise<void>
  loginWithVerificationCode: (data: VerificationCodeLoginRequest) => Promise<void>
  register: (data: RegisterRequest) => Promise<void>
  sendVerificationCode: (phone: string) => Promise<void>
  loadAdminPermissions: () => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function storeLoginResponse(response: LoginResponse) {
  localStorage.setItem('access_token', response.access_token)
  localStorage.setItem('refresh_token', response.refresh_token)
}

function clearStoredAuthSession() {
  localStorage.removeItem('access_token')
  localStorage.removeItem('refresh_token')
  localStorage.removeItem('user')
  localStorage.removeItem('auth-storage')
}

function hasStoredAuthSession() {
  return Boolean(localStorage.getItem('access_token') || localStorage.getItem('refresh_token'))
}

function normalizeAdminPermissions(response: AdminPermissionResponse) {
  const permissions = response.is_superuser
    ? ['*']
    : Array.isArray(response.permissions)
      ? response.permissions
      : []
  return {
    adminPermissions: permissions,
    adminPermissionsLoaded: true,
    adminRole: response.role || null,
  }
}

function withProjectedSuperuserFlags(
  user: User,
  permissions: ReturnType<typeof normalizeAdminPermissions>
): User {
  const isProjectedSuper =
    permissions.adminPermissions?.includes('*') === true ||
    permissions.adminRole === 'super_admin'
  const hasAdminAccess =
    isProjectedSuper ||
    Boolean(permissions.adminRole) ||
    (Array.isArray(permissions.adminPermissions) &&
      permissions.adminPermissions.length > 0)
  return {
    ...user,
    is_staff: hasAdminAccess,
    is_superuser: isProjectedSuper,
  }
}

async function resolveAdminPermissions() {
  try {
    return normalizeAdminPermissions(await authApi.getAdminPermissions())
  } catch {
    const legacyAdminAccess = await authApi.probeLegacyAdminAccess()
    return {
      adminPermissions: legacyAdminAccess ? ['*'] : [],
      adminPermissionsLoaded: true,
      adminRole: legacyAdminAccess ? 'super_admin' : null,
    }
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      adminPermissions: null,
      adminPermissionsLoaded: false,
      adminRole: null,
      isLoading: false,
      error: null,

      login: async (data) => {
        set({ isLoading: true, error: null })
        try {
          const response = await authApi.login(data)
          storeLoginResponse(response)
          const permissions = await resolveAdminPermissions()
          set({
            isAuthenticated: true,
            user: withProjectedSuperuserFlags(response.user, permissions),
            ...permissions,
            isLoading: false,
          })
        } catch (error: unknown) {
          set({
            isLoading: false,
            error: getErrorMessage(error, 'Login failed'),
          })
          throw error
        }
      },

      loginWithVerificationCode: async (data) => {
        set({ isLoading: true, error: null })
        try {
          const response = await authApi.loginWithVerificationCode(data)
          storeLoginResponse(response)
          const permissions = await resolveAdminPermissions()
          set({
            isAuthenticated: true,
            user: withProjectedSuperuserFlags(response.user, permissions),
            ...permissions,
            isLoading: false,
          })
        } catch (error: unknown) {
          set({
            isLoading: false,
            error: getErrorMessage(error, 'Login failed'),
          })
          throw error
        }
      },

      register: async (data) => {
        set({ isLoading: true, error: null })
        try {
          const response = await authApi.register(data)
          storeLoginResponse(response)
          const permissions = await resolveAdminPermissions()
          set({
            isAuthenticated: true,
            user: withProjectedSuperuserFlags(response.user, permissions),
            ...permissions,
            isLoading: false,
          })
        } catch (error: unknown) {
          set({
            isLoading: false,
            error: getErrorMessage(error, 'Register failed'),
          })
          throw error
        }
      },

      sendVerificationCode: async (phone) => {
        set({ isLoading: true, error: null })
        try {
          await authApi.sendVerificationCode({
            username: phone,
            code_type: 'login',
          })
          set({ isLoading: false })
        } catch (error: unknown) {
          set({
            isLoading: false,
            error: getErrorMessage(error, 'Failed to send verification code'),
          })
          throw error
        }
      },

      loadAdminPermissions: async () => {
        if (!hasStoredAuthSession()) {
          clearStoredAuthSession()
          set({
            isAuthenticated: false,
            user: null,
            adminPermissions: null,
            adminPermissionsLoaded: false,
            adminRole: null,
            isLoading: false,
            error: null,
          })
          return
        }
        const permissions = await resolveAdminPermissions()
        set((state) => ({
          ...permissions,
          user: state.user
            ? withProjectedSuperuserFlags(state.user, permissions)
            : state.user,
        }))
      },

      logout: async () => {
        try {
          // Attempt to call logout API but don't block local logout
          await authApi.logout().catch(() => {})
        } finally {
          clearStoredAuthSession()
          set({
            isAuthenticated: false,
            user: null,
            adminPermissions: null,
            adminPermissionsLoaded: false,
            adminRole: null,
            error: null,
          })
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        user: state.user,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AuthState> | undefined
        if (persisted?.isAuthenticated && !hasStoredAuthSession()) {
          clearStoredAuthSession()
          return currentState
        }
        return {
          ...currentState,
          ...persisted,
        }
      },
    }
  )
)
