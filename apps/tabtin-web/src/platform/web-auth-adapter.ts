import type { AuthAdapter, AuthSnapshot } from '@tabtin/platform-adapter'

const STORAGE_KEYS = {
  ACCESS_TOKEN: 'tabtin_access_token',
  REFRESH_TOKEN: 'tabtin_refresh_token',
  EXPIRES_AT: 'tabtin_expires_at',
  USER: 'tabtin_user',
} as const

function parseJwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const decoded = JSON.parse(atob(payload))
    return typeof decoded.exp === 'number' ? decoded.exp : null
  } catch {
    return null
  }
}

export function createWebAuthAdapter(): AuthAdapter {
  return {
    async getSnapshot(): Promise<AuthSnapshot> {
      const accessToken = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)
      const refreshToken = localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN)
      const expiresAtStr = localStorage.getItem(STORAGE_KEYS.EXPIRES_AT)
      const userStr = localStorage.getItem(STORAGE_KEYS.USER)

      let user: unknown = null
      if (userStr) {
        try { user = JSON.parse(userStr) } catch { /* corrupted user data */ }
      }

      return {
        accessToken,
        refreshToken,
        expiresAt: expiresAtStr ? Number(expiresAtStr) : null,
        user,
      }
    },

    async save(snapshot: AuthSnapshot) {
      if (snapshot.accessToken) {
        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, snapshot.accessToken)
      } else {
        localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN)
      }

      if (snapshot.refreshToken) {
        localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, snapshot.refreshToken)
      } else {
        localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN)
      }

      if (snapshot.expiresAt != null) {
        localStorage.setItem(STORAGE_KEYS.EXPIRES_AT, String(snapshot.expiresAt))
      } else if (snapshot.accessToken) {
        const exp = parseJwtExp(snapshot.accessToken)
        if (exp) {
          localStorage.setItem(STORAGE_KEYS.EXPIRES_AT, String(exp))
        }
      }

      if (snapshot.user) {
        localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(snapshot.user))
      } else {
        localStorage.removeItem(STORAGE_KEYS.USER)
      }
    },

    async clear() {
      for (const key of Object.values(STORAGE_KEYS)) {
        localStorage.removeItem(key)
      }
    },

    async isTokenExpiringSoon(bufferMinutes: number): Promise<boolean> {
      const expiresAtStr = localStorage.getItem(STORAGE_KEYS.EXPIRES_AT)
      if (!expiresAtStr) {
        const token = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)
        if (!token) return true
        const exp = parseJwtExp(token)
        if (!exp) return false
        const nowSec = Math.floor(Date.now() / 1000)
        return exp - nowSec < bufferMinutes * 60
      }

      const expiresAt = Number(expiresAtStr)
      const nowSec = Math.floor(Date.now() / 1000)
      return expiresAt - nowSec < bufferMinutes * 60
    },
  }
}

export { STORAGE_KEYS }
