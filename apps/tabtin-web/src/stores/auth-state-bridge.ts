import type { UserInfo } from '@/types/auth'

type AuthStateSnapshot = {
  isAuthenticated: boolean
  user: UserInfo | null
}

type AuthStateUpdater = (state: AuthStateSnapshot) => void

let authStateUpdater: AuthStateUpdater | null = null

export function registerAuthStateUpdater(updater: AuthStateUpdater): void {
  authStateUpdater = updater
}

export function updateAuthState(state: AuthStateSnapshot): void {
  authStateUpdater?.(state)
}
