/**
 * Signals that token refresh is delegated to another process
 * (e.g., Electron main process holds the real refresh token).
 */
export interface DelegatedRefresh {
  readonly delegateToMain: true
}

/**
 * Refresh could not be completed for a transient reason (offline, timeout,
 * server unavailable). Callers must preserve the local session and surface
 * the original request failure instead of treating credentials as revoked.
 */
export class RefreshTemporarilyUnavailableError extends Error {
  constructor(message = 'Token refresh temporarily unavailable') {
    super(message)
    this.name = 'RefreshTemporarilyUnavailableError'
  }
}

export function isRefreshTemporarilyUnavailableError(
  value: unknown,
): value is RefreshTemporarilyUnavailableError {
  return value instanceof RefreshTemporarilyUnavailableError
}

export function isDelegatedRefresh(v: unknown): v is DelegatedRefresh {
  return typeof v === 'object' && v !== null && (v as any).delegateToMain === true
}

export interface RefreshConfig {
  getRefreshToken: () => string | DelegatedRefresh | null | Promise<string | DelegatedRefresh | null>
  onRefreshToken: (
    refreshToken: string | null,
  ) => Promise<{ access_token: string; refresh_token: string } | null>
}

/**
 * Concurrent-safe refresh lock shared between OpenAPI middleware and raw().
 *
 * When multiple requests receive 401 simultaneously, only one actual
 * refresh call is made. All waiters share the same promise.
 */
export class RefreshLock {
  private _promise: Promise<string | null> | null = null

  constructor(private config: RefreshConfig) {}

  acquire(): Promise<string | null> {
    if (!this._promise) {
      this._promise = this._doRefresh().finally(() => {
        this._promise = null
      })
    }
    return this._promise
  }

  private async _doRefresh(): Promise<string | null> {
    const rt = await this.config.getRefreshToken()
    if (!rt) return null
    const tokenArg = isDelegatedRefresh(rt) ? null : rt
    const result = await this.config.onRefreshToken(tokenArg)
    return result?.access_token ?? null
  }
}
