import type { LocalMcpCandidateSummary, LocalMcpConnectionSummary } from '@shared/types/mcp'

export type ConnectorLifecycle = 'available' | 'incomplete' | 'ready' | 'needs_repair'

export type ConnectorMarketAction = 'connect' | 'continue' | 'manage' | 'repair'

export interface ConnectorMarketState {
  lifecycle: ConnectorLifecycle
  action: ConnectorMarketAction
  statusLabel: string
  assignedAgentCount: number
}

interface ConnectorMarketStateInput {
  candidate?: LocalMcpCandidateSummary
  connection?: LocalMcpConnectionSummary
  /** 当前页面可管理的 Agent；传入后，历史/跨组织绑定不计入用户可见状态。 */
  manageableAgentIds?: ReadonlySet<string>
}

type SearchableConnector = Pick<
  LocalMcpCandidateSummary,
  'name' | 'source' | 'transportKind' | 'command' | 'args' | 'url' | 'envKeys' | 'headerKeys'
> & {
  description?: string
}

export function getManageableAttachedAgentIds(
  attachedAgentIds: readonly string[],
  manageableAgentIds?: ReadonlySet<string>,
): string[] {
  return manageableAgentIds
    ? attachedAgentIds.filter(agentId => manageableAgentIds.has(agentId))
    : [...attachedAgentIds]
}

/**
 * 计算当前组织可管理范围内的 Agent 绑定增删。
 * 历史 / 跨组织绑定不在 manageableAgentIds 内，保存时必须原样保留，
 * 不能拿完整 attachedAgentIds 与勾选集合做差集。
 */
export function diffManageableAgentAssignments(
  attachedAgentIds: readonly string[],
  selectedAgentIds: ReadonlySet<string>,
  manageableAgentIds: ReadonlySet<string>,
): { additions: string[]; removals: string[] } {
  const initial = new Set(getManageableAttachedAgentIds(attachedAgentIds, manageableAgentIds))
  const selected = [...selectedAgentIds].filter(agentId => manageableAgentIds.has(agentId))
  return {
    additions: selected.filter(agentId => !initial.has(agentId)),
    removals: [...initial].filter(agentId => !selectedAgentIds.has(agentId)),
  }
}

export function matchesConnectorSearch(connector: SearchableConnector, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return true

  return [
    connector.name,
    connector.description,
    connector.source.label,
    connector.transportKind,
    connector.command,
    ...(connector.args ?? []),
    connector.url,
    ...connector.envKeys,
    ...connector.headerKeys,
  ].some(value => value?.toLocaleLowerCase().includes(query))
}

/**
 * 将本机 MCP 的发现记录与连接实例收敛为用户可理解的生命周期。
 * 这是连接器卡片与详情页共同使用的权威读模型；调用方不再用
 * `importedConnectionId` 或按钮文案自行猜测是否可用。
 */
export function getConnectorMarketState({
  candidate,
  connection,
  manageableAgentIds,
}: ConnectorMarketStateInput): ConnectorMarketState {
  if (!connection) {
    return {
      lifecycle: 'available',
      action: 'connect',
      statusLabel: candidate ? '从本机发现' : '可接入',
      assignedAgentCount: 0,
    }
  }

  const assignedAgentCount = getManageableAttachedAgentIds(
    connection.attachedAgentIds,
    manageableAgentIds,
  ).length

  if (connection.requiresAgentSelection) {
    return {
      lifecycle: 'incomplete',
      action: 'continue',
      statusLabel: '待选择 Agent',
      assignedAgentCount,
    }
  }

  if (!connection.enabled) {
    return {
      lifecycle: 'incomplete',
      action: 'continue',
      statusLabel: '已停用',
      assignedAgentCount,
    }
  }

  if (!connection.lastProbe) {
    return {
      lifecycle: 'incomplete',
      action: 'continue',
      statusLabel: '待测试',
      assignedAgentCount,
    }
  }

  if (!connection.lastProbe.ok) {
    return {
      lifecycle: 'needs_repair',
      action: 'repair',
      statusLabel: '连接异常',
      assignedAgentCount,
    }
  }

  if (assignedAgentCount === 0) {
    return {
      lifecycle: 'incomplete',
      action: 'continue',
      statusLabel: '待选择 Agent',
      assignedAgentCount,
    }
  }

  return {
    lifecycle: 'ready',
    action: 'manage',
    statusLabel: '可用',
    assignedAgentCount,
  }
}

/**
 * 货架卸载：本机已有连接实例（已接入）。
 * 未接入 / 即将开放不展示；探测失败走「重新授权」，卡片侧不再并排卸载。
 */
export function canUninstallMarketplaceConnector(
  connection?: Pick<LocalMcpConnectionSummary, 'id'> | null,
  canManage = true,
): boolean {
  return Boolean(canManage && connection)
}

/**
 * 卡片是否并排展示「卸载」。
 * 只跟真正显示「管理」的卡片走：`forceManageAction`（「我的」）或
 * `action === 'manage'`。待测试 / 待选 Agent / 已停用 / 修复旁不展示。
 */
export function shouldShowMarketplaceUninstall({
  hasUninstallHandler,
  hideAction = false,
  preferGhostAction = false,
  actionLabel,
  forceManageAction = false,
  action,
}: {
  hasUninstallHandler: boolean
  hideAction?: boolean
  preferGhostAction?: boolean
  actionLabel?: string
  forceManageAction?: boolean
  action: ConnectorMarketAction
}): boolean {
  if (!hasUninstallHandler || hideAction || preferGhostAction || Boolean(actionLabel)) {
    return false
  }
  return forceManageAction || action === 'manage'
}
