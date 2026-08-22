/**
 * ：本地更长正文包着服务端 display（非截断前缀）→ 应以 DB 可见正文为准。
 *
 * - 截断：server 是 local 前缀（text_summary 前 200 字）→ 仍取更长本地。
 * - Tracker：local 是 `## 任务\\n{指令}\\n引导语`，server 是纯指令 → 取服务端。
 */
export function preferServerDisplayContent(
  localContent: string,
  serverContent: string,
): boolean {
  if (!serverContent || !localContent) return false
  if (localContent.length <= serverContent.length) return false
  if (localContent.startsWith(serverContent)) return false
  return localContent.includes(serverContent)
}
