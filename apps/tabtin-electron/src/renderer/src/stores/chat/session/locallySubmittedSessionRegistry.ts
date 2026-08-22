/**
 * 本地已下发用户指令的会话登记。
 *
 * 侧栏不再扫描 `messagesBySessionId`；发送失败后服务端 `message_count` 仍可能为 0，
 * 靠本集合保活。写路径在 send 乐观 patch 旁登记；读路径不订阅消息 store。
 *
 * 不在「乐观 message_count > 0」时 forget——否则 list 回灌 count=0 会丢  保活。
 * 生命周期：pending→真 session 迁移 forget；logout / reset 全清。
 */

const submittedSessionIds = new Set<string>()

export function rememberLocallySubmittedSession(sessionId: string): void {
  const id = sessionId.trim()
  if (id) submittedSessionIds.add(id)
}

export function forgetLocallySubmittedSession(sessionId: string): void {
  submittedSessionIds.delete(sessionId.trim())
}

export function getLocallySubmittedSessionIds(): ReadonlySet<string> {
  return submittedSessionIds
}

/** reset / logout：清全部保活登记（对齐 clearAllFailedMessageEditResend） */
export function clearAllLocallySubmittedSessions(): void {
  submittedSessionIds.clear()
}
