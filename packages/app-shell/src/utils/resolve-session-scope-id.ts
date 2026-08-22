/**
 * 会话作用域宿主 ID。
 *
 * 终态字段为 `workspace_id`；过渡期 wire 仍可能只带 `space_id` 别名。
 * 两者皆有时优先 `workspace_id`，避免终态与别名不一致时静默打到旧宿主。
 */
export function resolveSessionScopeId(
  session:
    | {
        space_id?: string | null
        workspace_id?: string | null
      }
    | null
    | undefined,
): string | null {
  if (!session) return null
  return session.workspace_id ?? session.space_id ?? null
}
