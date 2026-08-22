/**
 * ：编辑并重发 — 保留 failed 气泡，登记待复用的 client message id。
 * Composer 下一次 send 取出后走同一 existingClientMessageId 前门禁。
 */

const pendingBySessionId = new Map<string, string>()

export function armFailedMessageEditResend(
  sessionId: string,
  messageId: string,
): void {
  pendingBySessionId.set(sessionId, messageId)
}

export function takeFailedMessageEditResend(
  sessionId: string | null | undefined,
): string | undefined {
  if (!sessionId) return undefined
  const id = pendingBySessionId.get(sessionId)
  if (!id) return undefined
  pendingBySessionId.delete(sessionId)
  return id
}

export function clearFailedMessageEditResend(
  sessionId: string | null | undefined,
): void {
  if (!sessionId) return
  pendingBySessionId.delete(sessionId)
}

/** reset / logout：清全部编辑重发登记 */
export function clearAllFailedMessageEditResend(): void {
  pendingBySessionId.clear()
}

export function __resetFailedMessageEditResendForTests(): void {
  clearAllFailedMessageEditResend()
}
