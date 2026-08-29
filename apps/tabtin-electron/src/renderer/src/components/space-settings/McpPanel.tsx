import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes,
  Check,
  Copy,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Plug,
  Users,
  X,
  AlertCircle,
  ExternalLink,
} from 'lucide-react'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
  StatusNotice,
  Switch,
  Textarea,
  VisuallyHidden,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import type {
  LocalMcpCandidateSummary,
  LocalMcpConnectionDetail,
  LocalMcpConnectionSummary,
  LocalMcpManualConnectionInput,
  LocalMcpProbeSummary,
  LocalMcpTransportConfig,
} from '@shared/types/mcp'
import { parseMcpError } from '@shared/types/mcp'
import { parseMcpConfigEntries } from '@shared/mcp/parse-mcp-config'
import { AgentApiService, type Agent } from '@tabtin/app-shell'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { SETTINGS_CONTROL_SM, SETTINGS_GROUP_LABEL } from '@components/settings/settingsUi'
import { SettingsPanelLayout } from '@components/settings/SettingsPanelLayout'
import { SettingsPanelHeader } from '@components/settings/SettingsPanelHeader'
import { SettingsSectionCard } from '@components/settings/SettingsSectionCard'
import { cn } from '@utils/cn'
import { useMcpPanelData } from '@components/space-settings/hooks/useMcpPanelData'
import { useMcpActions } from '@components/space-settings/hooks/useMcpActions'
import {
  canUninstallMarketplaceConnector,
  diffManageableAgentAssignments,
  getConnectorMarketState,
  getManageableAttachedAgentIds,
  shouldShowMarketplaceUninstall,
  matchesConnectorSearch,
  type ConnectorLifecycle,
  type ConnectorMarketState,
} from '@components/context-space/capability-marketplace/connectorMarketState'
import {
  resolveConnectorAuthGate,
  type PendingAgentAssignments,
} from '@components/context-space/capability-marketplace/connectorAuthGate'
import {
  authorizeHostHintFromCatalogTransport,
  ConnectorOAuthAuthorizeDialog,
  type ConnectorOAuthDialogStep,
} from '@components/context-space/capability-marketplace/ConnectorOAuthAuthorizeDialog'
import { ConnectorCredentialDialog } from '@components/context-space/capability-marketplace/ConnectorCredentialDialog'
import { ConnectorVendorGateDialog } from '@components/context-space/capability-marketplace/ConnectorVendorGateDialog'
import {
  applyAppCredentialsToTransport,
  applyBearerTokenToTransport,
  applyCredentialSecretToTransport,
} from '@components/context-space/capability-marketplace/connectorCredentialTransport'
import {
  connectorIsOAuthReady,
  connectorIsOAuthVendorGated,
  connectorIsPlatformOAuth,
  connectorNeedsCredentialForm,
  findConnectionForRecommendedConnector,
  findRecommendedCatalogEntryForConnection,
  getRecommendedConnectorById,
  resolveRecommendedCredentialUrl,
  RECOMMENDED_CONNECTOR_CATALOG,
  type RecommendedConnectorCatalogEntry,
} from '@components/context-space/capability-marketplace/recommendedConnectorCatalog'
import {
  ConnectorBrandIcon,
  brandIconQueryFromConnection,
  brandIconQueryFromRecommended,
} from './ConnectorBrandIcon'
import type { ConnectorBrandIconQuery } from '@tabtin/connector-brand-icons'
import {
  runGitHubConnectorOAuth,
  shouldUseGitHubPatFallback,
} from '@components/context-space/capability-marketplace/githubConnectorOAuth'
import { MarketplaceCardText } from '@components/context-space/capability-marketplace/MarketplaceCardText'
import {
  canCurrentUserUnshareOrgConnection,
  findMatchingMineConnectionForOrg,
  findOrgShareForLocalConnection,
  findOrgConnectionShareConflict,
  isOrgConnectionSharedByCurrentUser,
  mergeAttachedAgentIdsForDisplay,
  selectMineShelfConnections,
} from '@components/context-space/capability-marketplace/connectorShare'
import { resolveOrgMarketEmptyKind } from '@components/context-space/capability-marketplace/orgMarketEmptyState'
import {
  ORG_MARKET_CATALOG_POLL_MS,
  shouldRefreshOrgMarketCatalog,
} from '@components/context-space/capability-marketplace/orgMarketCatalogRefresh'
import {
  EMPTY_MARKETPLACE_SHELF_FILTERS,
  shouldResetMarketplaceShelfFilters,
} from '@components/context-space/capability-marketplace/marketplaceShelfFilterReset'
import { MarketplacePagination } from '@components/context-space/capability-marketplace/MarketplacePagination'
import { ContextPageHeader } from '@components/context-space/ContextPageHeader'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import { McpApiService, type OrgMcpConnection } from '@/services/mcpApi'

type AgentToolPickerItem =
  | {
      kind: 'connection'
      id: string
      name: string
      description: string
      sourceLabel: string
      connection: LocalMcpConnectionSummary
    }
  | {
      kind: 'recommended'
      id: string
      name: string
      description: string
      sourceLabel: string
      entry: RecommendedConnectorCatalogEntry
    }
  | {
      kind: 'organization'
      id: string
      name: string
      description: string
      sourceLabel: string
      orgConnection: OrgMcpConnection
    }

interface Props {
  /**
   * 设备域语义下默认 true：用户管理自己这台机器的 MCP 连接。
   * 保留该 prop 以便未来在受限场景（如只读共享）下复用。
   */
  canManage?: boolean
  /** 嵌入「技能和连接器」统一页时，复用外层页眉。 */
  embedded?: boolean
  /**
   * 市场页传入当前 Space 所属组织，与技能列表锚点一致。
   * 未传时回退侧边栏 `selectedOrganization`（独立设置页入口）。
   */
  organizationId?: string | null
  /**
   * 能力市场嵌入态：启用组织精选短轮询 / 可见时重拉。
   * 须与 `catalogActive` 配合；独立设置页保持默认 false。
   */
  liveCatalog?: boolean
  /** 外层「连接器」页签当前可见；隐藏时停止轮询。 */
  catalogActive?: boolean
  /**
   * 非 embedded 时覆盖页眉标题（如 AI 分身「工具携带集」）。
   * 不传则沿用「MCP 连接」。
   */
  title?: string
  /** 非 embedded 时覆盖页眉副文案。 */
  subtitle?: string
  /**
   * 非 embedded 时隐藏自带 SettingsPanelHeader（外层已有 drill-in / Section 标题时用）。
   * 仍渲染「已接入的外部工具」卡片列表与手动添加。
   */
  hideHeader?: boolean
  /**
   * 传入时进入「单 Agent 携带集」模式：开关只挂载/卸下该 Agent，
   * 不再展示「选择启用的 Agent」多选与「已启用到 N 个 Agent」。
   */
  scopeAgentId?: string
}

type TransportSummary = {
  transportKind: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
}

function formatTransport(summary: TransportSummary): string {
  if (summary.transportKind === 'http') {
    return summary.url ?? ''
  }
  return [summary.command, ...(summary.args ?? [])].filter(Boolean).join(' ')
}

function getProbeErrorHint(error: string, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  const lower = error.toLowerCase()
  if (lower.includes('econnrefused') || lower.includes('connection refused')) {
    return t('mcpConnections.probeHints.connectionRefused', {
      defaultValue: 'The MCP server may not be running. Please check if the service is started.',
    })
  }
  if (lower.includes('enoent') || lower.includes('spawn') || lower.includes('not found')) {
    return t('mcpConnections.probeHints.commandNotFound', {
      defaultValue: 'The command was not found. Please verify the command path is correct.',
    })
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return t('mcpConnections.probeHints.timeout', {
      defaultValue: 'The connection timed out. The server may be slow to start or unresponsive.',
    })
  }
  return null
}

