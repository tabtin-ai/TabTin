/**
 * ：query 权威 fetch 发生在 `sessions.set` 之前时，从本轮 pending
 * request 回退解析 `workspaceId`，避免冷启动误把 Workspace grant 夹成
 * `always_ask`。
 */

export function resolvePendingQueryWorkspaceId(
  sessionId: string,
  pendingRequests: Iterable<{ threadId?: string; workspaceId?: string }>,
): string | undefined {
  for (const request of pendingRequests) {
    if (request.threadId !== sessionId) continue
    const workspaceId = request.workspaceId?.trim()
    if (workspaceId) return workspaceId
  }
  return undefined
}
