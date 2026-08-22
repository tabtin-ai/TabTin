type CommentThreadLoadError = Error & {
  status?: number
  statusCode?: number
  code?: string
}

/** 只有明确表示 route/capability 缺失的错误才允许切到 legacy。 */
export function isCommentThreadsCapabilityMissingError(
  error: unknown,
): boolean {
  if (!(error instanceof Error)) return false
  const typed = error as CommentThreadLoadError
  const status = typed.status ?? typed.statusCode
  const code = (typed.code || '').trim().toUpperCase()
  if (
    code === 'COMMENT_THREADS_CAPABILITY_MISSING' ||
    code === 'COMMENT_THREADS_NOT_SUPPORTED' ||
    code === 'NOT_IMPLEMENTED'
  ) {
    return true
  }
  if (status === 405 || status === 501) return true
  // 旧后端没有注册 route 时 AppHostClient 只能提供通用 HTTP 404；
  // 文档不存在等业务 404 带具体 message/code，不在这里降级。
  return status === 404 && /^HTTP 404$/i.test(error.message.trim())
}
