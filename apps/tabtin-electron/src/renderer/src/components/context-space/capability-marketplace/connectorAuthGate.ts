import type { LocalMcpConnectionSummary } from '@shared/types/mcp'
import {
  connectorIsOAuthReady,
  connectorNeedsCredentialForm,
  type RecommendedConnectorCatalogEntry,
} from './recommendedConnectorCatalog'

export type PendingAgentAssignments = {
  additions: string[]
  removals: string[]
}

export type ConnectorAuthGateKind = 'oauth' | 'api_key' | 'app_credentials' | null

/**
 * 保存「配置给 Agent」前是否需要先过外部授权 / 填凭证闸门。
 * 规则：推荐货架连接且尚未探测成功（或探测失败）时拦截。
 */
export function resolveConnectorAuthGate(input: {
  connection: LocalMcpConnectionSummary
  catalogEntry?: RecommendedConnectorCatalogEntry | null
}): ConnectorAuthGateKind {
  const { connection, catalogEntry } = input
  if (!catalogEntry) return null
  if (connection.lastProbe?.ok) return null
  if (connectorIsOAuthReady(catalogEntry)) return 'oauth'
  if (catalogEntry.authKind === 'app_credentials') return 'app_credentials'
  if (connectorNeedsCredentialForm(catalogEntry)) return 'api_key'
  return null
}

export function pendingAssignmentsAreEmpty(
  pending?: PendingAgentAssignments | null,
): boolean {
  if (!pending) return true
  return pending.additions.length === 0 && pending.removals.length === 0
}
