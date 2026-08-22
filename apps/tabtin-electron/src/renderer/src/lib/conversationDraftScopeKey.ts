/**
 * opaque conversation draft scope key 纯构造（无 store / 无 React 依赖）。
 *
 * 供 draft episode adapter 与 layout 共用，避免 store → components/layout → store 成环。
 */

function normalizeScopePart(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

/** 草稿态 conversation scope key（尚无 sessionId）。 */
export function buildConversationDraftScopeKey(
  opaqueHostPart?: string | null,
): string {
  return `conversation:draft:${normalizeScopePart(opaqueHostPart, 'unbound')}`
}

export function isConversationDraftScopeKey(value: string | null | undefined): boolean {
  return Boolean(value?.startsWith('conversation:draft:'))
}

/** 当前会话 scope（已有 sessionId），与 draft scope 互斥。 */
export function isConversationSessionScopeKey(value: string | null | undefined): boolean {
  if (!value?.startsWith('conversation:')) return false
  return !value.startsWith('conversation:draft:')
}
