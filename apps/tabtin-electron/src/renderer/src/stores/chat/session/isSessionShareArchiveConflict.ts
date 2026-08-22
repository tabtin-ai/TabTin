const SHARE_ARCHIVE_HINT = /停止共享|先停止共享|stop sharing|unshare/i

function readConflictStatus(error: {
  statusCode?: unknown
  code?: unknown
  response?: { code?: unknown; status?: unknown }
}): boolean {
  if (error.statusCode === 409 || error.response?.status === 409) return true
  const code = error.code ?? error.response?.code
  return code === 'CONFLICT' || code === 409
}

function readErrorText(error: {
  message?: unknown
  response?: { message?: unknown }
}): string {
  const parts = [error.message, error.response?.message]
  return parts.filter((part): part is string => typeof part === 'string').join(' ')
}

/** 归档 PUT 在仍有 pending/active 共享时返回 409 +「请先停止共享任务再归档」。其它 409 不走停共享弹窗。 */
export function isSessionShareArchiveConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const error = err as {
    statusCode?: unknown
    code?: unknown
    message?: unknown
    response?: { code?: unknown; status?: unknown; message?: unknown }
  }
  return readConflictStatus(error) && SHARE_ARCHIVE_HINT.test(readErrorText(error))
}
