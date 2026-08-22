import type { UserInfo } from '@/types/auth'
import i18n from '@/i18n'

interface PersistAuthTokensParams {
  accessToken: string | null
  refreshToken: string | null
  userInfo?: UserInfo | null
  expiresIn?: number | null
  expiresAt?: number | null
}

// ── 内部认证回调通道 ──────────────────────────────────────
// 替代 DOM CustomEvent，避免 token 明文暴露在 window 事件中。
// 回调通过 JS 闭包传递数据，外部脚本/扩展无法拦截。

export interface AuthTokensSyncedPayload {
  accessToken: string
  refreshToken: string
  user?: UserInfo | null
}

type AuthSyncHandler = (payload: AuthTokensSyncedPayload) => void
type AuthLogoutHandler = (reason: string) => void

let _syncHandler: AuthSyncHandler | null = null
let _logoutHandler: AuthLogoutHandler | null = null

export function setAuthSyncHandler(handler: AuthSyncHandler): void {
  _syncHandler = handler
}

export function setAuthLogoutHandler(handler: AuthLogoutHandler): void {
  _logoutHandler = handler
}

export function notifyTokensSynced(payload: AuthTokensSyncedPayload): void {
  _syncHandler?.(payload)
}

export function notifyLogoutRequired(reason: string): void {
  _logoutHandler?.(reason)
}

// ── Token 持久化 ──────────────────────────────────────────

/**
 * 将最新的认证数据写入安全存储（Keychain via IPC）。
 * 不再广播 DOM CustomEvent，消除 token 明文泄露风险。
 */
export async function persistAuthTokens(params: PersistAuthTokensParams): Promise<number | null> {
  const {
    accessToken,
    refreshToken,
    userInfo = null,
    expiresIn,
    expiresAt
  } = params

  if (typeof window === 'undefined' || !window.tabtin?.auth) {
    throw new Error(i18n.t('common:errors.authUnavailable'))
  }

  const resolvedExpiresAt =
    typeof expiresAt === 'number'
      ? expiresAt
      : typeof expiresIn === 'number'
        ? Date.now() + expiresIn * 1000
        : null

  await window.tabtin.auth.save(accessToken, refreshToken, userInfo, resolvedExpiresAt ?? null)

  return resolvedExpiresAt ?? null
}
