/**
 * 将主进程 wipe 失败码映射为设置页友好文案（禁止透传 EBUSY 等 raw errno）。
 */

export type WipeErrorCode = 'busy' | 'permission' | 'unknown'

export type WipeFailureLike = {
  errorCode?: string
  /** 历史字段：旧 IPC 可能仍带 raw message，仅用于回退归类 */
  error?: string
}

const WIPE_ERROR_CODES = new Set<WipeErrorCode>(['busy', 'permission', 'unknown'])

export function normalizeWipeErrorCode(value: unknown): WipeErrorCode {
  if (typeof value === 'string' && WIPE_ERROR_CODES.has(value as WipeErrorCode)) {
    return value as WipeErrorCode
  }
  if (typeof value !== 'string') return 'unknown'
  const hay = value.toUpperCase()
  if (
    hay.includes('EBUSY') ||
    hay.includes('EAGAIN') ||
    hay.includes('ENOTEMPTY') ||
    hay.includes('RESOURCE BUSY') ||
    hay.includes('LOCKED')
  ) {
    return 'busy'
  }
  if (
    hay.includes('EPERM') ||
    hay.includes('EACCES') ||
    hay.includes('NOT PERMITTED') ||
    hay.includes('ACCESS IS DENIED')
  ) {
    return 'permission'
  }
  return 'unknown'
}

/** busy > permission > unknown，避免多失败时拼出原始错误串 */
export function pickPrimaryWipeErrorCode(failures: WipeFailureLike[]): WipeErrorCode {
  const codes = failures.map((item) =>
    normalizeWipeErrorCode(item.errorCode ?? item.error),
  )
  if (codes.includes('busy')) return 'busy'
  if (codes.includes('permission')) return 'permission'
  return 'unknown'
}

export function resolveCleanupFailureMessage(
  t: (key: string) => string,
  failures: WipeFailureLike[],
  fallback?: string,
): string {
  if (failures.length === 0) {
    return fallback || t('desktopCleanup.errors.unknown')
  }
  const code = pickPrimaryWipeErrorCode(failures)
  return t(`desktopCleanup.errors.${code}`)
}

/** catch 路径：绝不把 Node/IPC raw message 直接给用户 */
export function resolveCleanupCatchMessage(
  t: (key: string) => string,
  error: unknown,
): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = normalizeWipeErrorCode(raw)
  if (code !== 'unknown') {
    return t(`desktopCleanup.errors.${code}`)
  }
  // LEGACY_SHAPE / 其它平台错误：统一 unknown，不透传 code 字符串
  if (/EBUSY|EPERM|EACCES|ENOTEMPTY|LEGACY_SHAPE|EAGAIN/i.test(raw)) {
    return t('desktopCleanup.errors.unknown')
  }
  return t('desktopCleanup.errors.unknown')
}
