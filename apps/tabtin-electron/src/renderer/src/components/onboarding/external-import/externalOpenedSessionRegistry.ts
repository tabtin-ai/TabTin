/**
 * 外部历史「已展开」会话登记——侧栏保留 / 草稿勿复用空槽。
 * 消息仅本机注入、服务端 message_count 仍为 0，必须靠此集合保活。
 */

export interface ExternalOpenedSessionTarget {
  source: string
  sourceSessionId: string
  title: string
  openedSessionId: string
}

const boundSessions = new Map<string, ExternalOpenedSessionTarget | null>()

export function rememberExternalOpenedSession(
  sessionId: string,
  target?: Omit<ExternalOpenedSessionTarget, 'openedSessionId'>,
): void {
  const id = sessionId.trim()
  if (!id) return
  boundSessions.set(id, target ? { ...target, openedSessionId: id } : boundSessions.get(id) ?? null)
}

export function forgetExternalOpenedSession(sessionId: string): void {
  boundSessions.delete(sessionId.trim())
}

export function syncExternalOpenedSessions(
  targets: Iterable<ExternalOpenedSessionTarget>,
): void {
  boundSessions.clear()
  for (const target of targets) {
    const id = target.openedSessionId.trim()
    if (id) boundSessions.set(id, { ...target, openedSessionId: id })
  }
}

export function isExternalOpenedSession(sessionId: string): boolean {
  return boundSessions.has(sessionId.trim())
}

export function resolveExternalOpenedSession(
  sessionId: string,
): ExternalOpenedSessionTarget | null {
  return boundSessions.get(sessionId.trim()) ?? null
}

export function getExternalOpenedSessionIds(): ReadonlySet<string> {
  return new Set(boundSessions.keys())
}
