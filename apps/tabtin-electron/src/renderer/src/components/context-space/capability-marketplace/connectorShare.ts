/**
 * 组织精选匹配 / 展示合并（renderer）。
 * 创建 payload 纯函数见 `@shared/mcp/org-share-payload`（main 共享用）。
 */

import type { LocalMcpConnectionDetail, LocalMcpConnectionSummary } from '@shared/types/mcp'
import type { OrgMcpConnection, OrgMcpConnectionCreatePayload } from '@/services/mcpApi'
import { buildOrgSharePayloadFromHttpDetail as buildOrgSharePayloadFromHttpDetailShared } from '@shared/mcp/org-share-payload'

export { assertHttpShareable } from '@shared/mcp/org-share-payload'

export function buildOrgSharePayloadFromHttpDetail(
  detail: LocalMcpConnectionDetail,
): OrgMcpConnectionCreatePayload {
  return buildOrgSharePayloadFromHttpDetailShared(detail) as OrgMcpConnectionCreatePayload
}

/** 用 endpoint 优先、名称兜底，判断本机连接是否已出现在组织精选。 */
export function findOrgShareForLocalConnection(
  connection: Pick<LocalMcpConnectionSummary, 'name' | 'transportKind' | 'url'>,
  orgConnections: readonly OrgMcpConnection[],
): OrgMcpConnection | null {
  if (connection.transportKind !== 'http') return null
  const url = connection.url?.trim()
  if (url) {
    const byEndpoint = orgConnections.find(item => item.endpoint?.trim() === url)
    if (byEndpoint) return byEndpoint
  }
  const name = connection.name.trim()
  if (!name) return null
  return orgConnections.find(item => item.name.trim() === name) ?? null
}

/**
 * 共享前对照组织精选：连接名称（标识）或 endpoint 已存在则禁止分享。
 * 连接器无独立 slug，组织内唯一维度是 name + endpoint。
 */
export function findOrgConnectionShareConflict(
  connection: Pick<LocalMcpConnectionSummary, 'name' | 'transportKind' | 'url'>,
  orgConnections: readonly OrgMcpConnection[],
): { kind: 'name' | 'endpoint'; value: string } | null {
  if (connection.transportKind !== 'http') return null
  const name = connection.name.trim()
  if (name) {
    const byName = orgConnections.find(item => item.name.trim() === name)
    if (byName) return { kind: 'name', value: name }
  }
  const url = connection.url?.trim()
  if (url) {
    const byEndpoint = orgConnections.find(item => item.endpoint?.trim() === url)
    if (byEndpoint) return { kind: 'endpoint', value: url }
  }
  return null
}

/** 组织精选 → 本机「我的」同源连接（分享者本机常见）。 */
export function findMatchingMineConnectionForOrg(
  orgConnection: Pick<OrgMcpConnection, 'name' | 'endpoint'>,
  mineConnections: readonly LocalMcpConnectionSummary[],
): LocalMcpConnectionSummary | null {
  const endpoint = orgConnection.endpoint?.trim()
  if (endpoint) {
    const byEndpoint = mineConnections.find(
      item => item.transportKind === 'http' && item.url?.trim() === endpoint,
    )
    if (byEndpoint) return byEndpoint
  }
  const name = orgConnection.name.trim()
  if (!name) return null
  return mineConnections.find(item => item.name.trim() === name) ?? null
}

/**
 * 「我的」展示所有已经落到本机的连接，包括从组织精选接入的镜像。
 * 若分享者本机同时保留同源原件与旧镜像，只展示原件，避免重复卡片。
 */
export function selectMineShelfConnections(
  connections: readonly LocalMcpConnectionSummary[],
): LocalMcpConnectionSummary[] {
  const localConnections = connections.filter(item => item.source.kind !== 'organization')
  return connections.filter(connection => {
    if (connection.source.kind !== 'organization') return true
    return findMatchingMineConnectionForOrg(
      {
        name: connection.name,
        endpoint: connection.transportKind === 'http' ? (connection.url ?? '') : '',
      },
      localConnections,
    ) == null
  })
}

/**
 * 新记录只用服务端创建者判断；迁移前的空值记录才回退本机同源匹配，
 * 让存量分享者仍可取消分享，同时避免新记录被同名 / 同 endpoint 误认领。
 */
export function isOrgConnectionSharedByCurrentUser(
  orgConnection: Pick<OrgMcpConnection, 'created_by_user_id' | 'name' | 'endpoint'>,
  currentUserId: string | number | null | undefined,
  legacyMineConnections: readonly LocalMcpConnectionSummary[] = [],
): boolean {
  if (orgConnection.created_by_user_id) {
    if (currentUserId == null) return false
    return String(orgConnection.created_by_user_id) === String(currentUserId)
  }
  return findMatchingMineConnectionForOrg(orgConnection, legacyMineConnections) != null
}

/** 组织精选详情「取消分享」只属于实际分享者。 */
export function canCurrentUserUnshareOrgConnection(input: {
  canManage: boolean
  isPersonalOrganization: boolean
  organizationId: string | null | undefined
  orgConnection: Pick<OrgMcpConnection, 'created_by_user_id' | 'name' | 'endpoint'>
  currentUserId: string | number | null | undefined
  mineConnections: readonly LocalMcpConnectionSummary[]
}): boolean {
  if (!input.canManage || !input.organizationId || input.isPersonalOrganization) return false
  return isOrgConnectionSharedByCurrentUser(
    input.orgConnection,
    input.currentUserId,
    input.mineConnections,
  )
}

/** 展示用：合并同源本机连接与组织镜像的 Agent 绑定，避免「我的 / 组织精选」状态分叉。 */
export function mergeAttachedAgentIdsForDisplay(
  primary: LocalMcpConnectionSummary,
  secondary?: LocalMcpConnectionSummary | null,
): LocalMcpConnectionSummary {
  if (!secondary) return primary
  const attachedAgentIds = Array.from(new Set([
    ...primary.attachedAgentIds,
    ...secondary.attachedAgentIds,
  ]))
  return {
    ...primary,
    attachedAgentIds,
    // 任一侧仍要求重选时，展示侧也提示不完整
    requiresAgentSelection:
      primary.requiresAgentSelection || secondary.requiresAgentSelection,
  }
}
