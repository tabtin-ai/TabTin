/**
 * ：USER 画像拉取契约（纯函数，供 assembly 与单测共用）。
 *
 * 后端 GET /user-portrait/me/{org} 缺 agent_id 时 fail-close 空画像；
 * host 必须显式带执行 Agent，缓存按 org::agent 分槽。
 */

export type UserPortraitFetchScope = {
  orgId: string
  agentId: string
}

/** 缺 org / agent 时返回 null（调用方不得发请求）。 */
export function resolveUserPortraitFetchScope(
  organizationId: string | undefined | null,
  agentId?: string | null,
): UserPortraitFetchScope | null {
  const orgId = (organizationId || '').trim()
  const aid = (agentId || '').trim()
  if (!orgId || !aid) return null
  return { orgId, agentId: aid }
}

export function buildUserPortraitCacheKey(orgId: string, agentId: string): string {
  return `${orgId}::${agentId}`
}

/** 拼进 `/user-portrait/me/{org}?…` 的 query（含 agent_id）。 */
export function buildUserPortraitMeQuery(agentId: string): string {
  return new URLSearchParams({ agent_id: agentId }).toString()
}
