/**
 * 导入向导工作目录排序：按最新对话时间倒序（会话列表须已按 updatedAt 倒序）。
 */

export function compareWorkspacesByLatestDesc(
  a: { sessions: Array<{ updatedAt?: string }> },
  b: { sessions: Array<{ updatedAt?: string }> },
): number {
  const aTs = Date.parse(a.sessions[0]?.updatedAt ?? '') || 0
  const bTs = Date.parse(b.sessions[0]?.updatedAt ?? '') || 0
  if (bTs !== aTs) return bTs - aTs
  return b.sessions.length - a.sessions.length
}