function formatKeySummary(envKeys: string[], headerKeys: string[]): string | null {
  const parts: string[] = []
  if (envKeys.length > 0) {
    parts.push(`ENV: ${envKeys.join(', ')}`)
  }
  if (headerKeys.length > 0) {
    parts.push(`Headers: ${headerKeys.join(', ')}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function formatTimestamp(value?: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function lifecycleBadgeTone(lifecycle: ConnectorLifecycle): 'default' | 'success' | 'info' | 'muted' {
  if (lifecycle === 'ready') return 'success'
  if (lifecycle === 'available') return 'info'
  if (lifecycle === 'needs_repair') return 'muted'
  return 'default'
}

type ManualConnectionFormState = {
  connectionId: string | null
  name: string
  description: string
  jsonConfig: string
  enabled: boolean
}

type ConnectorMarketSource = 'recommended' | 'organization' | 'mine'

/** 能力市场详情：我的走完整面板；推荐 / 组织精选仅名称 + 描述（组织分享者可取消分享）。 */
type ConnectorCatalogDetailTarget =
  | { kind: 'mine'; connectionId: string }
  | { kind: 'recommended'; catalogId: string }
  | { kind: 'organization'; orgConnectionId: string }

const MarketplacePanelLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="w-full min-w-0">{children}</div>
)

function createEmptyManualFormState(): ManualConnectionFormState {
  return {
    connectionId: null,
    name: '',
    description: '',
    jsonConfig: '',
    enabled: true,
  }
}

function transportToJson(transport: LocalMcpTransportConfig): string {
  if (transport.kind === 'http') {
    const obj: Record<string, unknown> = { url: transport.url }
    if (transport.headers && Object.keys(transport.headers).length > 0) {
      obj.headers = transport.headers
    }
    return JSON.stringify(obj, null, 2)
  }
  const obj: Record<string, unknown> = { command: transport.command }
  if (transport.args && transport.args.length > 0) obj.args = transport.args
  if (transport.cwd) obj.cwd = transport.cwd
  if (transport.env && Object.keys(transport.env).length > 0) obj.env = transport.env
  return JSON.stringify(obj, null, 2)
}

function buildManualFormState(detail: LocalMcpConnectionDetail): ManualConnectionFormState {
  return {
    connectionId: detail.id,
    name: detail.name,
    description: detail.description ?? '',
    jsonConfig: transportToJson(detail.transport),
    enabled: detail.enabled,
  }
}

function buildManualConnectionInput(
  form: ManualConnectionFormState,
  t: (key: string, opts?: Record<string, unknown>) => string,
): LocalMcpManualConnectionInput {
  const jsonTrimmed = form.jsonConfig.trim()
  if (!jsonTrimmed) {
    throw new Error(
      t('mcpConnections.validation.jsonConfigRequired', {
        defaultValue: 'Please paste the MCP server JSON configuration.',
      }),
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonTrimmed)
  } catch {
    throw new Error(
      t('mcpConnections.validation.invalidJson', {
        defaultValue: 'Invalid JSON. Please check the format.',
      }),
    )
  }

  // 同时接受标准 mcpServers 文档（`{ mcpServers: { <名字>: {...} } }` / VS Code `servers`）
  // 与裸单 server 对象。解析走 main/renderer 共用的 SSoT，杜绝格式漂移。
  const entries = parseMcpConfigEntries(parsed)
  if (entries.length === 0) {
    throw new Error(
      t('mcpConnections.validation.missingCommandOrUrl', {
        defaultValue: 'JSON must contain either "command" (for stdio) or "url" (for HTTP).',
      }),
    )
  }
  if (entries.length > 1) {
    throw new Error(
      t('mcpConnections.validation.multipleServers', {
        defaultValue: '检测到多个 MCP server，请一次只添加一个。',
      }),
    )
  }

  const entry = entries[0]
  // 名称优先用表单输入；留空时回退到标准格式里的 server key（裸对象无 key，须填名称）。
  const name = form.name.trim() || (entry.name ?? '')
  if (!name) {
    throw new Error(
      t('mcpConnections.validation.nameRequired', {
        defaultValue: 'Please enter a connection name.',
      }),
    )
  }

  // 设备域创建：不隐式启用给任何 Agent。创建后由用户在连接项里显式选择。
  // 分身携带集创建：由调用方写入 attachToAgentId。
  return {
    connectionId: form.connectionId ?? undefined,
    name,
    description: form.description.trim() || undefined,
    attachToAgentId: undefined,
    enabled: form.enabled,
    transport: entry.transport,
  }
}

export const McpPanel: React.FC<Props> = ({
  canManage = true,
  embedded = false,
  organizationId: organizationIdProp = null,
  liveCatalog = false,
  catalogActive = true,
  title,
  subtitle,
  hideHeader = false,
  scopeAgentId,
}) => {
  const { t } = useTranslation('space')
  const currentUserId = useAuthStore(state => state.user?.id ?? null)
  const isAgentScoped = Boolean(scopeAgentId)
  const selectedOrganizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const organizationId = organizationIdProp ?? selectedOrganizationId
  const isPersonalOrganization = useOrganizationStore(state =>
    organizationId
      ? state.organizations.find(org => org.id === organizationId)?.type === 'personal'
      : false,
  )
  const [agents, setAgents] = useState<Agent[]>([])

  useEffect(() => {
    let cancelled = false
    // 单 Agent 携带集不需要拉全量 Agent 列表做多选。
    if (!organizationId || isAgentScoped) {
      setAgents([])
      return
    }
    void AgentApiService.listAgents(organizationId)
      .then(items => {
        if (!cancelled) {
          setAgents([...items].sort((a, b) => (a.name || '').localeCompare(b.name || '')))
        }
      })
      .catch(() => {
        if (!cancelled) setAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [organizationId, isAgentScoped])

  // 携带集模式不拉全量 Agent，但仍须把当前分身算进可管理集合，
  // 否则 getConnectorMarketState 会把已挂载连接误判为「待选择 Agent」。
  const manageableAgentIdSet = useMemo(() => {
    if (scopeAgentId) return new Set([scopeAgentId])
    return new Set(agents.map(agent => agent.id))
  }, [agents, scopeAgentId])

  const {
    loading,
    refreshing,
    error,
    discovery,
    connections,
    loadPanelData,
    upsertConnection,
    refreshConnectionsSilent,
  } = useMcpPanelData()

  const {
    busyKey,
    setBusyKey,
    copied,
    deleteTarget,
    setDeleteTarget,
    runManagedAction,
    handleCopy,
    handleDeleteConnection,
    confirmDeleteConnection,
  } = useMcpActions(loadPanelData, t)

  const [manualDialogOpen, setManualDialogOpen] = useState(false)
  const [manualForm, setManualForm] = useState<ManualConnectionFormState>(() => createEmptyManualFormState())
  const [manualFormError, setManualFormError] = useState<string | null>(null)
  const [toolPickerOpen, setToolPickerOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [marketSource, setMarketSource] = useState<ConnectorMarketSource>('recommended')
  const [catalogDetail, setCatalogDetail] = useState<ConnectorCatalogDetailTarget | null>(null)
  const [managedConnectionId, setManagedConnectionId] = useState<string | null>(null)
  const [managedAgentIds, setManagedAgentIds] = useState<Set<string>>(() => new Set())
  const [runtimeDeviceName, setRuntimeDeviceName] = useState('')
  const [orgConnections, setOrgConnections] = useState<OrgMcpConnection[]>([])
  const [orgLoading, setOrgLoading] = useState(false)
  const [orgError, setOrgError] = useState<string | null>(null)
  /** 首次成功拉过列表后，后台轮询 / 切回页签不再打骨架，避免「一闪」。 */
  const orgCatalogReadyRef = useRef(false)
  const [shareTarget, setShareTarget] = useState<LocalMcpConnectionSummary | null>(null)
  const [removeFromOrgTarget, setRemoveFromOrgTarget] = useState<OrgMcpConnection | null>(null)
  const [oauthFlow, setOauthFlow] = useState<{
    entry: RecommendedConnectorCatalogEntry
    connectionId: string
    step: ConnectorOAuthDialogStep
    /** 本次流程新建的连接；取消说明页时可丢弃 */
    createdInFlow: boolean
    assignedAgentCount: number
    /** 探测失败时主进程返回的可读错误（展示在失败态） */
    errorDetail?: string
    /** 探测成功后再挂到该 Agent（分身携带集） */
    pendingAttachAgentId?: string
    /** 探测成功后再提交的「配置给 Agent」增删；失败则不改动 */
    pendingAgentAssignments?: PendingAgentAssignments
  } | null>(null)
  const oauthProbeEpochRef = useRef(0)
  const [credentialFlow, setCredentialFlow] = useState<{
    entry: RecommendedConnectorCatalogEntry
    connectionId: string
    mode: 'api_key' | 'app_credentials'
    createdInFlow: boolean
    pendingAttachAgentId?: string
    pendingAgentAssignments?: PendingAgentAssignments
  } | null>(null)
  const [credentialSaving, setCredentialSaving] = useState(false)
  const [vendorGateEntry, setVendorGateEntry] = useState<RecommendedConnectorCatalogEntry | null>(
    null,
  )

  const OAUTH_PROBE_TIMEOUT_MS = 180_000
  const CREDENTIAL_PROBE_TIMEOUT_MS = 60_000
  const editingOrganizationMirror = Boolean(
    manualForm.connectionId
    && connections.some(
      connection => connection.id === manualForm.connectionId && connection.source.kind === 'organization',
    ),
  )

  useEffect(() => {
    orgCatalogReadyRef.current = false
  }, [organizationId])

  // 切换组织后连接器列表重建，搜索词不应跨组织残留。
  useEffect(() => {
    setSearchQuery(EMPTY_MARKETPLACE_SHELF_FILTERS.search)
  }, [organizationId])

  const loadOrgConnections = useCallback(async (options?: { silent?: boolean }) => {
    if (!organizationId) {
      setOrgConnections([])
      setOrgError(null)
      orgCatalogReadyRef.current = false
      return
    }
    // 已有列表时后台刷新保持静默；显式 silent 同理（轮询 / 切回）。
    const silent = options?.silent === true || orgCatalogReadyRef.current
    if (!silent) setOrgLoading(true)
    try {
      const result = await McpApiService.listOrgConnections(organizationId)
      setOrgConnections(result.connections ?? [])
      setOrgError(null)
      orgCatalogReadyRef.current = true
    } catch (loadError) {
      // 后台刷新失败保留旧列表，避免轮询把组织精选刷成空骨架。
      if (!silent) {
        setOrgConnections([])
      }
      // 404 / 未找到：按「暂无组织精选」空态处理，避免市场页露出裸 HTTP 状态码。
      const status =
        loadError && typeof loadError === 'object' && 'status' in loadError
          ? Number((loadError as { status?: number }).status)
          : undefined
      const message = loadError instanceof Error ? loadError.message : String(loadError)
      if (status === 404 || /^HTTP\s*404\b/i.test(message)) {
        setOrgError(null)
        if (!silent) {
          orgCatalogReadyRef.current = true
        }
      } else if (!silent) {
        setOrgError(message)
      }
    } finally {
      if (!silent) setOrgLoading(false)
    }
  }, [organizationId])

  // 「我的」详情要判断是否已精选；组织 Tab 也要列表——有组织就拉。
  useEffect(() => {
    void loadOrgConnections()
  }, [loadOrgConnections])

  // ：市场页连接器可见时强制重拉 + 短轮询，避免队友刚共享的组织精选被本地 state 挡住。
  const shouldLiveRefreshOrgCatalog = shouldRefreshOrgMarketCatalog({
    liveCatalog,
    catalogActive,
    organizationId,
  })
  useEffect(() => {
    if (!shouldLiveRefreshOrgCatalog) return
    void loadOrgConnections({ silent: true })
    const timer = window.setInterval(() => {
      void loadOrgConnections({ silent: true })
    }, ORG_MARKET_CATALOG_POLL_MS)
    return () => window.clearInterval(timer)
  }, [shouldLiveRefreshOrgCatalog, loadOrgConnections])

  /** 业务匹配只看用户自建连接，避免把组织镜像误判成分享者的本机原件。 */
  const mineConnections = useMemo(
    () => connections.filter(connection => connection.source.kind !== 'organization'),
    [connections],
  )

  /** 「我的」是本机已接入集合；组织镜像也应出现，但与同源本机原件去重。 */
  const mineShelfConnections = useMemo(
    () => selectMineShelfConnections(connections),
    [connections],
  )

  const detailMineConnection = catalogDetail?.kind === 'mine'
    ? (connections.find(connection => connection.id === catalogDetail.connectionId) ?? null)
    : null
  const detailRecommendedEntry = catalogDetail?.kind === 'recommended'
    ? (getRecommendedConnectorById(catalogDetail.catalogId) ?? null)
    : null
  const detailOrgConnection = catalogDetail?.kind === 'organization'
    ? (orgConnections.find(connection => connection.id === catalogDetail.orgConnectionId) ?? null)
    : null
  const catalogDetailOpen = Boolean(
    detailMineConnection || detailRecommendedEntry || detailOrgConnection,
  )

  useEffect(() => {
    if (!catalogDetail) return
    if (catalogDetail.kind === 'mine' && !detailMineConnection) setCatalogDetail(null)
    if (catalogDetail.kind === 'recommended' && !detailRecommendedEntry) setCatalogDetail(null)
    if (catalogDetail.kind === 'organization' && !detailOrgConnection) setCatalogDetail(null)
  }, [
    catalogDetail,
    detailMineConnection,
    detailRecommendedEntry,
    detailOrgConnection,
  ])

  const visibleConnections = useMemo(
    () => mineShelfConnections.filter(connection => matchesConnectorSearch(connection, searchQuery)),
    [mineShelfConnections, searchQuery],
  )

  /** 携带集：主列表只展示已挂到当前 Agent 的连接（含组织镜像，对齐商城配置结果）。 */
  const carriedConnections = useMemo(() => {
    if (!scopeAgentId) return visibleConnections
    return connections.filter(
      connection =>
        connection.attachedAgentIds.includes(scopeAgentId) &&
        matchesConnectorSearch(connection, searchQuery),
    )
  }, [connections, scopeAgentId, searchQuery, visibleConnections])

  const recommendedCatalogDescription = useCallback(
    (entry: RecommendedConnectorCatalogEntry) =>
      t(`mcpConnections.marketplace.recommendedCatalog.${entry.descriptionKey}`, {
        defaultValue: entry.name,
      }),
    [t],
  )

  /**
   * 添加工具池：对齐技能携带集挑选器。
   * 技能 = 组织技能库 − 已挂当前分身；
   * 工具 = 「技能和连接器 → 连接器」三货架（推荐 + 组织精选 + 我的）− 已挂当前分身。
   */
  const toolPickerItems = useMemo((): AgentToolPickerItem[] => {
    if (!scopeAgentId) return []
    const items: AgentToolPickerItem[] = []
    const seenConnectionIds = new Set<string>()
    const recommendedLabel = t('mcpConnections.marketplace.source.recommended', {
      defaultValue: '推荐',
    })
    const organizationLabel = t('mcpConnections.marketplace.source.organization', {
      defaultValue: '组织精选',
    })
    const mineLabel = t('mcpConnections.marketplace.source.mine', {
      defaultValue: '我的',
    })

    const pushLocal = (
      connection: LocalMcpConnectionSummary,
      sourceLabel: string,
    ) => {
      if (connection.attachedAgentIds.includes(scopeAgentId)) return
      if (seenConnectionIds.has(connection.id)) return
      seenConnectionIds.add(connection.id)
      items.push({
        kind: 'connection',
        id: connection.id,
        name: connection.name,
        description: connection.description?.trim() || formatTransport(connection),
        sourceLabel,
        connection,
      })
    }

    // 「我的」：本机已接入（不含组织镜像行；镜像走组织精选）。
    for (const connection of mineConnections) {
      pushLocal(connection, connection.source.label?.trim() || mineLabel)
    }

    // 「组织精选」：已有本机同源 / 镜像则挂那条；否则列云端条目，点添加时再镜像。
    for (const orgConnection of orgConnections) {
      const mineMatch = findMatchingMineConnectionForOrg(orgConnection, mineConnections)
      const mirror = connections.find(
        connection =>
          connection.source.kind === 'organization'
          && connection.source.orgConnectionId === orgConnection.id,
      )
      const local = mineMatch && mirror
        ? mergeAttachedAgentIdsForDisplay(mineMatch, mirror)
        : (mineMatch ?? mirror)
      if (local) {
        pushLocal(local, organizationLabel)
        continue
      }
      items.push({
        kind: 'organization',
        id: orgConnection.id,
        name: orgConnection.name,
        description: orgConnection.description?.trim() || orgConnection.endpoint,
        sourceLabel: organizationLabel,
        orgConnection,
      })
    }

    // 「推荐」：未接入才单独列；已接入的已在「我的」出现（或已挂载被过滤）。
    for (const entry of RECOMMENDED_CONNECTOR_CATALOG) {
      const imported = findConnectionForRecommendedConnector(entry, mineConnections)
      if (imported) continue
      items.push({
        kind: 'recommended',
        id: entry.id,
        name: entry.name,
        description: recommendedCatalogDescription(entry),
        sourceLabel: recommendedLabel,
        entry,
      })
    }

    return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [
    connections,
    mineConnections,
    orgConnections,
    recommendedCatalogDescription,
    scopeAgentId,
    t,
  ])

  const listedConnections = isAgentScoped ? carriedConnections : visibleConnections

  // 从工具商城切回携带集时，绕过短 TTL 缓存，重新读本机挂载结果。
  useEffect(() => {
    if (!scopeAgentId) return
    void refreshConnectionsSilent()
  }, [scopeAgentId, refreshConnectionsSilent])

  const visibleOrgConnections = useMemo(
    () =>
      orgConnections.filter(connection => {
        const haystack = [connection.name, connection.description, connection.endpoint]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        const query = searchQuery.trim().toLowerCase()
        return !query || haystack.includes(query)
      }),
    [orgConnections, searchQuery],
  )
  const orgMarketEmptyKind = resolveOrgMarketEmptyKind({
    orgError,
    visibleCount: visibleOrgConnections.length,
  })

  const visibleRecommended = useMemo(
    () =>
      RECOMMENDED_CONNECTOR_CATALOG.filter(entry => {
        const transport = entry.transport
        return matchesConnectorSearch(
          {
            name: entry.name,
            description: recommendedCatalogDescription(entry),
            source: {
              kind: 'manual',
              label: t('mcpConnections.marketplace.source.recommended', {
                defaultValue: '推荐',
              }),
            },
            transportKind: transport.kind,
            command: transport.kind === 'stdio' ? transport.command : undefined,
            args: transport.kind === 'stdio' ? transport.args : undefined,
            url: transport.kind === 'http' ? transport.url : undefined,
            envKeys: transport.kind === 'stdio' ? Object.keys(transport.env ?? {}) : [],
            headerKeys: transport.kind === 'http' ? Object.keys(transport.headers ?? {}) : [],
          },
          searchQuery,
        )
      }),
    [recommendedCatalogDescription, searchQuery, t],
  )

  /** 非市场嵌入态：本机 IDE 发现列表仍保留在设置页下方。 */
  const visibleCandidates = useMemo(
    () =>
      (discovery?.candidates ?? []).filter(candidate =>
        matchesConnectorSearch(candidate, searchQuery),
      ),
    [discovery?.candidates, searchQuery],
  )
  const managedConnection = managedConnectionId
    ? (connections.find(connection => connection.id === managedConnectionId) ?? null)
    : null
  const managedAuthGate = managedConnection
    ? resolveConnectorAuthGate({
        connection: managedConnection,
        catalogEntry: findRecommendedCatalogEntryForConnection(managedConnection),
      })
    : null
  const managedAssignmentSignature = managedConnection
    ? getManageableAttachedAgentIds(managedConnection.attachedAgentIds, manageableAgentIdSet).sort().join(',')
    : ''

  useEffect(() => {
    if (!managedConnectionId) return
    setManagedAgentIds(new Set(managedAssignmentSignature ? managedAssignmentSignature.split(',') : []))
  }, [managedAssignmentSignature, managedConnectionId])

  useEffect(() => {
    if (!managedConnectionId) return
    let cancelled = false
    void window.tabtin
      .getHostname()
      .then(name => {
        if (!cancelled) setRuntimeDeviceName(name.trim())
      })
      .catch(() => {
        if (!cancelled) setRuntimeDeviceName('')
      })
    return () => {
      cancelled = true
    }
  }, [managedConnectionId])

  const openManualCreateDialog = () => {
    setManualForm(createEmptyManualFormState())
    setManualFormError(null)
    setManualDialogOpen(true)
  }

  const handleEditManualConnection = async (connectionId: string) => {
    setBusyKey(`edit:${connectionId}`)
    try {
      // 编辑表单需要明文 header；默认 getConnectionDetail 会 redact Authorization。
      const detail = await window.tabtin.localMcp.getConnectionDetail(connectionId, {
        includeSecrets: true,
      })
      if (detail.source.kind !== 'manual' && detail.source.kind !== 'organization') {
        throw new Error('MCP_ERR:ONLY_MANUAL_EDITABLE')
      }
      setManualForm(buildManualFormState(detail))
      setManualFormError(null)
      setManualDialogOpen(true)
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const parsed = parseMcpError(rawMsg)
      const description = parsed
        ? t(`mcpConnections.errors.${parsed.code}`, {
            defaultValue: rawMsg,
            ...parsed.params,
          })
        : rawMsg
      toast({
        title: t('mcpConnections.actionFailed', {
          defaultValue: 'Action failed',
        }),
        description,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  const handleSaveManualConnection = async () => {
    let payload: LocalMcpManualConnectionInput
    try {
      payload = buildManualConnectionInput(manualForm, t)
      setManualFormError(null)
    } catch (formError) {
      setManualFormError(formError instanceof Error ? formError.message : String(formError))
      return
    }

    await runManagedAction(`manual:${manualForm.connectionId ?? 'new'}`, async () => {
      await window.tabtin.localMcp.saveManualConnection({
        ...payload,
        ...(scopeAgentId && !manualForm.connectionId
          ? { attachToAgentId: scopeAgentId }
          : {}),
      })
      setManualDialogOpen(false)
      setManualForm(createEmptyManualFormState())
      toast({
        title: manualForm.connectionId
          ? editingOrganizationMirror
            ? t('mcpConnections.manual.organizationSaveSuccess', {
                defaultValue: '个人补充配置已保存',
              })
            : t('mcpConnections.manual.saveSuccess', {
                defaultValue: '手动 MCP 连接已更新',
              })
          : scopeAgentId
            ? t('mcpConnections.manual.createSuccessAgentScope', {
                defaultValue: '手动 MCP 连接已创建，并已挂到当前 Agent',
              })
            : t('mcpConnections.manual.createSuccessDevice', {
                defaultValue: '手动 MCP 连接已创建，可在连接项里选择启用到哪些 Agent',
              }),
      })
    })
  }

  const handleImportCandidate = async (candidate: LocalMcpCandidateSummary) => {
    await runManagedAction(`import:${candidate.id}`, async () => {
      // 设备域：仅接入，不隐式启用给任何 Agent。
      // 分身携带集：接入后直接挂到当前 Agent。
      await window.tabtin.localMcp.importCandidate(candidate.id, {
        ...(scopeAgentId ? { attachToAgentId: scopeAgentId } : {}),
      })
      toast({
        title: scopeAgentId
          ? t('mcpConnections.importSuccessAgentScope', {
              defaultValue: '已接入并挂到当前 Agent',
            })
          : t('mcpConnections.importSuccessDevice', {
              defaultValue: '已接入到本机，可在下方选择启用到哪些 Agent',
            }),
      })
    })
  }

  const openVendorGate = (entry: RecommendedConnectorCatalogEntry) => {
    setVendorGateEntry(entry)
  }

  const rollbackManagedAgentSelection = (connectionId: string) => {
    const connection = connections.find(item => item.id === connectionId)
    if (!connection) return
    if (managedConnectionId !== connectionId) return
    setManagedAgentIds(
      new Set(getManageableAttachedAgentIds(connection.attachedAgentIds, manageableAgentIdSet)),
    )
  }

  const commitPendingAgentChanges = async (
    connectionId: string,
    pending: {
      pendingAttachAgentId?: string
      pendingAgentAssignments?: PendingAgentAssignments
    },
  ): Promise<number> => {
    const assignments = pending.pendingAgentAssignments
    if (assignments && (assignments.additions.length > 0 || assignments.removals.length > 0)) {
      const results = await Promise.allSettled([
        ...assignments.additions.map(agentId =>
          window.tabtin.localMcp.attachConnection(connectionId, agentId, true),
        ),
        ...assignments.removals.map(agentId =>
          window.tabtin.localMcp.attachConnection(connectionId, agentId, false),
        ),
      ])
      const refreshed = await refreshConnectionsSilent()
      const failed = results.filter(result => result.status === 'rejected').length
      if (failed > 0) {
        toast({
          title: t('mcpConnections.managedAgents.partialFailed', {
            succeeded: results.length - failed,
            failed,
            defaultValue: `部分保存成功（${results.length - failed} 成功，${failed} 失败），已刷新为当前实际配置`,
          }),
          variant: 'destructive',
        })
      }
      const lastFulfilled = [...results].reverse().find(
        (result): result is PromiseFulfilledResult<LocalMcpConnectionSummary> =>
          result.status === 'fulfilled',
      )
      const attachedIds =
        lastFulfilled?.value.attachedAgentIds
        ?? refreshed?.find(item => item.id === connectionId)?.attachedAgentIds
        ?? []
      if (managedConnectionId === connectionId) {
        setManagedAgentIds(
          new Set(getManageableAttachedAgentIds(attachedIds, manageableAgentIdSet)),
        )
      }
      return getManageableAttachedAgentIds(attachedIds, manageableAgentIdSet).length
    }
    return attachPendingAgentIfNeeded(connectionId, pending.pendingAttachAgentId)
  }

  const closeOauthFlow = async (options?: { discardDraft?: boolean; rollbackAgents?: boolean }) => {
    const flow = oauthFlow
    oauthProbeEpochRef.current += 1
    setOauthFlow(null)
    if (flow?.step === 'authorizing') {
      await window.tabtin.localMcp.cancelProbe(flow.connectionId).catch(() => undefined)
    }
    if (options?.rollbackAgents && flow) {
      rollbackManagedAgentSelection(flow.connectionId)
    }
    if (
      options?.discardDraft
      && flow?.createdInFlow
      && flow.step !== 'success'
    ) {
      try {
        await window.tabtin.localMcp.deleteConnection(flow.connectionId)
        await refreshConnectionsSilent()
      } catch {
        // 丢弃失败不挡关闭；连接会留在「我的」里待用户手动删
      }
    }
  }

  const closeCredentialFlow = async (options?: {
    discardDraft?: boolean
    rollbackAgents?: boolean
  }) => {
    const flow = credentialFlow
    setCredentialFlow(null)
    setCredentialSaving(false)
    if (options?.rollbackAgents && flow) {
      rollbackManagedAgentSelection(flow.connectionId)
    }
    if (options?.discardDraft && flow?.createdInFlow) {
      try {
        await window.tabtin.localMcp.deleteConnection(flow.connectionId)
        await refreshConnectionsSilent()
      } catch {
        // ignore
      }
    }
  }

  const attachPendingAgentIfNeeded = async (
    connectionId: string,
    agentId: string | undefined,
  ): Promise<number> => {
    if (!agentId) return 0
    try {
      const summary = await window.tabtin.localMcp.attachConnection(connectionId, agentId, true)
      upsertConnection(summary)
      return getManageableAttachedAgentIds(summary.attachedAgentIds, manageableAgentIdSet).length
    } catch (attachError) {
      const rawMsg = attachError instanceof Error ? attachError.message : String(attachError)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: 'Action failed' }),
        description: rawMsg,
        variant: 'destructive',
      })
      return 0
    }
  }

  const runOauthAuthorizeProbe = async () => {
    if (!oauthFlow) return
    const epoch = ++oauthProbeEpochRef.current
    const {
      connectionId,
      entry,
      pendingAttachAgentId,
      pendingAgentAssignments,
      createdInFlow,
    } = oauthFlow
    setOauthFlow(prev =>
      prev ? { ...prev, step: 'authorizing', errorDetail: undefined } : null,
    )
    try {
      let transport = entry.transport
      if (connectorIsPlatformOAuth(entry)) {
        if (await shouldUseGitHubPatFallback(entry)) {
          if (epoch !== oauthProbeEpochRef.current) return
          setOauthFlow(null)
          setCredentialFlow({
            entry,
            connectionId,
            mode: 'api_key',
            createdInFlow,
            pendingAttachAgentId,
            pendingAgentAssignments,
          })
          return
        }
        if (!organizationId) {
          throw new Error('缺少组织信息，无法完成 GitHub 授权')
        }
        const claim = await runGitHubConnectorOAuth({
          organizationId,
          timeoutMs: OAUTH_PROBE_TIMEOUT_MS,
        })
        if (epoch !== oauthProbeEpochRef.current) return
        transport = applyBearerTokenToTransport(entry.transport, claim.accessToken)
      }

      // 授权前同步货架 transport（钉版本 / OAuth scope metadata / Bearer）
      await window.tabtin.localMcp.saveManualConnection({
        connectionId,
        name: entry.name,
        description: recommendedCatalogDescription(entry),
        enabled: true,
        transport,
      })
      if (epoch !== oauthProbeEpochRef.current) return
      const summary = await window.tabtin.localMcp.probeConnection(connectionId, {
        timeoutMs: OAUTH_PROBE_TIMEOUT_MS,
        openOAuthWindow: true,
      })
      if (epoch !== oauthProbeEpochRef.current) return
      await refreshConnectionsSilent()
      if (!summary.ok) {
        rollbackManagedAgentSelection(connectionId)
        setOauthFlow(prev =>
          prev
            ? {
                ...prev,
                step: 'failed',
                errorDetail: summary.error,
                pendingAgentAssignments: undefined,
                pendingAttachAgentId: undefined,
              }
            : null,
        )
        return
      }
      const assignedAgentCount = await commitPendingAgentChanges(connectionId, {
        pendingAttachAgentId,
        pendingAgentAssignments,
      })
      if (epoch !== oauthProbeEpochRef.current) return
      setOauthFlow(prev =>
        prev
          ? {
              ...prev,
              step: 'success',
              createdInFlow: false,
              errorDetail: undefined,
              pendingAttachAgentId: undefined,
              pendingAgentAssignments: undefined,
              assignedAgentCount: assignedAgentCount || prev.assignedAgentCount,
            }
          : null,
      )
    } catch (probeError) {
      if (epoch !== oauthProbeEpochRef.current) return
      await refreshConnectionsSilent()
      rollbackManagedAgentSelection(connectionId)
      const detail =
        probeError instanceof Error ? probeError.message : String(probeError)
      setOauthFlow(prev =>
        prev
          ? {
              ...prev,
              step: 'failed',
              errorDetail: detail,
              pendingAgentAssignments: undefined,
              pendingAttachAgentId: undefined,
            }
          : null,
      )
    }
  }

  const handleCredentialSubmit = async (value: {
    apiKey?: string
    clientId?: string
    clientSecret?: string
  }) => {
    if (!credentialFlow) return
    const {
      entry,
      connectionId,
      mode,
      pendingAttachAgentId,
      pendingAgentAssignments,
    } = credentialFlow
    setCredentialSaving(true)
    try {
      const transport =
        mode === 'api_key'
          ? applyCredentialSecretToTransport(entry.transport, value.apiKey ?? '')
          : applyAppCredentialsToTransport(entry.transport, {
              clientId: value.clientId ?? '',
              clientSecret: value.clientSecret ?? '',
            })
      const saved = await window.tabtin.localMcp.saveManualConnection({
        connectionId,
        name: entry.name,
        description: recommendedCatalogDescription(entry),
        enabled: true,
        transport,
      })
      upsertConnection(saved)
      const summary = await window.tabtin.localMcp.probeConnection(connectionId, {
        timeoutMs: CREDENTIAL_PROBE_TIMEOUT_MS,
      })
      await refreshConnectionsSilent()
      if (!summary.ok) {
        rollbackManagedAgentSelection(connectionId)
        toast({
          title: t('mcpConnections.marketplace.credentialDialog.probeFailed', {
            defaultValue: '凭证已保存，但连接探测失败',
          }),
          description: summary.error,
          variant: 'destructive',
        })
        setCredentialFlow(prev =>
          prev
            ? {
                ...prev,
                createdInFlow: false,
                pendingAgentAssignments: undefined,
                pendingAttachAgentId: undefined,
              }
            : null,
        )
        setCredentialSaving(false)
        return
      }
      const assigned = await commitPendingAgentChanges(connectionId, {
        pendingAttachAgentId,
        pendingAgentAssignments,
      })
      setCredentialFlow(null)
      setCredentialSaving(false)
      toast({
        title: t('mcpConnections.marketplace.credentialDialog.probeSuccess', {
          name: entry.name,
          defaultValue: `${entry.name} 已连接`,
        }),
        description:
          assigned > 0
            ? t('mcpConnections.marketplace.oauthDialog.successAssigned', {
                name: entry.name,
                count: assigned,
                defaultValue: `${entry.name} 已配置给 ${assigned} 个 Agent。`,
              })
            : t('mcpConnections.marketplace.credentialDialog.probeSuccessHint', {
                defaultValue: '可在「配置给 Agent」中启用。',
              }),
      })
      if (!isAgentScoped && !managedConnectionId) {
        setManagedConnectionId(connectionId)
      }
    } catch (actionError) {
      setCredentialSaving(false)
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: 'Action failed' }),
        description: rawMsg,
        variant: 'destructive',
      })
    }
  }

  const handleInstallRecommended = async (entry: RecommendedConnectorCatalogEntry) => {
    if (connectorIsOAuthVendorGated(entry)) {
      openVendorGate(entry)
      return
    }

    let createdId: string | null = null
    const ok = await runManagedAction(`import:${entry.id}`, async () => {
      const created = await window.tabtin.localMcp.saveManualConnection({
        name: entry.name,
        description: recommendedCatalogDescription(entry),
        enabled: true,
        transport: entry.transport,
      })
      createdId = created.id
    })
    if (!ok || !createdId) return

    if (connectorNeedsCredentialForm(entry)) {
      setCredentialFlow({
        entry,
        connectionId: createdId,
        mode: entry.authKind === 'app_credentials' ? 'app_credentials' : 'api_key',
        createdInFlow: true,
      })
      return
    }

    // 直接 OAuth：先配 Agent，保存时再走网页授权（稿子主路径）
    if (connectorIsOAuthReady(entry)) {
      toast({
        title: t('mcpConnections.marketplace.recommendedInstallSelectAgents', {
          defaultValue: '已接入本机。请选择 Agent 并保存，保存时将完成网页授权。',
        }),
      })
      setManagedConnectionId(createdId)
      return
    }

    toast({
      title: t('mcpConnections.marketplace.recommendedInstallSuccess', {
        defaultValue: '已接入到本机，可在「我的」里启用到 Agent',
      }),
    })
  }

  const handleAttachConnection = async (connectionId: string, agentId: string, attached: boolean) => {
    // 局部 upsert，避免 refresh 重跑 discover 导致列表闪一下。
    setBusyKey(`attach:${connectionId}:${agentId}`)
    try {
      const summary = await window.tabtin.localMcp.attachConnection(connectionId, agentId, attached)
      upsertConnection(summary)
      toast({
        title: attached
          ? t('mcpConnections.spaceAttach.attachSuccess', {
              defaultValue: '已启用到该 Agent',
            })
          : t('mcpConnections.spaceAttach.detachSuccess', {
              defaultValue: '已从该 Agent 停用',
            }),
      })
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const parsed = parseMcpError(rawMsg)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: 'Action failed' }),
        description: parsed
          ? t(`mcpConnections.errors.${parsed.code}`, { defaultValue: rawMsg, ...parsed.params })
          : rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  /** 分身携带集：开关 = 当前 Agent 是否挂载该连接（必要时顺带启用连接）。 */
  const handleScopeAgentMount = async (connectionId: string, mounted: boolean) => {
    if (!scopeAgentId) return
    setBusyKey(`scope-mount:${connectionId}`)
    try {
      if (mounted) {
        const current = connections.find(connection => connection.id === connectionId)
        if (current && !current.enabled) {
          const enabled = await window.tabtin.localMcp.setConnectionEnabled(connectionId, true)
          upsertConnection(enabled)
        }
      }
      const summary = await window.tabtin.localMcp.attachConnection(
        connectionId,
        scopeAgentId,
        mounted,
      )
      upsertConnection(summary)
      toast({
        title: mounted
          ? t('mcpConnections.agentScope.mountSuccess', {
              defaultValue: '已挂到当前 Agent',
            })
          : t('mcpConnections.agentScope.unmountSuccess', {
              defaultValue: '已从当前 Agent 卸下',
            }),
      })
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const parsed = parseMcpError(rawMsg)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: 'Action failed' }),
        description: parsed
          ? t(`mcpConnections.errors.${parsed.code}`, { defaultValue: rawMsg, ...parsed.params })
          : rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  /** 分身挑选器：组织精选 → 确保本机可挂载连接后，挂到当前 Agent。 */
  const ensureOrgMirrorAndAttach = async (orgConnection: OrgMcpConnection) => {
    if (!scopeAgentId) return

    const mineMatch = findMatchingMineConnectionForOrg(orgConnection, mineConnections)
    if (mineMatch) {
      const mirror = findLocalMirrorForOrg(orgConnection.id)
      if (mirror && mirror.attachedAgentIds.length > 0) {
        setBusyKey(`org-mirror:${orgConnection.id}`)
        try {
          await migrateOrgMirrorAgentsToMine(mineMatch, mirror)
        } finally {
          setBusyKey(null)
        }
      }
      await handleScopeAgentMount(mineMatch.id, true)
      return
    }

    const existingMirror = findLocalMirrorForOrg(orgConnection.id)
    if (existingMirror) {
      await handleScopeAgentMount(existingMirror.id, true)
      return
    }

    setBusyKey(`org-mirror:${orgConnection.id}`)
    try {
      const configHeaders =
        orgConnection.config && typeof orgConnection.config.headers === 'object'
          && orgConnection.config.headers
          ? Object.keys(orgConnection.config.headers as Record<string, unknown>)
          : []
      const headerKeys = orgConnection.has_credential
        ? Array.from(new Set(['Authorization', ...configHeaders]))
        : configHeaders
      const mirrored = await window.tabtin.localMcp.upsertOrganizationMirror({
        orgConnectionId: orgConnection.id,
        name: orgConnection.name,
        description: orgConnection.description || undefined,
        url: orgConnection.endpoint,
        headerKeys,
        enabled: orgConnection.enabled,
      })
      if (!mirrored.enabled) {
        const enabled = await window.tabtin.localMcp.setConnectionEnabled(mirrored.id, true)
        upsertConnection(enabled)
      } else {
        upsertConnection(mirrored)
      }
      const attached = await window.tabtin.localMcp.attachConnection(
        mirrored.id,
        scopeAgentId,
        true,
      )
      upsertConnection(attached)
      toast({
        title: t('mcpConnections.agentScope.mountSuccess', {
          defaultValue: '已挂到当前 Agent',
        }),
      })
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const parsed = parseMcpError(rawMsg)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: 'Action failed' }),
        description: parsed
          ? t(`mcpConnections.errors.${parsed.code}`, { defaultValue: rawMsg, ...parsed.params })
          : rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  const handlePickTool = async (item: AgentToolPickerItem) => {
    if (!scopeAgentId) return
    if (item.kind === 'connection') {
      await handleScopeAgentMount(item.connection.id, true)
      return
    }

    if (item.kind === 'recommended') {
      const entry = item.entry
      if (connectorIsOAuthVendorGated(entry)) {
        openVendorGate(entry)
        return
      }

      let createdId: string | null = null
      const ok = await runManagedAction(`import:${entry.id}`, async () => {
        // 凭证 / OAuth 完成探测前不挂 Agent，避免半授权会话
        const created = await window.tabtin.localMcp.saveManualConnection({
          name: entry.name,
          description: recommendedCatalogDescription(entry),
          enabled: true,
          transport: entry.transport,
        })
        createdId = created.id
        upsertConnection(created)
      })
      if (!ok || !createdId) return

      if (connectorNeedsCredentialForm(entry)) {
        setToolPickerOpen(false)
        setCredentialFlow({
          entry,
          connectionId: createdId,
          mode: entry.authKind === 'app_credentials' ? 'app_credentials' : 'api_key',
          createdInFlow: true,
          pendingAttachAgentId: scopeAgentId,
        })
        return
      }

      if (connectorIsOAuthReady(entry)) {
        setToolPickerOpen(false)
        if (await shouldUseGitHubPatFallback(entry)) {
          setCredentialFlow({
            entry,
            connectionId: createdId,
            mode: 'api_key',
            createdInFlow: true,
            pendingAttachAgentId: scopeAgentId,
          })
          return
        }
        setOauthFlow({
          entry,
          connectionId: createdId,
          step: 'prompt',
          createdInFlow: true,
          assignedAgentCount: 0,
          pendingAttachAgentId: scopeAgentId,
        })
        return
      }

      const attached = await window.tabtin.localMcp.attachConnection(
        createdId,
        scopeAgentId,
        true,
      )
      upsertConnection(attached)
      toast({
        title: t('mcpConnections.agentScope.mountSuccess', {
          defaultValue: '已挂到当前 Agent',
        }),
      })
      return
    }

    await ensureOrgMirrorAndAttach(item.orgConnection)
  }

  const handleSetEnabled = async (connectionId: string, enabled: boolean) => {
    setBusyKey(`enable:${connectionId}`)
    try {
      const summary = await window.tabtin.localMcp.setConnectionEnabled(connectionId, enabled)
      upsertConnection(summary)
      toast({
        title: enabled
          ? t('mcpConnections.enableSuccess', { defaultValue: '连接已启用' })
          : t('mcpConnections.disableSuccess', { defaultValue: '连接已停用' }),
      })
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const parsed = parseMcpError(rawMsg)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: 'Action failed' }),
        description: parsed
          ? t(`mcpConnections.errors.${parsed.code}`, { defaultValue: rawMsg, ...parsed.params })
          : rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  const handleProbeConnection = async (connectionId: string) => {
    setBusyKey(`probe:${connectionId}`)
    try {
      const summary = await window.tabtin.localMcp.probeConnection(connectionId)
      // probe 只返回 ProbeSummary；静默重拉 connections 写入 lastProbe，不跑 discover。
      await refreshConnectionsSilent()
      toast({
        title: summary.ok
          ? t('mcpConnections.probeSuccess', { defaultValue: '探测成功' })
          : t('mcpConnections.probeFailed', { defaultValue: '探测失败' }),
        description: summary.ok
          ? undefined
          : (() => {
              const parsed = summary.error ? parseMcpError(summary.error) : null
              return parsed
                ? t(`mcpConnections.errors.${parsed.code}`, {
                    defaultValue: summary.error,
                    ...parsed.params,
                  })
                : summary.error
            })(),
        variant: summary.ok ? 'default' : 'destructive',
      })
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const parsed = parseMcpError(rawMsg)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: 'Action failed' }),
        description: parsed
          ? t(`mcpConnections.errors.${parsed.code}`, { defaultValue: rawMsg, ...parsed.params })
          : rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  const findOrgShare = (connection: LocalMcpConnectionSummary): OrgMcpConnection | null =>
    findOrgShareForLocalConnection(connection, orgConnections)

  const canShareConnectionToOrg = (connection: LocalMcpConnectionSummary): boolean =>
    Boolean(
      canManage
        && organizationId
        && !isPersonalOrganization
        && connection.transportKind === 'http'
        && connection.source.kind !== 'organization'
        && !findOrgShare(connection),
    )

  const canRemoveConnectionFromOrg = (connection: LocalMcpConnectionSummary): boolean =>
    Boolean(
      canManage
        && organizationId
        && !isPersonalOrganization
        && isOrgConnectionSharedByCurrentUser(
          findOrgShare(connection) ?? { name: '', endpoint: '' },
          currentUserId,
          mineConnections,
        ),
    )

  const requestShareToOrg = (connection: LocalMcpConnectionSummary) => {
    if (!organizationId) {
      toast({
        title: t('mcpConnections.shareToOrg.noOrganization', {
          defaultValue: '当前不在组织中，无法共享',
        }),
        variant: 'destructive',
      })
      return
    }
    if (isPersonalOrganization) return
    if (connection.transportKind !== 'http') {
      toast({
        title: t('mcpConnections.shareToOrg.httpOnly', {
          defaultValue: '仅远程（HTTP）连接器可共享给组织',
        }),
        variant: 'destructive',
      })
      return
    }
    setShareTarget(connection)
  }

  const confirmShareToOrg = async () => {
    if (!shareTarget || !organizationId) return
    const connectionId = shareTarget.id
    const shareName = shareTarget.name
    const conflict = findOrgConnectionShareConflict(shareTarget, orgConnections)
    if (conflict) {
      toast({
        title: t('mcpConnections.shareToOrg.failed', {
          defaultValue: '共享给组织失败',
        }),
        description: conflict.kind === 'name'
          ? t('mcpConnections.shareToOrg.nameConflict', {
              name: conflict.value,
              defaultValue: `组织内已存在相同名称的连接器（${conflict.value}），请更换后再共享`,
            })
          : t('mcpConnections.shareToOrg.endpointConflict', {
              defaultValue: '组织内已存在相同 endpoint 的连接器，请更换后再共享',
            }),
        variant: 'destructive',
      })
      setShareTarget(null)
      return
    }
    setBusyKey(`share:${connectionId}`)
    try {
      // 凭据只在 main 内读取并 POST，不经 renderer。
      const shared = await window.tabtin.localMcp.shareConnectionToOrganization(
        connectionId,
        organizationId,
      )
      setShareTarget(null)
      await loadOrgConnections()
      toast({
        title: t('mcpConnections.shareToOrg.success', {
          name: shared.name || shareName,
          defaultValue: `「${shared.name || shareName}」已共享给组织`,
        }),
      })
    } catch (actionError) {
      const status =
        actionError && typeof actionError === 'object' && 'status' in actionError
          ? Number((actionError as { status?: number }).status)
          : undefined
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const isNotFound = status === 404 || /^HTTP\s*404\b/i.test(rawMsg)
      const isNameConflict =
        /MCP_CONNECTION_NAME_CONFLICT/i.test(rawMsg)
        || /已存在相同.*名称|name.*conflict|同名/i.test(rawMsg)
      const isEndpointConflict =
        /MCP_CONNECTION_ENDPOINT_CONFLICT/i.test(rawMsg)
        || /已存在相同 endpoint/i.test(rawMsg)
      toast({
        title: t('mcpConnections.shareToOrg.failed', {
          defaultValue: '共享给组织失败',
        }),
        description: isNotFound
          ? t('mcpConnections.shareToOrg.apiUnavailable', {
              defaultValue: '组织共享接口不可用。请确认本地 API 已更新并重启后再试。',
            })
          : isNameConflict
            ? t('mcpConnections.shareToOrg.nameConflict', {
                name: shareName,
                defaultValue: `组织内已存在相同名称的连接器（${shareName}），请更换后再共享`,
              })
            : isEndpointConflict
              ? t('mcpConnections.shareToOrg.endpointConflict', {
                  defaultValue: '组织内已存在相同 endpoint 的连接器，请更换后再共享',
                })
              : rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  const requestRemoveFromOrg = (connection: LocalMcpConnectionSummary) => {
    const orgShare = findOrgShare(connection)
    if (!orgShare || !isOrgConnectionSharedByCurrentUser(orgShare, currentUserId, mineConnections)) return
    setRemoveFromOrgTarget(orgShare)
  }

  const confirmRemoveFromOrg = async () => {
    if (!removeFromOrgTarget) return
    const orgConnectionId = removeFromOrgTarget.id
    const name = removeFromOrgTarget.name
    setBusyKey(`remove-org:${orgConnectionId}`)
    try {
      await McpApiService.deleteConnection(orgConnectionId)
      setRemoveFromOrgTarget(null)
      if (
        catalogDetail?.kind === 'organization'
        && catalogDetail.orgConnectionId === orgConnectionId
      ) {
        setCatalogDetail(null)
      }
      await loadOrgConnections()
      toast({
        title: t('mcpConnections.removeFromOrg.success', {
          name,
          defaultValue: `「${name}」已从组织精选中移除`,
        }),
      })
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      toast({
        title: t('mcpConnections.removeFromOrg.failed', {
          defaultValue: '从组织移除失败',
        }),
        description: rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  const findLocalMirrorForOrg = (orgConnectionId: string): LocalMcpConnectionSummary | undefined =>
    connections.find(
      connection =>
        connection.source.kind === 'organization'
        && connection.source.orgConnectionId === orgConnectionId,
    )

  const resolveOrgPickLocalConnection = (
    orgConnection: OrgMcpConnection,
  ): LocalMcpConnectionSummary | undefined => {
    const mineMatch = findMatchingMineConnectionForOrg(orgConnection, mineConnections)
    const mirror = findLocalMirrorForOrg(orgConnection.id)
    if (mineMatch && mirror) return mergeAttachedAgentIdsForDisplay(mineMatch, mirror)
    return mineMatch ?? mirror
  }

  /** 分享者场景：组织镜像上的 Agent 绑定迁回「我的」，避免两条连接各记一份。 */
  const migrateOrgMirrorAgentsToMine = async (
    mine: LocalMcpConnectionSummary,
    mirror: LocalMcpConnectionSummary,
  ) => {
    const mineIds = new Set(mine.attachedAgentIds)
    const toMigrate = mirror.attachedAgentIds.filter(agentId => !mineIds.has(agentId))
    if (toMigrate.length === 0 && mirror.attachedAgentIds.length === 0) return
    const results = await Promise.allSettled([
      ...toMigrate.map(agentId =>
        window.tabtin.localMcp.attachConnection(mine.id, agentId, true),
      ),
      ...mirror.attachedAgentIds.map(agentId =>
        window.tabtin.localMcp.attachConnection(mirror.id, agentId, false),
      ),
    ])
    const failed = results.filter(result => result.status === 'rejected')
    await loadPanelData('refresh')
    if (failed.length > 0) {
      const first = failed[0] as PromiseRejectedResult
      const rawMsg = first.reason instanceof Error
        ? first.reason.message
        : String(first.reason ?? 'migrate failed')
      toast({
        title: t('mcpConnections.migrateAgentsPartialFailed', {
          defaultValue: '部分 Agent 绑定未能从组织镜像迁回「我的」',
        }),
        description: rawMsg,
        variant: 'destructive',
      })
    }
  }

  const requestUninstallConnection = (connection: LocalMcpConnectionSummary) => {
    if (managedConnectionId === connection.id) {
      setManagedConnectionId(null)
    }
    if (catalogDetail?.kind === 'mine' && catalogDetail.connectionId === connection.id) {
      setCatalogDetail(null)
    }
    handleDeleteConnection(connection)
  }

  const openMineAgentManage = async (connection: LocalMcpConnectionSummary) => {
    const orgShare = findOrgShare(connection)
    const mirror = orgShare ? findLocalMirrorForOrg(orgShare.id) : undefined
    if (mirror && mirror.attachedAgentIds.length > 0) {
      setBusyKey(`agents:${connection.id}`)
      try {
        await migrateOrgMirrorAgentsToMine(connection, mirror)
      } finally {
        setBusyKey(null)
      }
    }
    setManagedConnectionId(connection.id)
  }

  const ensureOrgMirrorAndManage = async (orgConnection: OrgMcpConnection) => {
    // 分享者本机已有同源「我的」连接时，直接管那条，避免组织镜像与「我的」Agent 状态分叉。
    const mineMatch = findMatchingMineConnectionForOrg(orgConnection, mineConnections)
    if (mineMatch) {
      const mirror = findLocalMirrorForOrg(orgConnection.id)
      if (mirror && mirror.attachedAgentIds.length > 0) {
        setBusyKey(`org-mirror:${orgConnection.id}`)
        try {
          await migrateOrgMirrorAgentsToMine(mineMatch, mirror)
        } finally {
          setBusyKey(null)
        }
      }
      setManagedConnectionId(mineMatch.id)
      return
    }

    // 其他成员本机没有同源连接：写组织镜像（不含明文凭据），再配置 Agent。
    setBusyKey(`org-mirror:${orgConnection.id}`)
    try {
      const configHeaders =
        orgConnection.config && typeof orgConnection.config.headers === 'object'
          && orgConnection.config.headers
          ? Object.keys(orgConnection.config.headers as Record<string, unknown>)
          : []
      const headerKeys = orgConnection.has_credential
        ? Array.from(new Set(['Authorization', ...configHeaders]))
        : configHeaders
      const mirrored = await window.tabtin.localMcp.upsertOrganizationMirror({
        orgConnectionId: orgConnection.id,
        name: orgConnection.name,
        description: orgConnection.description || undefined,
        url: orgConnection.endpoint,
        headerKeys,
        enabled: orgConnection.enabled,
      })
      await loadPanelData('refresh')
      setManagedConnectionId(mirrored.id)
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: '操作失败' }),
        description: rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  const handleSaveManagedAgents = async () => {
    if (!managedConnection) return
    const { additions, removals } = diffManageableAgentAssignments(
      managedConnection.attachedAgentIds,
      managedAgentIds,
      manageableAgentIdSet,
    )
    const catalogEntry = findRecommendedCatalogEntryForConnection(managedConnection)
    const authGate = resolveConnectorAuthGate({
      connection: managedConnection,
      catalogEntry,
    })
    const pendingAgentAssignments: PendingAgentAssignments = { additions, removals }
    const hasAssignmentDiff = additions.length > 0 || removals.length > 0

    // 未授权 / 探测失败：先过 OAuth 或凭证闸门；成功后再提交 Agent 增删（失败则原配置不变）
    if (authGate === 'oauth' && catalogEntry) {
      if (await shouldUseGitHubPatFallback(catalogEntry)) {
        setCredentialFlow({
          entry: catalogEntry,
          connectionId: managedConnection.id,
          mode: 'api_key',
          createdInFlow: false,
          pendingAgentAssignments: hasAssignmentDiff ? pendingAgentAssignments : undefined,
        })
        return
      }
      setOauthFlow({
        entry: catalogEntry,
        connectionId: managedConnection.id,
        step: 'prompt',
        createdInFlow: false,
        assignedAgentCount: getManageableAttachedAgentIds(
          managedConnection.attachedAgentIds,
          manageableAgentIdSet,
        ).length,
        pendingAgentAssignments: hasAssignmentDiff ? pendingAgentAssignments : undefined,
      })
      return
    }
    if ((authGate === 'api_key' || authGate === 'app_credentials') && catalogEntry) {
      setCredentialFlow({
        entry: catalogEntry,
        connectionId: managedConnection.id,
        mode: authGate,
        createdInFlow: false,
        pendingAgentAssignments: hasAssignmentDiff ? pendingAgentAssignments : undefined,
      })
      return
    }

    if (!hasAssignmentDiff) {
      setManagedConnectionId(null)
      return
    }

    const actionKey = `agents:${managedConnection.id}`
    const connectionId = managedConnection.id
    const syncManagedSelection = (attachedAgentIds: readonly string[]) => {
      // signature 不变时 useEffect 不会触发；失败路径必须显式回正勾选。
      setManagedAgentIds(new Set(
        getManageableAttachedAgentIds(attachedAgentIds, manageableAgentIdSet),
      ))
    }
    setBusyKey(actionKey)
    try {
      const results = await Promise.allSettled([
        ...additions.map(agentId =>
          window.tabtin.localMcp.attachConnection(connectionId, agentId, true),
        ),
        ...removals.map(agentId =>
          window.tabtin.localMcp.attachConnection(connectionId, agentId, false),
        ),
      ])
      // 并行 attach 后：先关弹层，再静默重拉 connections（不 discover），避免整页闪一下。
      const failed = results.filter(result => result.status === 'rejected').length
      const succeeded = results.length - failed
      if (failed === 0) {
        toast({
          title: t('mcpConnections.managedAgents.saveSuccess', {
            defaultValue: 'Agent 配置已保存',
          }),
        })
        setManagedConnectionId(null)
        await refreshConnectionsSilent()
        return
      }
      const refreshed = await refreshConnectionsSilent()
      const refreshedConnection = refreshed?.find(connection => connection.id === connectionId)
      syncManagedSelection(
        refreshedConnection?.attachedAgentIds ?? managedConnection.attachedAgentIds,
      )
      const firstError = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )?.reason
      const rawMsg = firstError instanceof Error ? firstError.message : String(firstError ?? '')
      const parsed = parseMcpError(rawMsg)
      const description = parsed
        ? t(`mcpConnections.errors.${parsed.code}`, {
            defaultValue: rawMsg,
            ...parsed.params,
          })
        : rawMsg
      toast({
        title: succeeded > 0
          ? t('mcpConnections.managedAgents.partialFailed', {
              succeeded,
              failed,
              defaultValue: `部分保存成功（${succeeded} 成功，${failed} 失败），已刷新为当前实际配置`,
            })
          : t('mcpConnections.actionFailed', { defaultValue: '操作失败' }),
        description: description || undefined,
        variant: 'destructive',
      })
    } catch (actionError) {
      const refreshed = await refreshConnectionsSilent()
      const refreshedConnection = refreshed?.find(connection => connection.id === connectionId)
      syncManagedSelection(
        refreshedConnection?.attachedAgentIds ?? managedConnection.attachedAgentIds,
      )
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const parsed = parseMcpError(rawMsg)
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: '操作失败' }),
        description: parsed
          ? t(`mcpConnections.errors.${parsed.code}`, {
              defaultValue: rawMsg,
              ...parsed.params,
            })
          : rawMsg,
        variant: 'destructive',
      })
    } finally {
      setBusyKey(null)
    }
  }

  // 设备域 MCP tab 嵌在 SettingsCompositeContainer（h-full min-h-0）内：
  // 页眉 + tab 条固定，列表区 ScrollArea 滚动（对齐 SettingsPanelLayout 行为）。
  const PanelLayout = embedded ? MarketplacePanelLayout : SettingsPanelLayout
  return (
    <PanelLayout>
      {!embedded && !hideHeader ? (
        <SettingsPanelHeader
          icon={<Plug className="h-4 w-4" />}
          title={title ?? t('tabs.mcp')}
          subtitle={subtitle ?? t('mcpConnections.subtitleDevice', {
            defaultValue: '管理这台设备上的本机 MCP 连接，并为每个连接选择启用到哪些 Agent。',
          })}
          meta={
            !isAgentScoped ? (
              <Button
                variant="ghost"
                onClick={() => void loadPanelData('refresh')}
                disabled={loading || refreshing || busyKey !== null}
                className={cn(SETTINGS_CONTROL_SM, 'gap-1')}
              >
                <RefreshCw className={cn('h-3 w-3', (loading || refreshing) && 'animate-spin')} />
                {t('mcp.refresh', { defaultValue: 'Refresh' })}
              </Button>
            ) : null
          }
        />
      ) : null}

      {!embedded && hideHeader && !isAgentScoped ? (
        <div className="mb-3 flex shrink-0 justify-end">
          <Button
            variant="ghost"
            onClick={() => void loadPanelData('refresh')}
            disabled={loading || refreshing || busyKey !== null}
            className={cn(SETTINGS_CONTROL_SM, 'gap-1')}
          >
            <RefreshCw className={cn('h-3 w-3', (loading || refreshing) && 'animate-spin')} />
            {t('mcp.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>
      ) : null}

      {!canManage && (
        <StatusNotice tone="info">
          {t('mcpConnections.readOnlyNoticeDevice', {
            defaultValue: '当前为只读模式，本机 MCP 连接由设备管理员维护。',
          })}
        </StatusNotice>
      )}

      {error ? <StatusNotice tone="info" size="sm" description={error} /> : null}

      {embedded ? (
        <div data-marketplace-layout="prototype">
          <div className="mb-4 flex min-w-0 flex-wrap items-center gap-3 sm:flex-nowrap">
            <p className="w-full min-w-0 text-body leading-relaxed text-muted-foreground/80 sm:flex-1">
              {t('mcpConnections.marketplace.intro', {
                defaultValue: '把外部应用接到 Agent，授权后就能在对话里帮你查、读、操作。',
              })}
            </p>
            <div className="relative min-w-0 flex-1 sm:w-[220px] sm:max-w-[40%] sm:flex-none">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60"
              />
              <Input
                type="search"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={t('mcpConnections.marketplace.searchPlaceholder', {
                  defaultValue: '搜索连接器',
                })}
                aria-label={t('mcpConnections.marketplace.searchLabel', {
                  defaultValue: '搜索连接器',
                })}
                className="h-8 rounded-md border-border/80 bg-transparent pl-8 text-body shadow-none"
              />
            </div>
            {/* ：自定义连接器只属于「我的」；推荐 / 组织精选是浏览货架，不露 + */}
            {marketSource === 'mine' ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-lg"
                    aria-label={t('mcpConnections.marketplace.actionsLabel', {
                      defaultValue: '更多操作',
                    })}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem onClick={openManualCreateDialog}>
                    <Plug className="h-3.5 w-3.5" />
                    {t('mcpConnections.marketplace.customButton', {
                      defaultValue: '自定义连接器',
                    })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>

          <div className="mb-6 flex flex-wrap items-center gap-2" role="tablist">
            {(['recommended', 'organization', 'mine'] as const).map(source => (
              <button
                key={source}
                type="button"
                role="tab"
                aria-selected={marketSource === source}
                onClick={() => {
                  if (shouldResetMarketplaceShelfFilters(marketSource, source)) {
                    // 切「推荐 / 组织精选 / 我的」时清空搜索，避免条件串台。
                    setSearchQuery(EMPTY_MARKETPLACE_SHELF_FILTERS.search)
                  }
                  setMarketSource(source)
                }}
                className={cn(
                  'inline-flex h-7 items-center rounded-full px-3 text-body font-medium transition-colors',
                  marketSource === source
                    ? 'bg-foreground font-semibold text-background'
                    : 'bg-muted/60 text-muted-foreground/80 hover:bg-muted hover:text-foreground',
                )}
              >
                {t(`mcpConnections.marketplace.source.${source}`)}
              </button>
            ))}
          </div>

          {loading || (marketSource === 'organization' && orgLoading) ? (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(20rem,1fr))]" aria-busy>
              {[1, 2, 3, 4].map(item => (
                <Skeleton key={item} height={122} rounded="lg" />
              ))}
            </div>
          ) : marketSource === 'organization' ? (
            orgMarketEmptyKind === 'loadFailed' ? (
              <EmptyState
                title={t('mcpConnections.marketplace.organizationLoadFailed', {
                  defaultValue: '暂时无法加载组织精选',
                })}
                description={t('mcpConnections.marketplace.organizationLoadFailedDescription', {
                  defaultValue: '请稍后重试，或检查网络与登录状态。',
                })}
              />
            ) : orgMarketEmptyKind === 'noMatch' ? (
              <EmptyState
                title={t('mcpConnections.marketplace.noSearchResults', {
                  defaultValue: '没有匹配的连接器',
                })}
                description={t('mcpConnections.marketplace.tryAnotherSearch', {
                  defaultValue: '换个名称、来源或配置关键词试试。',
                })}
              />
            ) : (
              <MarketplacePagination
                key={`${organizationId}:organization:${searchQuery}`}
                items={visibleOrgConnections}
                getKey={orgConnection => orgConnection.id}
                renderItem={orgConnection => {
                  const localConnection = resolveOrgPickLocalConnection(orgConnection)
                  const sharedByMe = isOrgConnectionSharedByCurrentUser(
                    orgConnection,
                    currentUserId,
                    mineConnections,
                  )
                  return (
                    <ConnectorMarketplaceCard
                      name={orgConnection.name}
                      iconQuery={brandIconQueryFromConnection({
                        name: orgConnection.name,
                        url: orgConnection.endpoint,
                        args: localConnection?.args,
                      })}
                      description={
                        orgConnection.description?.trim()
                        || orgConnection.endpoint
                        || t('mcpConnections.marketplace.source.organization', {
                          defaultValue: '组织精选',
                        })
                      }
                      credentialUrl={resolveRecommendedCredentialUrl({
                        connection: localConnection,
                        endpoint: orgConnection.endpoint,
                        name: orgConnection.name,
                      })}
                      sourceLabel={t('mcpConnections.marketplace.source.organization', {
                        defaultValue: '组织精选',
                      })}
                      state={getConnectorMarketState({
                        connection: localConnection,
                        manageableAgentIds: manageableAgentIdSet,
                      })}
                      busy={busyKey === `org-mirror:${orgConnection.id}`}
                      relationLabel={sharedByMe
                        ? t('mcpConnections.marketplace.sharedByMe', {
                            defaultValue: '我分享的',
                          })
                        : undefined}
                      hideAction={sharedByMe}
                      onOpen={() => setCatalogDetail({
                        kind: 'organization',
                        orgConnectionId: orgConnection.id,
                      })}
                      onAction={() => {
                        void ensureOrgMirrorAndManage(orgConnection)
                      }}
                      onUninstall={
                        !sharedByMe
                        && localConnection
                        && canUninstallMarketplaceConnector(localConnection, canManage)
                          ? () => requestUninstallConnection(localConnection)
                          : undefined
                      }
                      t={t}
                    />
                  )
                }}
              />
            )
          ) : (
            marketSource === 'mine' ? (
              <MarketplacePagination
                key={`${organizationId}:mine:${searchQuery}`}
                items={visibleConnections}
                getKey={connection => connection.id}
                renderItem={connection => {
                    const orgShare = findOrgShare(connection)
                    const orgMirror = orgShare
                      ? findLocalMirrorForOrg(orgShare.id)
                      : undefined
                    const stateConnection = mergeAttachedAgentIdsForDisplay(connection, orgMirror)
                    return (
                    <ConnectorMarketplaceCard
                      name={connection.name}
                      iconQuery={brandIconQueryFromConnection(connection)}
                      description={connection.description?.trim() || formatTransport(connection)}
                      credentialUrl={resolveRecommendedCredentialUrl({
                        connection,
                        name: connection.name,
                      })}
                      sourceLabel={connection.source.label}
                      state={getConnectorMarketState({
                        connection: stateConnection,
                        manageableAgentIds: manageableAgentIdSet,
                      })}
                      forceManageAction
                      onOpen={() => setCatalogDetail({
                        kind: 'mine',
                        connectionId: connection.id,
                      })}
                      onAction={() => {
                        void openMineAgentManage(connection)
                      }}
                      onUninstall={
                        canUninstallMarketplaceConnector(connection, canManage)
                          ? () => requestUninstallConnection(connection)
                          : undefined
                      }
                      t={t}
                    />
                    )
                }}
              />
            ) : (
              <MarketplacePagination
                key={`${organizationId}:recommended:${searchQuery}`}
                items={visibleRecommended}
                getKey={entry => entry.id}
                renderItem={entry => {
                    const importedConnection = findConnectionForRecommendedConnector(
                      entry,
                      mineConnections,
                    )
                    const vendorGated = !importedConnection && connectorIsOAuthVendorGated(entry)
                    const marketState = getConnectorMarketState({
                      connection: importedConnection ?? undefined,
                      manageableAgentIds: manageableAgentIdSet,
                    })
                    const repairOauth =
                      Boolean(importedConnection)
                      && marketState.action === 'repair'
                      && connectorIsOAuthReady(entry)
                    return (
                      <ConnectorMarketplaceCard
                        name={entry.name}
                        iconQuery={brandIconQueryFromRecommended(entry)}
                        description={recommendedCatalogDescription(entry)}
                        credentialUrl={
                          entry.authKind === 'api_key' || entry.authKind === 'app_credentials'
                            ? entry.credentialUrl
                            : undefined
                        }
                        sourceLabel={t('mcpConnections.marketplace.source.recommended', {
                          defaultValue: '推荐',
                        })}
                        state={marketState}
                        busy={busyKey === `import:${entry.id}`}
                        preferGhostAction={vendorGated}
                        actionLabel={
                          vendorGated
                            ? t('mcpConnections.marketplace.vendorGate.action', {
                                defaultValue: '即将开放',
                              })
                            : repairOauth
                              ? t('mcpConnections.marketplace.reauthorizeAction', {
                                  defaultValue: '重新授权',
                                })
                              : undefined
                        }
                        onOpen={() => setCatalogDetail({
                          kind: 'recommended',
                          catalogId: entry.id,
                        })}
                        onAction={() => {
                          if (importedConnection) {
                            setManagedConnectionId(importedConnection.id)
                            return
                          }
                          if (vendorGated) {
                            openVendorGate(entry)
                            return
                          }
                          void handleInstallRecommended(entry)
                        }}
                        onUninstall={
                          importedConnection
                          && canUninstallMarketplaceConnector(importedConnection, canManage)
                          && !repairOauth
                            ? () => requestUninstallConnection(importedConnection)
                            : undefined
                        }
                        t={t}
                      />
                    )
                }}
              />
            )
          )}

          {!loading &&
          marketSource !== 'organization' &&
          (marketSource === 'mine' ? visibleConnections.length === 0 : visibleRecommended.length === 0) ? (
            <EmptyState
              title={t('mcpConnections.marketplace.noSearchResults', {
                defaultValue: '没有匹配的连接器',
              })}
              description={t('mcpConnections.marketplace.tryAnotherSearch', {
                defaultValue: '换个名称、来源或配置关键词试试。',
              })}
            />
          ) : null}
        </div>
      ) : null}

      {!embedded ? (
        <>
          <SettingsSectionCard
            title={
              isAgentScoped
                ? t('mcpConnections.connections.carriedTitle', {
                    defaultValue: '已携带的工具',
                  })
                : t('mcpConnections.connections.title', {
                    defaultValue: '已接入的外部工具',
                  })
            }
            subtitle={
              isAgentScoped
                ? t('mcpConnections.connections.subtitleAgentScope', {
                    defaultValue: '这个 AI 分身会携带的本机 MCP；关掉即卸下，工具本身仍留在本机。',
                  })
                : t('mcpConnections.connections.subtitle', {
                    defaultValue: '开启并挂载后，当前 Agent 就可以在对话中调用它们。',
                  })
            }
            icon={<Plug className="h-4 w-4" />}
            actions={
              canManage && (
                <Button
                  size="sm"
                  onClick={() => {
                    if (isAgentScoped) {
                      setToolPickerOpen(true)
                    } else {
                      openManualCreateDialog()
                    }
                  }}
                  disabled={busyKey !== null || (isAgentScoped && loading)}
                  className="h-7 px-2 text-body gap-1"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {isAgentScoped
                    ? t('mcpConnections.agentScope.addButton', {
                        defaultValue: '添加工具',
                      })
                    : t('mcpConnections.manual.addButton', {
                        defaultValue: '手动添加',
                      })}
                </Button>
              )
            }
          >
            {listedConnections.length === 0 ? (
              <EmptyState
                title={
                  searchQuery.trim()
                    ? t('mcpConnections.marketplace.noSearchResults', {
                        defaultValue: '没有匹配的连接器',
                      })
                    : isAgentScoped
                      ? t('mcpConnections.agentScope.emptyTitle', {
                          defaultValue: '还没携带任何工具',
                        })
                      : t('mcpConnections.connections.emptyTitle', {
                          defaultValue: '还没有接入任何外部工具',
                        })
                }
                description={
                  searchQuery.trim()
                    ? t('mcpConnections.marketplace.tryAnotherSearch', {
                        defaultValue: '换个名称、来源或配置关键词试试。',
                      })
                    : isAgentScoped
                      ? t('mcpConnections.agentScope.emptyDesc', {
                          defaultValue:
                            '点「添加工具」，从连接器库（推荐、组织精选、我的）里挑还未挂上的。',
                        })
                      : t('mcpConnections.connections.emptyDesc', {
                          defaultValue: '你可以从上方的发现列表中一键接入，或者手动添加新的工具。',
                        })
                }
              />
            ) : (
              <div className="space-y-3">
                {listedConnections.map(connection => {
                  const transportLine = formatTransport(connection)
                  const keySummary = formatKeySummary(connection.envKeys, connection.headerKeys)
                  const enabledAgentCount = connection.attachedAgentIds.filter(id =>
                    manageableAgentIdSet.has(id),
                  ).length
                  const mountedToScope = Boolean(
                    scopeAgentId && connection.attachedAgentIds.includes(scopeAgentId),
                  )
                  const marketState = getConnectorMarketState({
                    connection,
                    manageableAgentIds: manageableAgentIdSet,
                  })

                  return (
                    <div
                      key={connection.id}
                      className="space-y-3 rounded-lg border border-border/30 bg-background/60 p-3"
                    >
                      {!isAgentScoped && connection.requiresAgentSelection && (
                        <StatusNotice tone="warning" size="sm">
                          {t('mcpConnections.agentScopeMigrationNotice', {
                            defaultValue: '历史启用关系无法安全映射到 Agent，请重新选择可使用此连接的 Agent。',
                          })}
                        </StatusNotice>
                      )}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-body font-medium text-foreground">{connection.name}</span>
                            <MiniBadge>{connection.source.label}</MiniBadge>
                            <MiniBadge>{connection.transportKind.toUpperCase()}</MiniBadge>
                            <MiniBadge tone={lifecycleBadgeTone(marketState.lifecycle)}>
                              {marketState.statusLabel}
                            </MiniBadge>
                          </div>

                          {(() => {
                            const catalogEntry = findRecommendedCatalogEntryForConnection(connection)
                            const descriptionText =
                              connection.description?.trim()
                              || (catalogEntry
                                ? recommendedCatalogDescription(catalogEntry)
                                : '')
                            const credentialGuide = catalogEntry?.credentialUrl
                              ? t('mcpConnections.marketplace.credentialGuide', {
                                  url: catalogEntry.credentialUrl,
                                  defaultValue: `此连接器需完成官方验证后可使用，密钥获取地址 ${catalogEntry.credentialUrl}`,
                                })
                              : ''
                            return (
                              <>
                                {descriptionText ? (
                                  <MarketplaceCardText
                                    text={descriptionText}
                                    lines={2}
                                    className="text-caption leading-relaxed text-muted-foreground/80"
                                  />
                                ) : null}
                                {credentialGuide ? (
                                  <MarketplaceCardText
                                    text={credentialGuide}
                                    lines={1}
                                    className="text-caption leading-relaxed text-muted-foreground/60"
                                  />
                                ) : null}
                              </>
                            )
                          })()}

                          {!isAgentScoped ? (
                            <>
                              <div className="text-body text-muted-foreground/80 break-all">{transportLine}</div>

                              {connection.source.path && (
                                <div className="font-mono text-caption text-muted-foreground/55 break-all">
                                  {connection.source.path}
                                </div>
                              )}

                              {keySummary && (
                                <div className="text-caption text-muted-foreground/55 break-all">{keySummary}</div>
                              )}

                              <div className="flex flex-wrap items-center gap-1 text-caption text-muted-foreground/55">
                                <span>connection_id</span>
                                <code className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-caption text-foreground/80">
                                  {connection.id}
                                </code>
                                <button
                                  type="button"
                                  onClick={() => void handleCopy(`connection:${connection.id}`, connection.id)}
                                  className="rounded p-0.5 transition-colors hover:bg-muted/40"
                                >
                                  {copied === `connection:${connection.id}` ? (
                                    <Check className="h-3 w-3 text-success" />
                                  ) : (
                                    <Copy className="h-3 w-3 text-muted-foreground/45" />
                                  )}
                                </button>
                              </div>

                              <div className="text-caption text-muted-foreground/55">
                                {t('mcpConnections.connections.enabledAgentsCount', {
                                  defaultValue: `已启用到 ${enabledAgentCount} 个 Agent`,
                                  count: enabledAgentCount,
                                })}
                              </div>
                            </>
                          ) : null}
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-body text-muted-foreground/60">
                              {isAgentScoped
                                ? t('mcpConnections.connections.carryToggle', {
                                    defaultValue: '携带',
                                  })
                                : t('mcpConnections.connections.enableToggle', {
                                    defaultValue: '启用',
                                  })}
                            </span>
                            <Switch
                              checked={isAgentScoped ? mountedToScope : connection.enabled}
                              disabled={!canManage || busyKey !== null}
                              onCheckedChange={checked => {
                                if (isAgentScoped) {
                                  void handleScopeAgentMount(connection.id, checked)
                                } else {
                                  void handleSetEnabled(connection.id, checked)
                                }
                              }}
                            />
                          </div>
                          <div className="flex flex-wrap justify-end gap-2">
                            {!isAgentScoped ? (
                              <AgentAttachControl
                                connection={connection}
                                agents={agents}
                                disabled={!canManage || busyKey !== null}
                                onToggle={(agentId, next) => void handleAttachConnection(connection.id, agentId, next)}
                                t={t}
                              />
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canManage || busyKey !== null}
                              onClick={() => void handleProbeConnection(connection.id)}
                            >
                              {t('mcpConnections.connections.probe', {
                                defaultValue: '探测',
                              })}
                            </Button>
                            {(connection.source.kind === 'manual' || connection.source.kind === 'organization') && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!canManage || busyKey !== null}
                                onClick={() => void handleEditManualConnection(connection.id)}
                              >
                                <Pencil className="mr-1 h-3 w-3" />
                                {t('mcpConnections.connections.editButton', {
                                  defaultValue: '编辑',
                                })}
                              </Button>
                            )}
                            {!isAgentScoped && canShareConnectionToOrg(connection) && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busyKey !== null}
                                onClick={() => requestShareToOrg(connection)}
                              >
                                <Users className="mr-1 h-3 w-3" />
                                {t('mcpConnections.shareToOrg.action', {
                                  defaultValue: '共享给组织',
                                })}
                              </Button>
                            )}
                            {!isAgentScoped && connection.transportKind === 'stdio' && !isPersonalOrganization && organizationId && canManage && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled
                                title={t('mcpConnections.shareToOrg.httpOnly', {
                                  defaultValue: '仅远程（HTTP）连接器可共享给组织',
                                })}
                              >
                                <Users className="mr-1 h-3 w-3" />
                                {t('mcpConnections.shareToOrg.action', {
                                  defaultValue: '共享给组织',
                                })}
                              </Button>
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              disabled={!canManage || busyKey !== null}
                              onClick={() => handleDeleteConnection(connection)}
                              className="h-8 w-8"
                            >
                              <Trash2 className="h-4 w-4 text-muted-foreground/80" />
                            </Button>
                          </div>
                        </div>
                      </div>

                      <ProbeSummary probe={connection.lastProbe} />
                    </div>
                  )
                })}
              </div>
            )}
          </SettingsSectionCard>

          {/* ─── 发现的可用工具（设备域；携带集改走「添加工具」挑选器） ─── */}
          {!isAgentScoped && discovery && discovery.candidates.length > 0 && (
            <SettingsSectionCard
              title={
                embedded
                  ? t('mcpConnections.marketplace.discoveredTitle', {
                      defaultValue: '从本机发现',
                    })
                  : t('mcpConnections.discovery.title', {
                      defaultValue: '发现的可用工具 (从其他应用同步)',
                    })
              }
              subtitle={t('mcpConnections.discovery.subtitle', {
                defaultValue: '自动扫描本机 Cursor 或 Claude Desktop 的配置，一键接入即可让当前 Agent 使用这些工具。',
              })}
              icon={<Search className="h-4 w-4" />}
            >
              {visibleCandidates.length === 0 ? (
                <EmptyState
                  title={t('mcpConnections.marketplace.noSearchResults', {
                    defaultValue: '没有匹配的连接器',
                  })}
                  description={t('mcpConnections.marketplace.tryAnotherSearch', {
                    defaultValue: '换个名称、来源或配置关键词试试。',
                  })}
                />
              ) : (
                <div className="space-y-3">
                  {visibleCandidates.map(candidate => {
                    const imported = !!candidate.importedConnectionId
                    const attachedAgentIds = candidate.attachedAgentIds ?? []
                    const enabledAgentCount = attachedAgentIds.filter(id => manageableAgentIdSet.has(id)).length
                    const actionBusy = busyKey === `import:${candidate.id}`

                    return (
                      <div key={candidate.id} className="rounded-lg border border-border/30 bg-background/60 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-body font-medium text-foreground">{candidate.name}</span>
                              <MiniBadge>{candidate.source.label}</MiniBadge>
                              <MiniBadge>{candidate.transportKind.toUpperCase()}</MiniBadge>
                              {imported ? (
                                <MiniBadge tone="muted">
                                  {t('mcpConnections.discovery.imported', {
                                    defaultValue: '已接入',
                                  })}
                                </MiniBadge>
                              ) : (
                                <MiniBadge tone="info">
                                  {t('mcpConnections.discovery.discovered', {
                                    defaultValue: '待接入',
                                  })}
                                </MiniBadge>
                              )}
                            </div>

                            <div className="text-body text-muted-foreground/80 break-all">
                              {formatTransport(candidate)}
                            </div>

                            {candidate.source.path && (
                              <div className="font-mono text-caption text-muted-foreground/55 break-all">
                                {candidate.source.path}
                              </div>
                            )}

                            {formatKeySummary(candidate.envKeys, candidate.headerKeys) && (
                              <div className="text-caption text-muted-foreground/55 break-all">
                                {formatKeySummary(candidate.envKeys, candidate.headerKeys)}
                              </div>
                            )}

                            {!isAgentScoped && enabledAgentCount > 0 && (
                              <div className="text-caption text-muted-foreground/55">
                                {t('mcpConnections.discovery.enabledAgents', {
                                  defaultValue: `已启用到 ${enabledAgentCount} 个 Agent`,
                                  count: enabledAgentCount,
                                })}
                              </div>
                            )}
                            {!isAgentScoped && imported && (
                              <div className="text-caption text-muted-foreground/55">
                                {t('mcpConnections.discovery.manageBelowHint', {
                                  defaultValue: '已在下方“已接入的外部工具”中，可在那里选择启用到哪些 Agent。',
                                })}
                              </div>
                            )}
                            {isAgentScoped && imported && scopeAgentId && (
                              <div className="text-caption text-muted-foreground/55">
                                {(candidate.attachedAgentIds ?? []).includes(scopeAgentId)
                                  ? t('mcpConnections.discovery.mountedHint', {
                                      defaultValue: '已挂到当前 Agent，可在上方列表开关携带。',
                                    })
                                  : t('mcpConnections.discovery.importMountedHint', {
                                      defaultValue: '已接入本机，可在上方列表打开「携带」。',
                                    })}
                              </div>
                            )}
                          </div>

                          {canManage && (
                            <Button
                              size="sm"
                              variant={imported ? 'outline' : 'default'}
                              disabled={imported || actionBusy || busyKey !== null}
                              onClick={() => {
                                if (!imported) void handleImportCandidate(candidate)
                              }}
                              className="shrink-0"
                            >
                              {imported
                                ? t('mcpConnections.discovery.importedButton', {
                                    defaultValue: '已接入',
                                  })
                                : isAgentScoped
                                  ? t('mcpConnections.discovery.importButtonAgentScope', {
                                      defaultValue: '接入并携带',
                                    })
                                  : t('mcpConnections.discovery.importButtonDevice', { defaultValue: '接入到本机' })}
                            </Button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </SettingsSectionCard>
          )}
        </>
      ) : null}

      <Sheet
        open={catalogDetailOpen}
        onOpenChange={open => {
          if (!open) setCatalogDetail(null)
        }}
      >
        <SheetContent
          side="right"
          closeable={false}
          className="app-region-no-drag no-drag flex w-full flex-col gap-0 p-0 sm:max-w-[640px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <VisuallyHidden>
            <SheetTitle>
              {detailMineConnection?.name
                ?? detailRecommendedEntry?.name
                ?? detailOrgConnection?.name
                ?? ''}
            </SheetTitle>
          </VisuallyHidden>
          <div
            className="app-region-no-drag no-drag flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCatalogDetail(null)}
              aria-label={t('mcpConnections.marketplace.detail.close', { defaultValue: '关闭' })}
              className="app-region-no-drag no-drag h-7 w-7 p-0 text-muted-foreground/80"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {detailMineConnection ? (
              <ConnectorDetailPane
                connection={detailMineConnection}
                canManage={canManage}
                canShareToOrg={canShareConnectionToOrg(detailMineConnection)}
                canRemoveFromOrg={canRemoveConnectionFromOrg(detailMineConnection)}
                busyKey={busyKey}
                onEdit={
                  detailMineConnection.source.kind === 'manual'
                  || detailMineConnection.source.kind === 'organization'
                    ? () => {
                        setCatalogDetail(null)
                        void handleEditManualConnection(detailMineConnection.id)
                      }
                    : undefined
                }
                onConfigureAgents={() => {
                  setCatalogDetail(null)
                  setManagedConnectionId(detailMineConnection.id)
                }}
                onShareToOrg={() => requestShareToOrg(detailMineConnection)}
                onRemoveFromOrg={() => requestRemoveFromOrg(detailMineConnection)}
                onDelete={() => {
                  handleDeleteConnection(detailMineConnection)
                  setCatalogDetail(null)
                }}
                t={t}
              />
            ) : detailRecommendedEntry ? (
              <ConnectorCatalogPreviewPane
                name={detailRecommendedEntry.name}
                description={recommendedCatalogDescription(detailRecommendedEntry)}
                iconQuery={brandIconQueryFromRecommended(detailRecommendedEntry)}
                sourceLabel={t('mcpConnections.marketplace.source.recommended', {
                  defaultValue: '推荐',
                })}
                docsUrl={detailRecommendedEntry.docsUrl}
                credentialUrl={detailRecommendedEntry.credentialUrl}
                t={t}
              />
            ) : detailOrgConnection ? (
              <ConnectorCatalogPreviewPane
                name={detailOrgConnection.name}
                description={detailOrgConnection.description?.trim() || ''}
                iconQuery={brandIconQueryFromConnection({
                  name: detailOrgConnection.name,
                  url: detailOrgConnection.endpoint,
                  args: resolveOrgPickLocalConnection(detailOrgConnection)?.args,
                })}
                sourceLabel={t('mcpConnections.marketplace.source.organization', {
                  defaultValue: '组织精选',
                })}
                credentialUrl={resolveRecommendedCredentialUrl({
                  connection: resolveOrgPickLocalConnection(detailOrgConnection),
                  endpoint: detailOrgConnection.endpoint,
                  name: detailOrgConnection.name,
                })}
                canUnshare={canCurrentUserUnshareOrgConnection({
                  canManage,
                  isPersonalOrganization,
                  organizationId,
                  orgConnection: detailOrgConnection,
                  currentUserId,
                  mineConnections,
                })}
                busyKey={busyKey}
                onUnshare={() => {
                  setRemoveFromOrgTarget(detailOrgConnection)
                }}
                t={t}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      {isAgentScoped ? (
        <AgentToolPickerDialog
          open={toolPickerOpen}
          onOpenChange={setToolPickerOpen}
          items={toolPickerItems}
          pending={busyKey !== null}
          loading={loading || (Boolean(organizationId) && orgLoading)}
          onRetry={() => {
            void loadPanelData('refresh')
            void loadOrgConnections()
          }}
          onPick={item => { void handlePickTool(item) }}
          t={t}
        />
      ) : null}

      <ConnectorOAuthAuthorizeDialog
        open={Boolean(oauthFlow)}
        connectorName={oauthFlow?.entry.name ?? ''}
        step={oauthFlow?.step ?? 'prompt'}
        assignedAgentCount={oauthFlow?.assignedAgentCount ?? 0}
        errorDetail={oauthFlow?.errorDetail}
        authorizeHostHint={
          oauthFlow
            ? authorizeHostHintFromCatalogTransport(oauthFlow.entry.transport)
            : undefined
        }
        onCancel={() => {
          void closeOauthFlow({
            discardDraft:
              Boolean(oauthFlow?.createdInFlow)
              && (oauthFlow?.step === 'prompt' || oauthFlow?.step === 'authorizing'),
            rollbackAgents:
              oauthFlow?.step !== 'success'
              && Boolean(
                oauthFlow?.pendingAgentAssignments
                || oauthFlow?.pendingAttachAgentId,
              ),
          })
        }}
        onAuthorize={() => {
          void runOauthAuthorizeProbe()
        }}
        onRetry={() => {
          void runOauthAuthorizeProbe()
        }}
        onBack={() => {
          void closeOauthFlow({ discardDraft: false, rollbackAgents: true })
        }}
        onDone={() => {
          const connectionId = oauthFlow?.connectionId
          void closeOauthFlow({ discardDraft: false }).then(() => {
            // 成功后回到「配置给 Agent」，勾选已是提交后的真实绑定
            if (connectionId && !isAgentScoped) {
              setManagedConnectionId(connectionId)
            }
          })
        }}
        t={t}
      />

      {credentialFlow ? (
        <ConnectorCredentialDialog
          key={credentialFlow.connectionId}
          open
          mode={credentialFlow.mode}
          connectorName={credentialFlow.entry.name}
          credentialUrl={credentialFlow.entry.credentialUrl}
          docsUrl={credentialFlow.entry.docsUrl}
          saving={credentialSaving}
          onCancel={() => {
            void closeCredentialFlow({
              discardDraft: credentialFlow.createdInFlow,
              rollbackAgents: Boolean(
                credentialFlow.pendingAgentAssignments
                || credentialFlow.pendingAttachAgentId,
              ),
            })
          }}
          onSubmit={value => {
            void handleCredentialSubmit(value)
          }}
          t={t}
        />
      ) : null}

      <ConnectorVendorGateDialog
        open={Boolean(vendorGateEntry)}
        entry={vendorGateEntry}
        onClose={() => setVendorGateEntry(null)}
        t={t}
      />

      <Dialog
        open={!isAgentScoped && Boolean(managedConnection)}
        onOpenChange={open => {
          if (!open) setManagedConnectionId(null)
        }}
      >
        <DialogContent className="max-h-[calc(100vh-3rem)] max-w-[540px] gap-0 overflow-hidden p-0">
          {managedConnection ? (
            <>
              <DialogHeader className="border-b border-border/80 px-5 pb-4 pt-[18px] text-left">
                <DialogTitle className="text-subtitle font-semibold">
                  {t('mcpConnections.marketplace.agentDialog.title', {
                    name: managedConnection.name,
                    defaultValue: `${managedConnection.name} · 配置给 Agent`,
                  })}
                </DialogTitle>
                <DialogDescription className="mt-1 text-body leading-relaxed text-muted-foreground/80">
                  {t('mcpConnections.marketplace.agentDialog.description', {
                    defaultValue: '选择哪些 Agent 可以调用此连接器。未选择的 Agent 不会获得外部服务访问权限。',
                  })}
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 px-5 py-4">
                {managedConnection.requiresAgentSelection ? (
                  <div className="mb-4">
                    <StatusNotice
                      tone="warning"
                      size="sm"
                      description={t('mcpConnections.agentScopeMigrationNotice', {
                        defaultValue: '历史启用关系无法安全映射到 Agent，请重新选择可使用此连接的 Agent。',
                      })}
                    />
                  </div>
                ) : null}

                {managedAuthGate ? (
                  <div className="mb-4">
                    <StatusNotice
                      tone="info"
                      size="sm"
                      description={
                        managedAuthGate === 'oauth'
                          ? t('mcpConnections.marketplace.agentDialog.authGateOauth', {
                              defaultValue: '尚未完成网页授权或连接异常。保存配置时将先完成授权与探测；失败则 Agent 勾选不会生效。',
                            })
                          : managedAuthGate === 'app_credentials'
                            ? t('mcpConnections.marketplace.agentDialog.authGateAppCredentials', {
                                defaultValue: '尚未填写企业应用凭证或连接异常。保存时将先补全凭证并探测；失败则 Agent 勾选不会生效。',
                              })
                            : t('mcpConnections.marketplace.agentDialog.authGateApiKey', {
                                defaultValue: '尚未填写 API Key 或连接异常。保存时将先补全密钥并探测；失败则 Agent 勾选不会生效。',
                              })
                      }
                    />
                  </div>
                ) : null}

                <div className="mb-4 flex items-start gap-2 rounded-lg border border-border/80 bg-muted/30 px-3 py-2.5 text-body leading-relaxed text-muted-foreground/80">
                  <strong className="shrink-0 font-semibold text-foreground">
                    {t('mcpConnections.marketplace.agentDialog.contextTitle', {
                      defaultValue: '运行位置',
                    })}
                  </strong>
                  <span>
                    {t('mcpConnections.marketplace.agentDialog.contextBody', {
                      deviceName:
                        runtimeDeviceName ||
                        t('mcpConnections.marketplace.agentDialog.localDevice', {
                          defaultValue: '本机',
                        }),
                      defaultValue: `此设备 · ${runtimeDeviceName || '本机'}（已连接）。选择 Agent 不会复制连接或凭据。`,
                    })}
                  </span>
                </div>

                <div className="mb-2.5 flex items-center gap-2">
                  <h3 className="min-w-0 flex-1 text-body font-semibold text-foreground">
                    {t('mcpConnections.marketplace.agentDialog.availableAgents', {
                      defaultValue: '可使用的 Agent',
                    })}
                  </h3>
                  <span className="text-caption tabular-nums text-muted-foreground/60">
                    {t('mcpConnections.marketplace.agentDialog.selectedCount', {
                      count: managedAgentIds.size,
                      defaultValue: `已选择 ${managedAgentIds.size} 个`,
                    })}
                  </span>
                  <button
                    type="button"
                    className="text-caption font-medium text-accent-text hover:underline"
                    onClick={() => {
                      const allSelected = agents.length > 0 && managedAgentIds.size === agents.length
                      setManagedAgentIds(allSelected ? new Set() : new Set(agents.map(agent => agent.id)))
                    }}
                  >
                    {agents.length > 0 && managedAgentIds.size === agents.length
                      ? t('mcpConnections.marketplace.agentDialog.clearAll', {
                          defaultValue: '取消全选',
                        })
                      : t('mcpConnections.marketplace.agentDialog.selectAll', {
                          defaultValue: '全选',
                        })}
                  </button>
                </div>

                <ScrollArea className="max-h-[360px]">
                  <div className="grid gap-2 pr-1">
                    {agents.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border/80 px-3 py-8 text-center text-body text-muted-foreground/60">
                        {t('mcpConnections.marketplace.agentDialog.empty', {
                          defaultValue: '当前组织没有可配置的 Agent',
                        })}
                      </p>
                    ) : (
                      agents.map(agent => {
                        const checked = managedAgentIds.has(agent.id)
                        const displayName = agent.display_name || agent.name
                        return (
                          <label
                            key={agent.id}
                            className={cn(
                              'flex cursor-pointer items-start gap-2.5 rounded-[9px] border px-3 py-2.5 transition-colors',
                              checked
                                ? 'border-accent/60 bg-accent/5'
                                : 'border-border/80 hover:border-border hover:bg-muted/20',
                            )}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={value => {
                                setManagedAgentIds(current => {
                                  const next = new Set(current)
                                  if (value === true) next.add(agent.id)
                                  else next.delete(agent.id)
                                  return next
                                })
                              }}
                              aria-label={displayName}
                              className="mt-0.5"
                            />
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-caption font-semibold text-accent-text">
                              {displayName.trim().slice(0, 1)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body font-semibold text-foreground">
                                {displayName}
                              </span>
                              {agent.goal ? (
                                <span className="mt-0.5 block break-words text-caption text-muted-foreground/60">
                                  {agent.goal}
                                </span>
                              ) : null}
                            </span>
                          </label>
                        )
                      })
                    )}
                  </div>
                </ScrollArea>
              </div>

              <DialogFooter className="border-t border-border/80 px-5 py-3.5">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busyKey !== null}
                  onClick={() => setManagedConnectionId(null)}
                >
                  {t('common.cancel', { defaultValue: '取消' })}
                </Button>
                <Button
                  type="button"
                  disabled={!canManage || busyKey !== null}
                  onClick={() => {
                    void handleSaveManagedAgents()
                  }}
                >
                  {busyKey === `agents:${managedConnection.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {managedAuthGate
                    ? t('mcpConnections.marketplace.agentDialog.saveAndAuthorize', {
                        defaultValue: '保存并授权',
                      })
                    : t('mcpConnections.marketplace.agentDialog.save', {
                        defaultValue: '保存配置',
                      })}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(shareTarget)}
        onOpenChange={open => {
          if (!open) setShareTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('mcpConnections.shareToOrg.confirmTitle', {
                defaultValue: '共享给组织',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('mcpConnections.shareToOrg.confirmDescription', {
                name: shareTarget?.name ?? '',
                defaultValue:
                  `共享后，组织成员可在「组织精选」中直接启用「${shareTarget?.name ?? ''}」。endpoint 与凭据将加密保存在组织侧；本机 stdio 命令不会被共享。`,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busyKey !== null}
              onClick={() => setShareTarget(null)}
            >
              {t('mcpConnections.cancelButton', { defaultValue: '取消' })}
            </Button>
            <Button
              type="button"
              disabled={busyKey !== null}
              onClick={() => {
                void confirmShareToOrg()
              }}
            >
              {busyKey?.startsWith('share:') ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('mcpConnections.shareToOrg.confirmButton', {
                defaultValue: '确认共享',
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(removeFromOrgTarget)}
        onOpenChange={open => {
          if (!open) setRemoveFromOrgTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('mcpConnections.removeFromOrg.confirmTitle', {
                defaultValue: '取消分享',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('mcpConnections.removeFromOrg.confirmDescription', {
                name: removeFromOrgTarget?.name ?? '',
                defaultValue:
                  `取消后，「${removeFromOrgTarget?.name ?? ''}」将不再出现在组织精选中；「我的」原件和成员本机已接入的副本都保持不变。`,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busyKey !== null}
              onClick={() => setRemoveFromOrgTarget(null)}
            >
              {t('mcpConnections.cancelButton', { defaultValue: '取消' })}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busyKey !== null}
              onClick={() => {
                void confirmRemoveFromOrg()
              }}
            >
              {busyKey?.startsWith('remove-org:') ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('mcpConnections.removeFromOrg.confirmButton', {
                defaultValue: '确认取消',
              })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={manualDialogOpen}
        onOpenChange={open => {
          setManualDialogOpen(open)
          if (!open) {
            setManualFormError(null)
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {manualForm.connectionId
                ? editingOrganizationMirror
                  ? t('mcpConnections.manual.organizationEditTitle', {
                      defaultValue: '完善我的连接配置',
                    })
                  : embedded
                  ? t('mcpConnections.marketplace.editTitle', {
                      defaultValue: '编辑自定义连接器',
                    })
                  : t('mcpConnections.manual.editTitle', {
                      defaultValue: '编辑手动 MCP 连接',
                    })
                : embedded
                  ? t('mcpConnections.marketplace.createTitle', {
                      defaultValue: '添加自定义连接器',
                    })
                  : t('mcpConnections.manual.createTitle', {
                      defaultValue: '手动添加本机 MCP 连接',
                    })}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {editingOrganizationMirror ? (
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-body text-muted-foreground">
                {t('mcpConnections.manual.organizationEditHint', {
                  defaultValue: '这里保存的是你在本机的补充配置，不会修改组织精选。组织下发的凭据仍会保留；你填写的 URL 和 Headers 会在运行时覆盖或补充组织配置。',
                })}
              </div>
            ) : null}
            <div className="space-y-1">
              <label className="text-body text-muted-foreground">
                {t('mcpConnections.manual.fields.name', {
                  defaultValue: 'Connection name',
                })}
              </label>
              <Input
                value={manualForm.name}
                onChange={event =>
                  setManualForm(prev => ({
                    ...prev,
                    name: event.target.value,
                  }))
                }
                placeholder={t('mcpConnections.manual.fields.namePlaceholder', {
                  defaultValue: 'e.g. Playwright / Figma MCP',
                })}
                disabled={busyKey !== null}
              />
            </div>

            <div className="space-y-1">
              <label className="text-body text-muted-foreground">
                {t('mcpConnections.manual.fields.description', {
                  defaultValue: '描述（可选）',
                })}
              </label>
              <Textarea
                value={manualForm.description}
                onChange={event =>
                  setManualForm(prev => ({
                    ...prev,
                    description: event.target.value,
                  }))
                }
                placeholder={t('mcpConnections.manual.fields.descriptionPlaceholder', {
                  defaultValue: '简要说明这个连接器做什么，方便同事辨认',
                })}
                rows={2}
                disabled={busyKey !== null}
                className="w-full"
              />
            </div>

            <div className="space-y-1">
              <label className="text-body text-muted-foreground">
                {t('mcpConnections.manual.fields.jsonConfig', {
                  defaultValue: 'JSON configuration',
                })}
              </label>
              <Textarea
                value={manualForm.jsonConfig}
                onChange={event =>
                  setManualForm(prev => ({
                    ...prev,
                    jsonConfig: event.target.value,
                  }))
                }
                placeholder={
                  '{\n  "mcpServers": {\n    "playwright": {\n      "command": "npx",\n      "args": ["-y", "@playwright/mcp@latest"]\n    }\n  }\n}'
                }
                rows={10}
                disabled={busyKey !== null}
                className="w-full font-mono"
              />
              <p className="text-caption text-muted-foreground/60">
                {t('mcpConnections.manual.jsonHint', {
                  defaultValue:
                    '支持标准 mcpServers 格式，也接受单个 server 对象。传输类型（stdio / HTTP）自动识别；名称留空时用 JSON 里的 server 名。',
                })}
              </p>
            </div>

            {manualFormError && (
              <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-body text-destructive/80">
                {manualFormError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setManualDialogOpen(false)} disabled={busyKey !== null}>
              {t('common.cancel', { defaultValue: '取消' })}
            </Button>
            <Button onClick={() => void handleSaveManualConnection()} disabled={busyKey !== null}>
              {manualForm.connectionId
                ? t('mcpConnections.manual.saveButton', {
                    defaultValue: '保存修改',
                  })
                : t('mcpConnections.manual.createButton', {
                    defaultValue: '创建并挂载',
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {embedded
                ? t('mcpConnections.marketplace.uninstallConfirmTitle', {
                    defaultValue: '卸载连接器',
                  })
                : t('mcpConnections.deleteConfirmTitle', {
                    defaultValue: 'Delete MCP Connection',
                  })}
            </DialogTitle>
          </DialogHeader>
          <p className="text-body text-muted-foreground">
            {embedded
              ? t('mcpConnections.marketplace.uninstallConfirm', {
                  defaultValue: `确定要卸载「${deleteTarget?.name ?? ''}」吗？卸载后需要重新接入才能使用。`,
                  name: deleteTarget?.name ?? '',
                })
              : t('mcpConnections.deleteConfirm', {
                  defaultValue: `Delete MCP connection "${deleteTarget?.name}"?`,
                  name: deleteTarget?.name ?? '',
                })}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t('mcpConnections.cancelButton', { defaultValue: 'Cancel' })}
            </Button>
            <Button variant="destructive" onClick={() => void confirmDeleteConnection()}>
              {embedded
                ? t('mcpConnections.marketplace.uninstallAction', {
                    defaultValue: '卸载',
                  })
                : t('mcpConnections.deleteButton', { defaultValue: 'Delete' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelLayout>
  )
}

/**
 * AgentAttachControl — 单个本机连接的 Agent 启用范围。
 *
 * 勾选后该 Agent 可调用连接；取消勾选后立即收窄权限。
 */
const AgentAttachControl: React.FC<{
  connection: LocalMcpConnectionSummary
  agents: Agent[]
  disabled: boolean
  onToggle: (agentId: string, attached: boolean) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}> = ({ connection, agents, disabled, onToggle, t }) => {
  const [open, setOpen] = useState(false)
  const attachedSet = useMemo(() => new Set(connection.attachedAgentIds), [connection.attachedAgentIds])
  const enabledCount = useMemo(() => agents.filter(agent => attachedSet.has(agent.id)).length, [agents, attachedSet])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} className="gap-1">
          <Boxes className="h-3 w-3" />
          {enabledCount > 0
            ? t('mcpConnections.spaceAttach.countLabel', {
                defaultValue: `已启用到 ${enabledCount} 个 Agent`,
                count: enabledCount,
              })
            : t('mcpConnections.spaceAttach.selectLabel', {
                defaultValue: '选择启用的 Agent',
              })}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="border-b border-border/20 px-3 py-2">
          <div className="text-caption font-medium text-muted-foreground">
            {t('mcpConnections.spaceAttach.title', {
              defaultValue: '启用到哪些 Agent',
            })}
          </div>
          <div className="text-caption text-muted-foreground/55">
            {t('mcpConnections.spaceAttach.hint', {
              defaultValue: '勾选后该 Agent 即可调用此 MCP 的工具。',
            })}
          </div>
        </div>
        <ScrollArea className="max-h-64">
          <div className="p-1">
            {agents.length === 0 ? (
              <div className="px-3 py-4 text-center text-caption text-muted-foreground/60">
                {t('mcpConnections.spaceAttach.empty', {
                  defaultValue: '没有可用的 Agent',
                })}
              </div>
            ) : (
              agents.map(agent => {
                const checked = attachedSet.has(agent.id)
                return (
                  <div
                    key={agent.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={checked}
                    onClick={() => {
                      if (!disabled) onToggle(agent.id, !checked)
                    }}
                    onKeyDown={e => {
                      if (disabled) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onToggle(agent.id, !checked)
                      }
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-left',
                      disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/30',
                    )}
                  >
                    <Checkbox checked={checked} className="pointer-events-none shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-body">{agent.name}</span>
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

const EmptyState: React.FC<{
  title: string
  description: string
}> = ({ title, description }) => (
  <div className="rounded-lg border border-dashed border-border/40 bg-background/40 px-4 py-5 text-center">
    <div className="text-body font-medium text-foreground">{title}</div>
    <div className="mt-1 text-body text-muted-foreground/65">{description}</div>
  </div>
)

const ConnectorMarketplaceCard: React.FC<{
  name: string
  description: string
  iconQuery: ConnectorBrandIconQuery
  credentialUrl?: string
  sourceLabel: string
  state: ConnectorMarketState
  busy?: boolean
  forceManageAction?: boolean
  relationLabel?: string
  hideAction?: boolean
  actionLabel?: string
  actionDisabled?: boolean
  /** 未接入但非主色 CTA（如「即将开放」） */
  preferGhostAction?: boolean
  onOpen?: () => void
  onAction: () => void
  onUninstall?: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}> = ({
  name,
  description,
  iconQuery,
  credentialUrl,
  sourceLabel,
  state,
  busy = false,
  forceManageAction = false,
  relationLabel,
  hideAction = false,
  actionLabel,
  actionDisabled = false,
  preferGhostAction = false,
  onOpen,
  onAction,
  onUninstall,
  t,
}) => {
  // 与技能市场卡片一致：未接入用主色「接入」；已接入 / 强制管理用次要「管理」。
  const isPrimaryAction =
    !forceManageAction && !preferGhostAction && state.action === 'connect'
  const showManageAction = !hideAction
  const showUninstall = shouldShowMarketplaceUninstall({
    hasUninstallHandler: Boolean(onUninstall),
    hideAction,
    preferGhostAction,
    actionLabel,
    forceManageAction,
    action: state.action,
  })
  const showAssignmentStatus = !hideAction && (state.lifecycle !== 'available' || forceManageAction)
  const credentialGuide = credentialUrl
    ? t('mcpConnections.marketplace.credentialGuide', {
        url: credentialUrl,
        defaultValue: `此连接器需完成官方验证后可使用，密钥获取地址 ${credentialUrl}`,
      })
    : ''

  return (
    <article
      className={cn(
        'flex h-[136px] min-w-0 flex-col overflow-hidden rounded-[10px] border border-border/80 bg-card px-4 py-3.5 shadow-sm transition-colors hover:border-border hover:bg-muted/20 hover:shadow',
        onOpen && 'cursor-pointer',
      )}
      onClick={onOpen}
      onKeyDown={event => {
        if (!onOpen) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <div className="flex min-h-0 min-w-0 flex-1 items-start gap-3 overflow-hidden">
        <ConnectorBrandIcon query={iconQuery} size={34} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <MarketplaceCardText
            text={name}
            lines={1}
            className="text-body font-semibold text-foreground"
          />
          <MarketplaceCardText
            text={description || sourceLabel}
            lines={credentialGuide ? 1 : 2}
            className="mt-1 break-all text-caption leading-relaxed text-muted-foreground/80"
          />
          {credentialGuide ? (
            <MarketplaceCardText
              text={credentialGuide}
              lines={1}
              className="mt-0.5 break-all text-caption leading-relaxed text-muted-foreground/60"
            />
          ) : null}
        </div>
      </div>
      <footer className="mt-2.5 flex shrink-0 items-center justify-end gap-2">
        {relationLabel ? (
          <span className="ml-auto text-caption font-medium text-primary-text">
            {relationLabel}
          </span>
        ) : null}
        {showAssignmentStatus ? (
          <span
            className={cn(
              'mr-auto min-w-0 truncate text-caption font-medium',
              state.assignedAgentCount > 0 ? 'text-primary-text' : 'text-muted-foreground/60',
            )}
          >
            {state.assignedAgentCount > 0
              ? t('mcpConnections.marketplace.assignedAgents', {
                  count: state.assignedAgentCount,
                  defaultValue: `已配置给 ${state.assignedAgentCount} 个 Agent`,
                })
              : t('mcpConnections.marketplace.unassignedAgent', {
                  defaultValue: '尚未配置 Agent',
                })}
          </span>
        ) : null}
        {showManageAction ? (
          <Button
            type="button"
            variant={isPrimaryAction && !actionDisabled ? 'default' : 'ghost'}
            size="sm"
            disabled={busy || actionDisabled}
            onClick={event => {
              event.stopPropagation()
              onAction()
            }}
            className={cn(
              'h-7 shrink-0 rounded-md px-3 text-caption font-medium',
              (!isPrimaryAction || actionDisabled) && 'bg-muted/60 text-foreground hover:bg-muted',
            )}
          >
            {busy
              ? t('mcpConnections.marketplace.connectingAction', {
                  defaultValue: '接入中…',
                })
              : actionLabel
                ? actionLabel
                : isPrimaryAction
                  ? t('mcpConnections.marketplace.connectAction', {
                      defaultValue: '接入',
                    })
                  : t('mcpConnections.marketplace.manageAction', {
                      defaultValue: '管理',
                    })}
          </Button>
        ) : null}
        {showUninstall ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={event => {
              event.stopPropagation()
              onUninstall?.()
            }}
            className="h-7 shrink-0 rounded-md bg-muted/60 px-3 text-caption font-medium text-foreground hover:bg-muted"
          >
            {t('mcpConnections.marketplace.uninstallAction', {
              defaultValue: '卸载',
            })}
          </Button>
        ) : null}
      </footer>
    </article>
  )
}

/** 推荐 / 组织精选：只读名称 + 描述；组织分享者可取消分享。 */
const ConnectorCatalogPreviewPane: React.FC<{
  name: string
  description: string
  iconQuery?: ConnectorBrandIconQuery
  sourceLabel: string
  docsUrl?: string
  credentialUrl?: string
  canUnshare?: boolean
  busyKey?: string | null
  onUnshare?: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}> = ({
  name,
  description,
  iconQuery,
  sourceLabel,
  docsUrl,
  credentialUrl,
  canUnshare = false,
  busyKey = null,
  onUnshare,
  t,
}) => (
  <ScrollArea className="h-full">
    <div className="flex h-full min-h-0 flex-col px-5 py-4">
      <div className="space-y-5">
        <ContextPageHeader
          icon={
            iconQuery ? (
              <ConnectorBrandIcon query={iconQuery} size={40} iconClassName="h-5 w-5" />
            ) : (
              <Plug className="h-7 w-7" />
            )
          }
          title={name}
          description={sourceLabel}
          actions={canUnshare && onUnshare ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busyKey !== null}
              onClick={onUnshare}
              className="shrink-0"
            >
              <Users className="h-[1em] w-[1em]" />
              {t('mcpConnections.removeFromOrg.unshareAction', {
                defaultValue: '取消分享',
              })}
            </Button>
          ) : undefined}
        />

        <div className="space-y-1">
          <h3 className={SETTINGS_GROUP_LABEL}>
            {t('mcpConnections.marketplace.detail.descriptionLabel', {
              defaultValue: '描述',
            })}
          </h3>
          <p className="text-body text-muted-foreground">
            {description.trim()
              || t('mcpConnections.marketplace.detail.descriptionEmpty', {
                defaultValue: '未填写描述',
              })}
          </p>
          {credentialUrl ? (
            <p className="text-caption leading-relaxed text-muted-foreground/60">
              {t('mcpConnections.marketplace.credentialGuidePrefix', {
                defaultValue: '此连接器需完成官方验证后可使用，密钥获取地址',
              })}{' '}
              <a
                href={credentialUrl}
                target="_blank"
                rel="noreferrer"
                className="break-all text-accent hover:underline"
              >
                {credentialUrl}
              </a>
            </p>
          ) : null}
          {docsUrl ? (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-caption text-accent hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {t('mcpConnections.marketplace.detail.docsLink', {
                defaultValue: '官方文档 / GitHub',
              })}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  </ScrollArea>
)

const ConnectorDetailPane: React.FC<{
  connection: LocalMcpConnectionSummary
  canManage: boolean
  canShareToOrg: boolean
  canRemoveFromOrg: boolean
  busyKey: string | null
  onEdit?: () => void
  onConfigureAgents?: () => void
  onShareToOrg: () => void
  onRemoveFromOrg: () => void
  onDelete: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}> = ({
  connection,
  canManage,
  canShareToOrg,
  canRemoveFromOrg,
  busyKey,
  onEdit,
  onConfigureAgents,
  onShareToOrg,
  onRemoveFromOrg,
  onDelete,
  t,
}) => {
  const description = connection.description?.trim() || ''
  const transportSummary = formatTransport(connection)
  const canEdit = Boolean(onEdit) && connection.source.kind === 'manual'

  return (
    <ScrollArea className="h-full">
      <div className="flex h-full min-h-0 flex-col px-5 py-4">
        <div className="space-y-5">
          <ContextPageHeader
            icon={<Plug className="h-7 w-7" />}
            title={connection.name}
            description={connection.source.label}
            actions={(
              <div className="flex shrink-0 items-center gap-1">
                {canEdit ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canManage || busyKey !== null}
                    onClick={onEdit}
                    className="shrink-0"
                  >
                    <Pencil className="h-[1em] w-[1em]" />
                    {t('mcpConnections.connections.editButton', {
                      defaultValue: '编辑',
                    })}
                  </Button>
                ) : null}
                {onConfigureAgents ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canManage || busyKey !== null}
                    onClick={onConfigureAgents}
                    className="shrink-0"
                  >
                    {t('mcpConnections.marketplace.detail.configureAgents', {
                      defaultValue: '配置给 Agent',
                    })}
                  </Button>
                ) : null}
                {canShareToOrg ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyKey !== null}
                    onClick={onShareToOrg}
                    className="shrink-0"
                  >
                    <Users className="h-[1em] w-[1em]" />
                    {t('mcpConnections.shareToOrg.action', {
                      defaultValue: '共享给组织',
                    })}
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 shrink-0 rounded-full p-0 text-muted-foreground/60 hover:text-foreground"
                      aria-label={t('mcpConnections.marketplace.detail.moreActions', {
                        defaultValue: '更多操作',
                      })}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40">
                    {canRemoveFromOrg ? (
                      <DropdownMenuItem
                        disabled={!canManage || busyKey !== null}
                        onClick={onRemoveFromOrg}
                      >
                        {t('mcpConnections.removeFromOrg.unshareAction', {
                          defaultValue: '取消分享',
                        })}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      disabled={!canManage || busyKey !== null}
                      onClick={onDelete}
                      className="text-destructive focus:text-destructive"
                    >
                      {t('mcpConnections.deleteButton', { defaultValue: '删除' })}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          />

          <div className="space-y-1">
            <h3 className={SETTINGS_GROUP_LABEL}>
              {t('mcpConnections.marketplace.detail.descriptionLabel', {
                defaultValue: '描述',
              })}
            </h3>
            <p className="text-body text-muted-foreground">
              {description
                || t('mcpConnections.marketplace.detail.descriptionEmpty', {
                  defaultValue: '未填写描述',
                })}
            </p>
          </div>

          <div className="space-y-1">
            <h3 className={SETTINGS_GROUP_LABEL}>
              {t('mcpConnections.marketplace.detail.transportLabel', {
                defaultValue: '连接配置',
              })}
            </h3>
            <p className="break-all font-mono text-caption leading-relaxed text-muted-foreground/80">
              {transportSummary
                || t('mcpConnections.marketplace.detail.descriptionEmpty', {
                  defaultValue: '未填写描述',
                })}
            </p>
            {canEdit ? (
              <p className="text-caption text-muted-foreground/60">
                {t('mcpConnections.marketplace.detail.editCredentialsHint', {
                  defaultValue: '需要 API Key 或应用凭证时，点「编辑」在 JSON 配置里填写后保存。',
                })}
              </p>
            ) : (
              <p className="text-caption text-muted-foreground/60">
                {t('mcpConnections.marketplace.detail.readOnlyHint', {
                  defaultValue: '详情为只读预览。如需修改配置，请在设置页的连接列表中编辑。',
                })}
              </p>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}

const MiniBadge: React.FC<{
  children: React.ReactNode
  tone?: 'default' | 'success' | 'info' | 'muted'
}> = ({ children, tone = 'default' }) => (
  <span
    className={cn(
      'inline-flex items-center rounded-full border px-2 py-0.5 text-caption font-medium',
      tone === 'success' && 'border-success/20 bg-success/10 text-success',
      tone === 'info' && 'border-info/20 bg-info/10 text-info',
      tone === 'muted' && 'border-border/20 bg-muted/20 text-muted-foreground/80',
      tone === 'default' && 'border-border/20 bg-background/60 text-muted-foreground/75',
    )}
  >
    {children}
  </span>
)

const ProbeSummary: React.FC<{
  probe?: LocalMcpProbeSummary
}> = ({ probe }) => {
  const { t } = useTranslation('space')

  if (!probe) {
    return (
      <div className="rounded-md border border-dashed border-border/30 px-3 py-2 text-body text-muted-foreground/60">
        {t('mcpConnections.connections.neverProbed', {
          defaultValue:
            'This connection has not been probed yet. Run Probe once to confirm tools, resources, and prompts.',
        })}
      </div>
    )
  }

  const toolNames = probe.tools.slice(0, 6).map(tool => tool.name)

  return (
    <div className="space-y-2 rounded-md border border-border/20 bg-muted/10 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <MiniBadge tone={probe.ok ? 'success' : 'muted'}>
          {probe.ok
            ? t('mcpConnections.connections.probeOkLabel', {
                defaultValue: 'Last probe succeeded',
              })
            : t('mcpConnections.connections.probeFailedLabel', {
                defaultValue: 'Last probe failed',
              })}
        </MiniBadge>
        {formatTimestamp(probe.probedAt) && (
          <span className="text-caption text-muted-foreground/55">{formatTimestamp(probe.probedAt)}</span>
        )}
      </div>
      <div className="text-body text-muted-foreground/80">
        {t('mcpConnections.connections.probeCounts', {
          defaultValue: 'tools {{tools}} · resources {{resources}} · prompts {{prompts}}',
          tools: probe.tools.length,
          resources: probe.resources.length,
          prompts: probe.prompts.length,
        })}
      </div>
      {toolNames.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {toolNames.map(name => (
            <span
              key={name}
              className="inline-flex items-center rounded border border-border/20 bg-background/60 px-1.5 py-0.5 font-mono text-caption text-muted-foreground/75"
            >
              {name}
            </span>
          ))}
        </div>
      )}
      {!probe.ok && probe.error && <div className="text-body text-destructive/80 break-all">{probe.error}</div>}
      {!probe.ok &&
        probe.error &&
        (() => {
          const hint = getProbeErrorHint(probe.error, t)
          return hint ? <div className="text-caption text-muted-foreground/60 mt-1">{hint}</div> : null
        })()}
    </div>
  )
}

/**
 * 添加工具挑选器 — 对齐技能携带集的 AgentSkillPickerDialog。
 * 数据源：「技能和连接器 → 连接器」三货架（推荐 + 组织精选 + 我的）里
 * 尚未挂到当前 Agent 的项。
 */
const AgentToolPickerDialog: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
  items: AgentToolPickerItem[]
  pending: boolean
  loading: boolean
  onRetry: () => void
  onPick: (item: AgentToolPickerItem) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}> = ({ open, onOpenChange, items, pending, loading, onRetry, onPick, t }) => {
  const [search, setSearch] = useState('')

  const candidates = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return items
    return items.filter(item => {
      const haystack = [item.name, item.description, item.sourceLabel].join(' ').toLowerCase()
      return haystack.includes(query)
    })
  }, [items, search])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setSearch('')
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<Plug className="h-7 w-7" />}
          title={t('mcpConnections.agentScope.pickerTitle', { defaultValue: '添加工具' })}
          description={t('mcpConnections.agentScope.pickerDescription', {
            defaultValue: '从连接器库里挑一个挂到当前 AI 分身（推荐、组织精选、我的里还未挂上的）。',
          })}
        />

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            aria-label={t('mcpConnections.marketplace.searchLabel', { defaultValue: '搜索连接器' })}
            placeholder={t('mcpConnections.marketplace.searchPlaceholder', {
              defaultValue: '搜索连接器',
            })}
            value={search}
            onChange={event => setSearch(event.target.value)}
            disabled={loading}
            className="h-7 w-full pl-8 text-body"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
              aria-label={t('mcpConnections.agentScope.clearSearch', { defaultValue: '清空搜索' })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <ScrollArea className="max-h-[320px]">
          <div className="space-y-0.5 py-1 pr-1">
            {loading ? (
              <div
                className="space-y-2 py-1"
                aria-busy="true"
                aria-label={t('mcpConnections.agentScope.pickerLoading', {
                  defaultValue: '正在加载工具列表',
                })}
              >
                {[1, 2, 3].map(item => (
                  <div key={item} className="h-12">
                    <Skeleton height="100%" rounded="lg" />
                  </div>
                ))}
              </div>
            ) : candidates.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                {items.length === 0 ? (
                  <>
                    <AlertCircle className="h-5 w-5 text-muted-foreground/40" />
                    <p className="text-body text-foreground-secondary">
                      {t('mcpConnections.agentScope.pickerEmptyPool', {
                        defaultValue:
                          '连接器库里还没有可添加的工具。可先在「技能和连接器 → 连接器」接入推荐或组织精选，或在「我的」里手动添加。',
                      })}
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                      {t('mcp.refresh', { defaultValue: 'Refresh' })}
                    </Button>
                  </>
                ) : (
                  <p className="text-body text-foreground-secondary">
                    {search.trim()
                      ? t('mcpConnections.marketplace.noSearchResults', {
                          defaultValue: '没有匹配的连接器',
                        })
                      : t('mcpConnections.agentScope.pickerEmpty', {
                          defaultValue: '可添加的工具都已经挂上了。',
                        })}
                  </p>
                )}
              </div>
            ) : (
              candidates.map(item => (
                <div
                  key={`${item.kind}:${item.id}`}
                  className="flex items-center gap-2.5 rounded-interactive px-2 py-2 hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]"
                >
                  <Plug className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">
                      {item.name}
                    </span>
                    <span
                      className="block truncate text-caption text-foreground-secondary"
                      title={item.description || item.sourceLabel}
                    >
                      {item.sourceLabel}
                      {item.description ? ` · ${item.description}` : ''}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => onPick(item)}
                    className="shrink-0"
                  >
                    {t('mcpConnections.agentScope.pickAction', { defaultValue: '添加' })}
                  </Button>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
