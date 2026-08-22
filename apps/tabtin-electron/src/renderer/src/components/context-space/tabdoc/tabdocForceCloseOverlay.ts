const AUTH_FAILED_CLOSE_CODE = 4001

function isAuthFailedForceClose(forceCloseMessage: unknown): boolean {
  if (!forceCloseMessage || typeof forceCloseMessage !== 'object') return false

  const message = forceCloseMessage as { reason?: unknown; code?: unknown }
  return message.reason === 'auth_failed' || message.code === AUTH_FAILED_CLOSE_CODE
}

export function shouldShowTabDocForceCloseOverlay(
  forceCloseMessage: unknown,
  loadError?: string | null,
): boolean {
  return Boolean(forceCloseMessage) && !loadError && !isAuthFailedForceClose(forceCloseMessage)
}

/**
 * 强关后的重新加载只触发文档重取。
 *
 * retryLoad 会让协作配置短暂失效并销毁旧 Provider，加载完成后再自动创建唯一的新
 * Provider。此处若同时 forceReconnect，旧 Provider 会在 React 提交加载状态前抢先
 * 建连，随后新 Provider 再建一次，造成同一文档稳定占用两条物理连接。
 */
export function reloadTabDocAfterForceClose(retryLoad: () => void): void {
  retryLoad()
}
