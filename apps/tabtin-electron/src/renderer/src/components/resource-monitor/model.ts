import type { Space } from '@tabtin/app-shell'
import i18n from '@/i18n'
import type {
  TabDocRuntimeMonitorSnapshot,
  TabDocRuntimeOwnerStrategy,
} from '@components/context-space/tabdoc/tabdoc-runtime-monitor'
import type {
  TabDataRuntimeMonitorSnapshot,
  TabDataRuntimeOwnerStrategy,
} from '@components/table/table-runtime-monitor'
import type {
  ResourceMonitorBrowserViewMetrics,
  ResourceMonitorPtySessionMetrics,
  ResourceMonitorRunStats,
  ResourceMonitorSnapshot,
} from '@shared/types/resource-monitor'
import type { TerminalSession, TerminalSessionSource } from '@components/context-space/sources/terminal'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { CrawlspaceConfig, CrawlspaceContextCache } from '@stores/crawlTab/types'
import { parseTabKey } from '@stores/contextTabs/helpers'
import type {
  ResourceMonitorBrowserHistorySummary,
  ResourceMonitorHistoryState,
  ResourceMonitorHistoryTrendSummary,
} from './history'
import {
  getBackgroundSeverity,
  getBrowserSeverity,
  getOverviewSeverity,
  getTabDataRuntimeSeverity,
  getTabDocRuntimeSeverity,
  type ResourceMonitorSeverity,
} from './severity'

const DEFAULT_SPACE_NAME = '未命名 Space'
const CURRENT_SPACE_NAME = '当前 Space'

const APP_TYPE_LABELS: Record<string, string> = {
  tabweb: 'Browser',
  terminal: '终端',
  tabdata: 'TabData',
  tabdoc: 'TabDoc',
  tabslide: 'TabSlide',
  tabcode: 'TabCode',
  tabvideo: 'TabVideo',
  tabsite: 'TabSite',
  tabinbox: '入口中心',
  tabmail: '邮件',
  folder: '文件',
  orchestration: '编排',
  tabtracker: 'Tracker',
  tabchat: 'Chat',
}

const clampPositive = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value)
}

const normalizeString = (value: string | null | undefined): string | null => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed || null
}

const basename = (value: string | null | undefined): string | null => {
  const normalized = normalizeString(value)
  if (!normalized) return null
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? normalized
}

const describeUrl = (value: string | null | undefined): string | null => {
  const normalized = normalizeString(value)
  if (!normalized) return null
  try {
    const parsed = new URL(normalized)
    return parsed.hostname || normalized
  } catch {
    return normalized
  }
}

const getSpaceIdFromConfig = (config: CrawlspaceConfig | undefined): string | null => {
  return config?.spaceId ?? config?.projectId ?? null
}

const getSpaceName = (
  spaceId: string,
  spacesById: Map<string, Space>,
  activeSpaceId: string | null,
): string => {
  const fromStore = spacesById.get(spaceId)?.name
  if (fromStore) return fromStore
  if (spaceId === activeSpaceId) return CURRENT_SPACE_NAME
  return DEFAULT_SPACE_NAME
}

const getTabTypeLabel = (type: string): string => {
  return APP_TYPE_LABELS[type] ?? type
}

const summarizeTabTypes = (tabKeys: string[]): Array<{ type: string; label: string; count: number }> => {
  const counts = new Map<string, { count: number; firstIndex: number }>()
  tabKeys.forEach((tabKey, index) => {
    const parsed = parseTabKey(tabKey)
    if (!parsed) return
    const existing = counts.get(parsed.type)
    if (existing) {
      counts.set(parsed.type, {
        count: existing.count + 1,
        firstIndex: existing.firstIndex,
      })
      return
    }
    counts.set(parsed.type, {
      count: 1,
      firstIndex: index,
    })
  })
  return Array.from(counts.entries())
    .map(([type, meta]) => ({
      type,
      label: getTabTypeLabel(type),
      count: meta.count,
      firstIndex: meta.firstIndex,
    }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      return left.firstIndex - right.firstIndex
    })
    .map(({ firstIndex: _firstIndex, ...entry }) => entry)
}

const countVisiblePanes = (groups: CanvasLayoutGroup[]): number => {
  return groups.reduce((sum, group) => {
    const visibleCount = group.panes.filter((pane) => pane.content?.tabKey).length
    return sum + visibleCount
  }, 0)
}

export type ResourceMonitorTrackedItemKind = 'browser' | 'terminal'
export type ResourceMonitorTrackedItemContextType = 'tabweb' | 'terminal'
export type ResourceMonitorTrackedItemStatus = 'active' | 'loading' | 'idle' | 'closed'

export interface ResourceMonitorTrackedItem {
  kind: ResourceMonitorTrackedItemKind
  contextType: ResourceMonitorTrackedItemContextType
  id: string
  title: string
  subtitle: string
  cpu: number
  memory: number
  spaceId: string | null
  crawlspaceId: string | null
  runId: string | null
  status: ResourceMonitorTrackedItemStatus
  active: boolean
  sharedProcessCount: number
  badgeLabel: string
  tabKey: string
  browserMeta?: {
    attachedToMainWindow: boolean
    isPreview: boolean
    profile: string
  }
}

export interface ResourceMonitorSpaceView {
  spaceId: string
  spaceName: string
  trackedCpu: number
  trackedMemory: number
  totalCpu: number
  totalMemory: number
  totalMemorySharePercent: number
  itemCount: number
  tabCount: number
  paneCount: number
  browserCount: number
  terminalCount: number
  agentCount: number
  runCount: number
  appBreakdown: Array<{ type: string; label: string; count: number }>
  items: ResourceMonitorTrackedItem[]
  topItems: ResourceMonitorTrackedItem[]
  isCurrentSpace: boolean
}

export interface ResourceMonitorBackgroundView {
  severity: ResourceMonitorSeverity
  unassignedCpu: number
  unassignedMemory: number
  overheadCpu: number
  overheadMemory: number
  rendererResidualCpu: number
  rendererResidualMemory: number
  hostOverheadCpu: number
  hostOverheadMemory: number
  totalCpu: number
  totalMemory: number
  itemCount: number
  explanations: ResourceMonitorExplanationNote[]
  items: ResourceMonitorTrackedItem[]
  topItems: ResourceMonitorTrackedItem[]
}

export interface ResourceMonitorExplanationNote {
  title: string
  description: string
}

export interface ResourceMonitorBrowserBucketView {
  id: 'main-window' | 'detached' | 'preview' | 'shared-process' | 'unassigned'
  kind: 'distribution' | 'overlay'
  label: string
  description: string
  count: number
  cpu: number
  memory: number
  memorySharePercent: number
}

export interface ResourceMonitorBrowserInsightsView {
  severity: ResourceMonitorSeverity
  totalCpu: number
  totalMemory: number
  totalMemorySharePercent: number
  totalCount: number
  activeCount: number
  loadingCount: number
  detachedCount: number
  previewCount: number
  sharedProcessViewCount: number
  unassignedCount: number
  currentSpaceCount: number
  closableCount: number
  closableDetachedCount: number
  closablePreviewCount: number
  retainedOffscreenCount: number
  closableItems: ResourceMonitorTrackedItem[]
  memoryTrend: ResourceMonitorHistoryTrendSummary
  cpuTrend: ResourceMonitorHistoryTrendSummary
  historySummary: ResourceMonitorBrowserHistorySummary
  distributionBuckets: ResourceMonitorBrowserBucketView[]
  overlayBuckets: ResourceMonitorBrowserBucketView[]
  governanceNote: string
  explanations: ResourceMonitorExplanationNote[]
  topItems: ResourceMonitorTrackedItem[]
}

export interface ResourceMonitorTabDocRuntimeView {
  severity: ResourceMonitorSeverity
  documentId: string | null
  title: string
  spaceId: string | null
  spaceName: string | null
  tabKey: string | null
  ownerStrategy: TabDocRuntimeOwnerStrategy
  saveState: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
  saveMessage: string | null
  latestVersion: number | null
  revisionCount: number
  historyCount: number
  markdownLength: number
  plaintextLength: number
  wordCount: number
  isCollaborating: boolean
  activeEditorCount: number
  peerCount: number
  isAgentEditing: boolean
  eventStreamStatus: string | null
  isFallback: boolean
  hasYdoc: boolean
  mountedHostCount: number
  visibleHostCount: number
  activePaneHostCount: number
  isCurrentSpace: boolean
  updatedAt: number | null
}

export interface ResourceMonitorTabDataRuntimeView {
  severity: ResourceMonitorSeverity
  tableId: string | null
  title: string
  spaceId: string | null
  spaceName: string | null
  tabKey: string | null
  ownerStrategy: TabDataRuntimeOwnerStrategy
  tableRowCount: number
  viewRowCount: number
  loadedRowCount: number
  renderedRowCount: number
  fieldCount: number
  visibleFieldCount: number
  hiddenFieldCount: number
  currentViewId: string | null
  currentViewName: string | null
  filterCount: number
  sortCount: number
  groupCount: number
  hasGrouping: boolean
  hasSubRecordTree: boolean
  isPersonalViewEnabled: boolean
  currentPage: number
  currentPageSize: number
  gridLoading: boolean
  isRecordsLoading: boolean
  isRecordLoading: boolean
  selectedRowCount: number
  useViewData: boolean
  collabStatus: string | null
  isCollabOnline: boolean
  peerCount: number
  isCollabFallback: boolean
  engineId: string
  engineScopeId: string | null
  scrollFpsP95: number | null
  scrollFpsAverage: number | null
  inputLatencyP95: number | null
  inputLatencyAverage: number | null
  scrollFpsSampleCount: number
  inputLatencySampleCount: number
  hasInteractionSamples: boolean
  errorRatePct: number
  totalOperations: number
  operationErrors: number
  runtimeErrors: number
  mountedHostCount: number
  visibleHostCount: number
  activePaneHostCount: number
  isCurrentSpace: boolean
  updatedAt: number | null
}

export interface ResourceMonitorOverview {
  severity: ResourceMonitorSeverity
  hasSnapshot: boolean
  collectedAt: number | null
  totalCpu: number
  totalMemory: number
  ramSharePercent: number
  trackedCpu: number
  trackedMemory: number
  cpuCoreCount: number
  browserViewCount: number
  ptySessionCount: number
  currentTabCount: number
  totalTabCount: number
  totalPaneCount: number
  totalRuns: number
  activeRuns: number
  trackedSpaceCount: number
  hostUsedMemoryPercent: number
  hostUsedMemory: number
  viewFactoryTotal: number
  viewFactoryInUse: number
  viewFactoryIdle: number
}

export type ResourceMonitorSuggestionTarget =
  | { kind: 'refresh' }
  | { kind: 'space'; spaceId: string }
  | { kind: 'item'; item: ResourceMonitorTrackedItem }
  | { kind: 'close-item'; item: ResourceMonitorTrackedItem }
  | { kind: 'close-items'; items: ResourceMonitorTrackedItem[] }
  | { kind: 'close-tabs'; scopes: ResourceMonitorTabScope[] }
  | { kind: 'tabdata-runtime'; data: ResourceMonitorTabDataRuntimeView }
  | { kind: 'tabdoc-runtime'; doc: ResourceMonitorTabDocRuntimeView }
  | { kind: 'none' }

export interface ResourceMonitorSuggestion {
  id: string
  severity: ResourceMonitorSeverity
  title: string
  description: string
  note: string | null
  actionLabel: string | null
  /** 为 true 时右侧操作按钮置灰（如无可回收空闲 Browser） */
  actionDisabled?: boolean
  target: ResourceMonitorSuggestionTarget
}

export interface ResourceMonitorSessionScope {
  sessionId: string
  spaceId: string
}

export interface ResourceMonitorTabScope {
  spaceId: string
  scopeKey: string
  tabKeys: string[]
}

export interface ResourceMonitorViewModel {
  overview: ResourceMonitorOverview
  history: ResourceMonitorHistoryState
  currentSpace: ResourceMonitorSpaceView | null
  spaces: ResourceMonitorSpaceView[]
  background: ResourceMonitorBackgroundView
  browser: ResourceMonitorBrowserInsightsView
  dataRuntime: ResourceMonitorTabDataRuntimeView | null
  docRuntime: ResourceMonitorTabDocRuntimeView | null
  suggestions: ResourceMonitorSuggestion[]
  topItems: ResourceMonitorTrackedItem[]
}

export interface ResourceMonitorModelInput {
  snapshot: ResourceMonitorSnapshot | null
  history: ResourceMonitorHistoryState
  dataRuntime: TabDataRuntimeMonitorSnapshot | null
  docRuntime: TabDocRuntimeMonitorSnapshot | null
  activeSpaceId: string | null
  /** 当前工作台实际展示的标签 scope；历史 conversation scope 不属于当前打开标签。 */
  activeTabScopeKey?: string | null
  /** 左侧会话列表里的未归档会话；统计和批量关闭都只覆盖这些会话。 */
  sessionScopes?: ReadonlyArray<ResourceMonitorSessionScope>
  /** 当前正式会话已归档时，不把其标签域并入总标签。 */
  excludeActiveTabScope?: boolean
  /** 当前仍在执行或排队的会话；用于纠正缺失 runId 的 Agent Browser 遗留占用标记。 */
  busySessionIds?: ReadonlySet<string>
  spaces: Space[]
  crawlspaceConfigById: Record<string, CrawlspaceConfig>
  crawlspaceContextCache: Record<string, CrawlspaceContextCache>
  tabOrderBySpace: Record<string, string[]>
  activeKeyBySpace: Record<string, string | null | undefined>
  spaceGroupsBySpace: Record<string, CanvasLayoutGroup[]>
  terminalSessionsBySpace: Record<string, TerminalSession[]>
}

type SpaceDraft = {
  spaceId: string
  spaceName: string
  trackedCpu: number
  trackedMemory: number
  browserCount: number
  terminalCount: number
  agentCount: number
  items: ResourceMonitorTrackedItem[]
  tabCount: number
  paneCount: number
  runCount: number
  appBreakdown: Array<{ type: string; label: string; count: number }>
  isCurrentSpace: boolean
}

function createSpaceDraft(
  spaceId: string,
  input: ResourceMonitorModelInput,
  spacesById: Map<string, Space>,
  paneCountBySpace: Map<string, number>,
): SpaceDraft {
  const tabOrder = input.tabOrderBySpace[spaceId] ?? []

  return {
    spaceId,
    spaceName: getSpaceName(spaceId, spacesById, input.activeSpaceId),
    trackedCpu: 0,
    trackedMemory: 0,
    browserCount: 0,
    terminalCount: 0,
    agentCount: 0,
    items: [],
    tabCount: tabOrder.length,
    paneCount: paneCountBySpace.get(spaceId) ?? 0,
    runCount: 0,
    appBreakdown: summarizeTabTypes(tabOrder),
    isCurrentSpace: input.activeSpaceId === spaceId,
  }
}

function createBrowserItem(
  view: ResourceMonitorBrowserViewMetrics,
  input: ResourceMonitorModelInput,
  crawlspaceToSpaceId: Map<string, string>,
  runToSpaceId: Map<string, string>,
  viewTitleById: Map<string, string>,
): ResourceMonitorTrackedItem {
  const resolvedSpaceId = view.spaceId
    ?? (view.crawlspaceId ? crawlspaceToSpaceId.get(view.crawlspaceId) : null)
    ?? (view.runId ? runToSpaceId.get(view.runId) : null)
    ?? null
  const crawlspaceCache = view.crawlspaceId ? input.crawlspaceContextCache[view.crawlspaceId] : null
  const currentScopeActiveKey = input.activeTabScopeKey
    ? input.activeKeyBySpace[input.activeTabScopeKey]
    : undefined
  const contextActiveKey = currentScopeActiveKey !== undefined
    ? currentScopeActiveKey
    : resolvedSpaceId
      ? input.activeKeyBySpace[resolvedSpaceId]
      : undefined
  const hasContextActiveKey = contextActiveKey !== undefined
  const isActive = hasContextActiveKey
    ? contextActiveKey === `tabweb:${view.viewId}`
    : crawlspaceCache?.activeViewId === view.viewId
  const browserScopeKey = view.crawlspaceId
    ? input.crawlspaceConfigById[view.crawlspaceId]?.browserScopeKey
    : undefined
  const conversationSessionId = browserScopeKey?.startsWith('conversation:')
    ? normalizeString(browserScopeKey.slice('conversation:'.length))
    : null
  const isCompletedSessionOrphan = Boolean(
    !isActive
    && !view.runId
    && view.profile === 'agent-workspace'
    && conversationSessionId
    && input.busySessionIds
    && !input.busySessionIds.has(conversationSessionId),
  )
  const isEffectivelyInUse = view.inUse && !isCompletedSessionOrphan
  const title = normalizeString(view.title)
    ?? viewTitleById.get(view.viewId)
    ?? describeUrl(view.url)
    ?? `浏览器标签 ${view.viewId.slice(0, 6)}`

  return {
    kind: 'browser',
    contextType: 'tabweb',
    id: view.viewId,
    title,
    subtitle: [describeUrl(view.url), view.profile].filter(Boolean).join(' · ') || 'Browser 视图',
    cpu: clampPositive(view.cpu),
    memory: clampPositive(view.memory),
    spaceId: resolvedSpaceId,
    crawlspaceId: view.crawlspaceId ?? null,
    runId: view.runId ?? null,
    status: view.isLoading ? 'loading' : isEffectivelyInUse || isActive ? 'active' : 'idle',
    active: isActive,
    sharedProcessCount: Math.max(1, view.sharedProcessCount || 1),
    badgeLabel: view.isPreview ? '预览' : 'Browser',
    tabKey: `tabweb:${view.viewId}`,
    browserMeta: {
      attachedToMainWindow: view.attachedToMainWindow,
      isPreview: view.isPreview,
      profile: view.profile,
    },
  }
}

function inferTerminalSource(
  terminalMeta: TerminalSession | null,
  session: ResourceMonitorPtySessionMetrics,
): TerminalSessionSource {
  if (terminalMeta?.source === 'agent') return 'agent'
  if (session.sessionId.startsWith('agent-')) return 'agent'
  return 'user'
}

function createTerminalItem(
  session: ResourceMonitorPtySessionMetrics,
  input: ResourceMonitorModelInput,
  terminalMetaById: Map<string, TerminalSession>,
): ResourceMonitorTrackedItem {
  const terminalMeta = terminalMetaById.get(session.sessionId) ?? null
  const resolvedSpaceId = session.spaceId ?? terminalMeta?.spaceId ?? null
  const source = inferTerminalSource(terminalMeta, session)
  const contextActiveKey = resolvedSpaceId ? input.activeKeyBySpace[resolvedSpaceId] ?? null : null
  const cwdLabel = basename(terminalMeta?.cwd ?? session.cwd)
  const title = normalizeString(terminalMeta?.title)
    ?? cwdLabel
    ?? `${source === 'agent' ? 'Agent' : '终端'} ${session.sessionId.slice(0, 6)}`

  return {
    kind: 'terminal',
    contextType: 'terminal',
    id: session.sessionId,
    title,
    subtitle: [source === 'agent' ? 'Agent 终端' : '用户终端', cwdLabel].filter(Boolean).join(' · '),
    cpu: clampPositive(session.cpu),
    memory: clampPositive(session.memory),
    spaceId: resolvedSpaceId,
    crawlspaceId: null,
    runId: null,
    status: session.isRunning ? (session.hasPendingCommand ? 'active' : 'idle') : 'closed',
    active: contextActiveKey === `terminal:${session.sessionId}`,
    sharedProcessCount: 1,
    badgeLabel: source === 'agent' ? 'Agent' : 'Terminal',
    tabKey: `terminal:${session.sessionId}`,
  }
}

function sortItemsByPriority(items: ResourceMonitorTrackedItem[]): ResourceMonitorTrackedItem[] {
  return [...items].sort((left, right) => {
    if (right.memory !== left.memory) return right.memory - left.memory
    if (right.cpu !== left.cpu) return right.cpu - left.cpu
    if (left.active !== right.active) return left.active ? -1 : 1
    return left.title.localeCompare(right.title, i18n.language)
  })
}

function buildRunToSpaceId(
  runs: ResourceMonitorRunStats[],
  crawlspaceToSpaceId: Map<string, string>,
): Map<string, string> {
  const mapping = new Map<string, string>()
  runs.forEach((run) => {
    const spaceId = run.spaceId ?? (run.crawlspaceId ? crawlspaceToSpaceId.get(run.crawlspaceId) : null) ?? null
    if (spaceId) {
      mapping.set(run.runId, spaceId)
    }
  })
  return mapping
}

function buildViewTitleById(
  crawlspaceContextCache: Record<string, CrawlspaceContextCache>,
): Map<string, string> {
  const mapping = new Map<string, string>()
  Object.values(crawlspaceContextCache).forEach((cache) => {
    cache.viewList.forEach((view) => {
      const title = normalizeString(view.title)
      if (title) {
        mapping.set(view.viewId, title)
      }
    })
  })
  return mapping
}

function buildTerminalMetaById(
  terminalSessionsBySpace: Record<string, TerminalSession[]>,
): Map<string, TerminalSession> {
  const mapping = new Map<string, TerminalSession>()
  Object.values(terminalSessionsBySpace).forEach((sessions) => {
    sessions.forEach((session) => {
      mapping.set(session.id, session)
    })
  })
  return mapping
}

function finalizeSpaceView(
  draft: SpaceDraft,
  totalMemory: number,
): ResourceMonitorSpaceView {
  const sortedItems = sortItemsByPriority(draft.items)
  const totalSpaceMemory = draft.trackedMemory

  return {
    spaceId: draft.spaceId,
    spaceName: draft.spaceName,
    trackedCpu: clampPositive(draft.trackedCpu),
    trackedMemory: clampPositive(draft.trackedMemory),
    totalCpu: clampPositive(draft.trackedCpu),
    totalMemory: clampPositive(totalSpaceMemory),
    totalMemorySharePercent: totalMemory > 0 ? (totalSpaceMemory / totalMemory) * 100 : 0,
    itemCount: sortedItems.length,
    tabCount: draft.tabCount,
    paneCount: draft.paneCount,
    browserCount: draft.browserCount,
    terminalCount: draft.terminalCount,
    agentCount: draft.agentCount,
    runCount: draft.runCount,
    appBreakdown: draft.appBreakdown,
    items: sortedItems,
    topItems: sortedItems.slice(0, 5),
    isCurrentSpace: draft.isCurrentSpace,
  }
}

const formatShare = (value: number): string => `${clampPositive(value).toFixed(1)}%`

const formatBytesCompact = (value: number): string => {
  const safe = clampPositive(value)
  if (safe >= 1024 * 1024 * 1024) {
    return `${(safe / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  if (safe >= 1024 * 1024) {
    return `${Math.round(safe / (1024 * 1024))} MB`
  }
  return `${Math.round(safe / 1024)} KB`
}

const formatSignedCount = (value: number | null): string | null => {
  if (value == null || value === 0) return null
  return `${value > 0 ? '+' : ''}${Math.round(value)}`
}

const isMainWindowBrowserItem = (item: ResourceMonitorTrackedItem): boolean => {
  return Boolean(item.browserMeta?.attachedToMainWindow) && !Boolean(item.browserMeta?.isPreview)
}

const isDetachedBrowserItem = (item: ResourceMonitorTrackedItem): boolean => {
  return item.browserMeta?.attachedToMainWindow === false && !Boolean(item.browserMeta?.isPreview)
}

const isPreviewBrowserItem = (item: ResourceMonitorTrackedItem): boolean => {
  return Boolean(item.browserMeta?.isPreview)
}

const buildBrowserBucket = (
  items: ResourceMonitorTrackedItem[],
  totalMemory: number,
  config: Pick<ResourceMonitorBrowserBucketView, 'id' | 'kind' | 'label' | 'description'>,
): ResourceMonitorBrowserBucketView => {
  const memory = clampPositive(items.reduce((sum, item) => sum + item.memory, 0))
  const cpu = clampPositive(items.reduce((sum, item) => sum + item.cpu, 0))
  return {
    ...config,
    count: items.length,
    cpu,
    memory,
    memorySharePercent: totalMemory > 0 ? clampPositive((memory / totalMemory) * 100) : 0,
  }
}

export const BROWSER_GOVERNANCE_BOUNDARY_NOTE = '仅会回收脱屏或预览态、且当前不在主窗口使用中的空闲 Browser，不会关闭主窗口里的普通标签。'

const isSafelyClosableBrowserItem = (
  item: ResourceMonitorTrackedItem | null | undefined,
): item is ResourceMonitorTrackedItem => {
  if (!item) return false
  if (item.kind !== 'browser') return false
  if (item.active) return false
  if (item.status !== 'idle') return false
  if (!item.browserMeta) return false
  if (item.browserMeta.attachedToMainWindow && !item.browserMeta.isPreview) return false
  return Boolean(item.spaceId || item.crawlspaceId)
}

const severityWeight = (severity: ResourceMonitorSeverity): number => {
  switch (severity.level) {
    case 'heavy':
      return 3
    case 'attention':
      return 2
    default:
      return 1
  }
}

function buildBrowserExplanationNotes(args: {
  history: ResourceMonitorHistoryState
  distributionBuckets: ResourceMonitorBrowserBucketView[]
  rendererResidualMemory: number
  totalCount: number
  currentSpaceCount: number
  unassignedCount: number
  detachedCount: number
  previewCount: number
  loadingCount: number
  sharedProcessViewCount: number
  closableCount: number
  closableDetachedCount: number
  closablePreviewCount: number
}): ResourceMonitorExplanationNote[] {
  const notes: ResourceMonitorExplanationNote[] = []

  if (args.closableCount > 0) {
    const parts = [`可安全回收 ${args.closableCount} 个 Browser`]
    if (args.closableDetachedCount > 0) {
      parts.push(`${args.closableDetachedCount} 个已脱离主窗口`)
    }
    if (args.closablePreviewCount > 0) {
      parts.push(`${args.closablePreviewCount} 个为预览态`)
    }
    notes.push({
      title: '治理边界',
      description: `${parts.join('，')}。${BROWSER_GOVERNANCE_BOUNDARY_NOTE}`,
    })
  } else if (args.detachedCount > 0 || args.previewCount > 0) {
    notes.push({
      title: '治理边界',
      description: `当前有 ${args.detachedCount} 个脱屏、${args.previewCount} 个预览态 Browser，但它们仍在加载或处于使用中，本轮不会自动关闭。`,
    })
  } else if (args.totalCount > 0) {
    notes.push({
      title: '治理边界',
      description: `当前没有脱屏或预览态的空闲 Browser。${BROWSER_GOVERNANCE_BOUNDARY_NOTE}`,
    })
  }

  if (args.totalCount > 0) {
    notes.push({
      title: '归因状态',
      description: `当前 Space 承载 ${args.currentSpaceCount} 个 Browser，未归因 ${args.unassignedCount} 个${args.loadingCount > 0 ? `，另有 ${args.loadingCount} 个仍在加载中` : ''}。`,
    })
  }

  const dominantDistributionBuckets = args.distributionBuckets
    .filter((bucket) => bucket.count > 0 && bucket.memory > 0)
    .sort((left, right) => {
      if (right.memory !== left.memory) return right.memory - left.memory
      return right.count - left.count
    })

  if (dominantDistributionBuckets.length > 0) {
    const primary = dominantDistributionBuckets[0]
    const secondary = dominantDistributionBuckets[1] ?? null
    notes.push({
      title: '主要来源',
      description: secondary
        ? `当前 Browser 压力主要来自 ${primary.label} ${formatBytesCompact(primary.memory)}（${primary.count} 个），其次是 ${secondary.label} ${formatBytesCompact(secondary.memory)}（${secondary.count} 个）。`
        : `当前 Browser 压力主要来自 ${primary.label} ${formatBytesCompact(primary.memory)}（${primary.count} 个）。`,
    })
  }

  if (args.rendererResidualMemory > 0) {
    notes.push({
      title: '黑盒去向',
      description: `另有 ${formatBytesCompact(args.rendererResidualMemory)} 的共享 renderer 残余尚未稳定映射到具体 Browser 视图，已单列到“后台与宿主”；它可能来自共享 UI、其他 App renderer 或仍待归因的 Browser renderer。`,
    })
  }

  if (args.history.browserSummary.sampleCount >= 2) {
    const trendParts: string[] = []
    if (args.history.browserMemoryTrend.direction === 'up' && (args.history.browserSummary.memoryDelta ?? 0) > 0) {
      trendParts.push(`内存上升 ${formatBytesCompact(args.history.browserSummary.memoryDelta ?? 0)}`)
    } else if (args.history.browserMemoryTrend.direction === 'down' && (args.history.browserSummary.memoryDelta ?? 0) < 0) {
      trendParts.push(`内存回落 ${formatBytesCompact(Math.abs(args.history.browserSummary.memoryDelta ?? 0))}`)
    }
    if (args.history.browserCpuTrend.direction === 'up' && (args.history.browserSummary.cpuDelta ?? 0) > 0) {
      trendParts.push(`CPU 上升 ${Math.round(args.history.browserSummary.cpuDelta ?? 0)}%`)
    } else if (args.history.browserCpuTrend.direction === 'down' && (args.history.browserSummary.cpuDelta ?? 0) < 0) {
      trendParts.push(`CPU 回落 ${Math.round(Math.abs(args.history.browserSummary.cpuDelta ?? 0))}%`)
    }

    const countParts = [
      formatSignedCount(args.history.browserSummary.viewCountDelta)
        ? `视图 ${formatSignedCount(args.history.browserSummary.viewCountDelta)}`
        : null,
      formatSignedCount(args.history.browserSummary.detachedCountDelta)
        ? `脱屏 ${formatSignedCount(args.history.browserSummary.detachedCountDelta)}`
        : null,
      formatSignedCount(args.history.browserSummary.previewCountDelta)
        ? `预览 ${formatSignedCount(args.history.browserSummary.previewCountDelta)}`
        : null,
      formatSignedCount(args.history.browserSummary.loadingCountDelta)
        ? `加载 ${formatSignedCount(args.history.browserSummary.loadingCountDelta)}`
        : null,
    ].filter(Boolean)

    if (trendParts.length > 0 || countParts.length > 0) {
      notes.push({
        title: `近 ${Math.max(1, Math.round(args.history.windowMs / 60000))} 分钟`,
        description: [
          trendParts.join('，'),
          countParts.length > 0 ? `伴随 ${countParts.join('，')}` : null,
        ].filter(Boolean).join('；'),
      })
    }
  }

  if (args.sharedProcessViewCount > 0) {
    notes.push({
      title: '共享进程',
      description: `${args.sharedProcessViewCount} 个 Browser 复用了共享进程，单项占用更适合做解释参考，定位时请结合趋势和回收后的总账变化。`,
    })
  }

  return notes.slice(0, 5)
}

function buildBrowserInsightsView(
  snapshot: ResourceMonitorSnapshot | null,
  items: ResourceMonitorTrackedItem[],
  activeSpaceId: string | null,
  history: ResourceMonitorHistoryState,
): ResourceMonitorBrowserInsightsView {
  const browserMetrics = snapshot?.browserViews ?? []
  const browserItems = sortItemsByPriority(items.filter((item) => item.kind === 'browser'))
  const closableItems = browserItems.filter((item) => isSafelyClosableBrowserItem(item))
  const retainedOffscreenCount = browserItems.filter((item) => (
    isDetachedBrowserItem(item) || isPreviewBrowserItem(item)
  ) && !isSafelyClosableBrowserItem(item)).length
  const closableDetachedCount = closableItems.filter((item) => item.browserMeta && !item.browserMeta.attachedToMainWindow).length
  const closablePreviewCount = closableItems.filter((item) => item.browserMeta?.isPreview).length
  const totalCpu = clampPositive(browserMetrics.reduce((sum, view) => sum + view.cpu, 0))
  const totalMemory = clampPositive(browserMetrics.reduce((sum, view) => sum + view.memory, 0))
  const rendererResidualMemory = clampPositive((snapshot?.app.renderer.memory ?? 0) - totalMemory)
  const totalMemorySharePercent = snapshot?.totalMemory
    ? clampPositive((totalMemory / snapshot.totalMemory) * 100)
    : 0
  const activeCount = browserMetrics.filter((view) => view.inUse).length
  const loadingCount = browserMetrics.filter((view) => view.isLoading).length
  const detachedCount = browserMetrics.filter((view) => !view.attachedToMainWindow).length
  const previewCount = browserMetrics.filter((view) => view.isPreview).length
  const sharedProcessViewCount = browserMetrics.filter((view) => view.sharedProcessCount > 1).length
  const unassignedCount = browserItems.filter((item) => !item.spaceId).length
  const currentSpaceCount = browserItems.filter((item) => item.spaceId === activeSpaceId).length
  const distributionBuckets: ResourceMonitorBrowserBucketView[] = [
    buildBrowserBucket(
      browserItems.filter((item) => isMainWindowBrowserItem(item)),
      totalMemory,
      {
        id: 'main-window',
        kind: 'distribution',
        label: '主窗口标签',
        description: '当前仍挂在主窗口中的常规 Browser 标签',
      },
    ),
    buildBrowserBucket(
      browserItems.filter((item) => isDetachedBrowserItem(item)),
      totalMemory,
      {
        id: 'detached',
        kind: 'distribution',
        label: '脱屏视图',
        description: '已脱离主窗口但仍保活的 Browser 视图',
      },
    ),
    buildBrowserBucket(
      browserItems.filter((item) => isPreviewBrowserItem(item)),
      totalMemory,
      {
        id: 'preview',
        kind: 'distribution',
        label: '预览视图',
        description: '用于预览、临时检查或过渡状态的 Browser 视图',
      },
    ),
  ]
  const overlayBuckets: ResourceMonitorBrowserBucketView[] = [
    buildBrowserBucket(
      browserItems.filter((item) => item.sharedProcessCount > 1),
      totalMemory,
      {
        id: 'shared-process',
        kind: 'overlay',
        label: '共享进程',
        description: '多个 Browser 共用同一 OS 进程，单项占用更偏解释口径',
      },
    ),
    buildBrowserBucket(
      browserItems.filter((item) => !item.spaceId),
      totalMemory,
      {
        id: 'unassigned',
        kind: 'overlay',
        label: '未归因视图',
        description: '还没有稳定映射到具体 Space 的 Browser 视图',
      },
    ),
  ]

  return {
    severity: getBrowserSeverity({
      browserMemorySharePercent: totalMemorySharePercent,
      totalCpu,
      reclaimableViewCount: closableItems.length,
      loadingViewCount: loadingCount,
      unassignedViewCount: unassignedCount,
    }),
    totalCpu,
    totalMemory,
    totalMemorySharePercent,
    totalCount: browserMetrics.length,
    activeCount,
    loadingCount,
    detachedCount,
    previewCount,
    sharedProcessViewCount,
    unassignedCount,
    currentSpaceCount,
    closableCount: closableItems.length,
    closableDetachedCount,
    closablePreviewCount,
    retainedOffscreenCount,
    closableItems,
    memoryTrend: history.browserMemoryTrend,
    cpuTrend: history.browserCpuTrend,
    historySummary: history.browserSummary,
    distributionBuckets,
    overlayBuckets,
    governanceNote: BROWSER_GOVERNANCE_BOUNDARY_NOTE,
    explanations: buildBrowserExplanationNotes({
      history,
      distributionBuckets,
      rendererResidualMemory,
      totalCount: browserMetrics.length,
      currentSpaceCount,
      unassignedCount,
      detachedCount,
      previewCount,
      loadingCount,
      sharedProcessViewCount,
      closableCount: closableItems.length,
      closableDetachedCount,
      closablePreviewCount,
    }),
    topItems: browserItems.slice(0, 5),
  }
}

function buildBackgroundExplanationNotes(args: {
  unassignedMemory: number
  rendererResidualMemory: number
  hostOverheadMemory: number
  totalMemory: number
}): ResourceMonitorExplanationNote[] {
  const notes: ResourceMonitorExplanationNote[] = []
  const dominantOpaque = [
    {
      title: '共享 renderer 残余',
      memory: args.rendererResidualMemory,
      description: 'Electron renderer 总量里仍未稳定映射到具体 Browser / App 视图的部分，可能来自共享 UI、其他 App renderer 或仍待归因的 Browser renderer。',
    },
    {
      title: '宿主与其他开销',
      memory: args.hostOverheadMemory,
      description: '主要包含 Electron 主进程、other 进程，以及当前还无法稳定挂回具体工作单元的系统级开销。',
    },
  ]
    .filter((entry) => entry.memory > 0)
    .sort((left, right) => right.memory - left.memory)

  if (dominantOpaque.length > 0) {
    const primary = dominantOpaque[0]!
    const secondary = dominantOpaque[1] ?? null
    notes.push({
      title: '黑盒拆分',
      description: secondary
        ? `当前背景黑盒主要来自 ${primary.title} ${formatBytesCompact(primary.memory)}，其次是 ${secondary.title} ${formatBytesCompact(secondary.memory)}。`
        : `当前背景黑盒主要来自 ${primary.title} ${formatBytesCompact(primary.memory)}。`,
    })
  }

  if (args.rendererResidualMemory > 0) {
    notes.push({
      title: '共享 renderer 残余',
      description: `已把 ${formatBytesCompact(args.rendererResidualMemory)} 从“宿主开销”里单独拆出，便于和 Browser / App 解释层对照；这部分不是精确分账，不建议直接摊给某一个标签。`,
    })
  }

  if (args.hostOverheadMemory > 0) {
    notes.push({
      title: '宿主与其他',
      description: `仍有 ${formatBytesCompact(args.hostOverheadMemory)} 属于 Electron 主进程或 other 进程开销，这部分更适合结合总账趋势判断，而不是直接归给某个 Space。`,
    })
  }

  if (args.unassignedMemory > 0) {
    notes.push({
      title: '未归因项',
      description: `另有 ${formatBytesCompact(args.unassignedMemory)} 来自尚未稳定映射到 Space 的 Browser / Terminal 项，可先从下方未归属列表回看。`,
    })
  }

  if (args.totalMemory > 0) {
    notes.push({
      title: '口径说明',
      description: '“后台与宿主”展示的是当前还没完全挂回具体 Space 的资源，其中共享 renderer 残余和宿主开销已分开展示，用于收敛黑盒区，不代表精确到单一 renderer 的记账。',
    })
  }

  return notes.slice(0, 4)
}

function buildResourceMonitorSuggestions(args: {
  history: ResourceMonitorHistoryState
  currentSpace: ResourceMonitorSpaceView | null
  background: ResourceMonitorBackgroundView
  browser: ResourceMonitorBrowserInsightsView
  dataRuntime: ResourceMonitorTabDataRuntimeView | null
  docRuntime: ResourceMonitorTabDocRuntimeView | null
}): ResourceMonitorSuggestion[] {
  const candidates: Array<{ priority: number; suggestion: ResourceMonitorSuggestion }> = []

  if (args.background.severity.level !== 'healthy') {
    const focusItem = args.background.topItems.find((item) => item.spaceId) ?? null
    const opaqueParts = [
      args.background.hostOverheadMemory > 0
        ? `宿主与其他开销约 ${formatBytesCompact(args.background.hostOverheadMemory)}`
        : null,
      args.background.rendererResidualMemory > 0
        ? `共享 renderer 残余约 ${formatBytesCompact(args.background.rendererResidualMemory)}`
        : null,
    ].filter(Boolean)
    const dominantOpaqueLabel = opaqueParts.length > 0
      ? `其中${opaqueParts.join('，')}。`
      : null
    candidates.push({
      priority: severityWeight(args.background.severity) * 10 + 8,
      suggestion: {
        id: 'background-overhead',
        severity: args.background.severity,
        title: '优先检查后台与宿主开销',
        description: focusItem
          ? `${args.background.severity.reason}${dominantOpaqueLabel ? `，${dominantOpaqueLabel}` : ''}可以先回到 ${focusItem.title} 所在上下文排查。`
          : dominantOpaqueLabel
            ? `${args.background.severity.reason}，${dominantOpaqueLabel}`
            : args.background.severity.reason,
        note: null,
        actionLabel: focusItem ? '打开对应项' : null,
        target: focusItem ? { kind: 'item', item: focusItem } : { kind: 'none' },
      },
    })
  }

  // Browser 检查卡数据：无视图时也生成（healthy + 回收按钮置灰），面板常驻展示
  {
    const closableItems = args.browser.closableItems
    const closableCount = closableItems.length
    const closableItem = closableItems[0] ?? null
    const hasBrowsers = args.browser.totalCount > 0
    const description = !hasBrowsers
      ? '当前没有 Browser 视图。'
      : closableCount >= 2
        ? `${args.browser.severity.reason}，可先回收 ${closableCount} 个脱屏空闲 Browser，再观察总账是否回落。`
        : closableItem
          ? `${args.browser.severity.reason}，可先关闭脱屏空闲 Browser ${closableItem.title}，再观察总账是否回落。`
          : args.browser.retainedOffscreenCount > 0
            ? `当前有 ${args.browser.retainedOffscreenCount} 个脱屏或预览 Browser 仍在使用或加载中，为避免中断任务暂不回收。`
            : `${args.browser.severity.reason}，当前共有 ${args.browser.totalCount} 个 Browser 视图，占总账 ${formatShare(args.browser.totalMemorySharePercent)}。`

    candidates.push({
      // 无 Browser 时优先级压低，避免盖住其它治理建议；面板对 browser-runtime 另有常驻槽
      priority: hasBrowsers ? severityWeight(args.browser.severity) * 10 + 7 : 1,
      suggestion: {
        id: 'browser-runtime',
        severity: args.browser.severity,
        title: '检查 Browser 视图堆积',
        description,
        note: args.browser.governanceNote,
        actionLabel: '一键回收空闲 Browser',
        actionDisabled: closableCount === 0,
        target: closableCount > 0
          ? { kind: 'close-items', items: closableItems }
          : { kind: 'none' },
      },
    })
  }

  if (args.dataRuntime && args.dataRuntime.severity.level !== 'healthy') {
    candidates.push({
      priority: severityWeight(args.dataRuntime.severity) * 10 + 6,
      suggestion: {
        id: 'tabdata-runtime',
        severity: args.dataRuntime.severity,
        title: '回到 TabData 检查复杂视图',
        description: `${args.dataRuntime.severity.reason}，当前视图有 ${args.dataRuntime.viewRowCount} 行、${args.dataRuntime.visibleFieldCount} 列。`,
        note: null,
        actionLabel: args.dataRuntime.spaceId && args.dataRuntime.tableId ? '打开 TabData' : null,
        target: args.dataRuntime.spaceId && args.dataRuntime.tableId
          ? { kind: 'tabdata-runtime', data: args.dataRuntime }
          : { kind: 'none' },
      },
    })
  }


  if (args.docRuntime && args.docRuntime.severity.level !== 'healthy') {
    candidates.push({
      priority: severityWeight(args.docRuntime.severity) * 10 + 4,
      suggestion: {
        id: 'tabdoc-runtime',
        severity: args.docRuntime.severity,
        title: '回到 TabDoc 确认保存状态',
        description: `${args.docRuntime.severity.reason}，当前文档约 ${args.docRuntime.wordCount} 词。`,
        note: null,
        actionLabel: args.docRuntime.spaceId && args.docRuntime.documentId ? '打开 TabDoc' : null,
        target: args.docRuntime.spaceId && args.docRuntime.documentId
          ? { kind: 'tabdoc-runtime', doc: args.docRuntime }
          : { kind: 'none' },
      },
    })
  }

  if (candidates.length === 0) {
    return [{
      id: 'stable-overview',
      severity: {
        level: 'healthy',
        label: '稳定',
        reason: '当前资源整体平稳',
      },
      title: '当前运行平稳',
      description: '最近资源波动不大，继续留意趋势即可。',
      note: null,
      actionLabel: args.currentSpace ? '查看当前 Space' : null,
      target: args.currentSpace
        ? { kind: 'space', spaceId: args.currentSpace.spaceId }
        : { kind: 'none' },
    }]
  }

  return candidates
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 3)
    .map((entry) => entry.suggestion)
}

function buildTabDocRuntimeView(
  snapshot: TabDocRuntimeMonitorSnapshot | null,
  spacesById: Map<string, Space>,
  activeSpaceId: string | null,
): ResourceMonitorTabDocRuntimeView | null {
  if (!snapshot?.owner) return null

  const metrics = snapshot.metrics
  const owner = snapshot.owner
  const documentId = owner.documentId ?? null
  const title = owner.title
    ?? (documentId ? `Doc ${documentId.slice(0, 6)}` : '未命名文档')
  const spaceName = owner.spaceId
    ? getSpaceName(owner.spaceId, spacesById, activeSpaceId)
    : null

  return {
    severity: getTabDocRuntimeSeverity({
      saveState: metrics?.saveState ?? 'idle',
    }),
    documentId,
    title,
    spaceId: owner.spaceId ?? null,
    spaceName,
    tabKey: owner.tabKey ?? null,
    ownerStrategy: snapshot.ownerStrategy,
    saveState: metrics?.saveState ?? 'idle',
    saveMessage: metrics?.saveMessage ?? null,
    latestVersion: metrics?.latestVersion ?? null,
    revisionCount: clampPositive(metrics?.revisionCount ?? 0),
    historyCount: clampPositive(metrics?.historyCount ?? 0),
    markdownLength: clampPositive(metrics?.markdownLength ?? 0),
    plaintextLength: clampPositive(metrics?.plaintextLength ?? 0),
    wordCount: clampPositive(metrics?.wordCount ?? 0),
    isCollaborating: metrics?.isCollaborating ?? false,
    activeEditorCount: clampPositive(metrics?.activeEditorCount ?? 0),
    peerCount: clampPositive(metrics?.peerCount ?? 0),
    isAgentEditing: metrics?.isAgentEditing ?? false,
    eventStreamStatus: metrics?.eventStreamStatus ?? null,
    isFallback: metrics?.isFallback ?? true,
    hasYdoc: metrics?.hasYdoc ?? false,
    mountedHostCount: clampPositive(snapshot.mountedHostCount),
    visibleHostCount: clampPositive(snapshot.visibleHostCount),
    activePaneHostCount: clampPositive(snapshot.activePaneHostCount),
    isCurrentSpace: owner.spaceId === activeSpaceId,
    updatedAt: metrics?.updatedAt ?? snapshot.updatedAt,
  }
}

function buildTabDataRuntimeView(
  snapshot: TabDataRuntimeMonitorSnapshot | null,
  spacesById: Map<string, Space>,
  activeSpaceId: string | null,
): ResourceMonitorTabDataRuntimeView | null {
  if (!snapshot?.owner) return null

  const metrics = snapshot.metrics
  const owner = snapshot.owner
  const tableId = owner.tableId ?? null
  const title = owner.title
    ?? metrics?.tableName
    ?? (tableId ? `Table ${tableId.slice(0, 6)}` : '未命名表格')
  const spaceName = owner.spaceId
    ? getSpaceName(owner.spaceId, spacesById, activeSpaceId)
    : null

  return {
    severity: getTabDataRuntimeSeverity({
      errorRatePct: metrics?.errorRatePct ?? 0,
      scrollFpsP95: metrics?.scrollFpsP95 ?? null,
      inputLatencyP95: metrics?.inputLatencyP95 ?? null,
      gridLoading: metrics?.gridLoading ?? false,
      isRecordsLoading: metrics?.isRecordsLoading ?? false,
      isRecordLoading: metrics?.isRecordLoading ?? false,
    }),
    tableId,
    title,
    spaceId: owner.spaceId ?? null,
    spaceName,
    tabKey: owner.tabKey ?? null,
    ownerStrategy: snapshot.ownerStrategy,
    tableRowCount: clampPositive(metrics?.tableRowCount ?? 0),
    viewRowCount: clampPositive(metrics?.viewRowCount ?? 0),
    loadedRowCount: clampPositive(metrics?.loadedRowCount ?? 0),
    renderedRowCount: clampPositive(metrics?.renderedRowCount ?? 0),
    fieldCount: clampPositive(metrics?.fieldCount ?? 0),
    visibleFieldCount: clampPositive(metrics?.visibleFieldCount ?? 0),
    hiddenFieldCount: clampPositive(metrics?.hiddenFieldCount ?? 0),
    currentViewId: metrics?.currentViewId ?? null,
    currentViewName: metrics?.currentViewName ?? null,
    filterCount: clampPositive(metrics?.filterCount ?? 0),
    sortCount: clampPositive(metrics?.sortCount ?? 0),
    groupCount: clampPositive(metrics?.groupCount ?? 0),
    hasGrouping: metrics?.hasGrouping ?? false,
    hasSubRecordTree: metrics?.hasSubRecordTree ?? false,
    isPersonalViewEnabled: metrics?.isPersonalViewEnabled ?? false,
    currentPage: clampPositive(metrics?.currentPage ?? 0),
    currentPageSize: clampPositive(metrics?.currentPageSize ?? 0),
    gridLoading: metrics?.gridLoading ?? false,
    isRecordsLoading: metrics?.isRecordsLoading ?? false,
    isRecordLoading: metrics?.isRecordLoading ?? false,
    selectedRowCount: clampPositive(metrics?.selectedRowCount ?? 0),
    useViewData: metrics?.useViewData ?? false,
    collabStatus: metrics?.collabStatus ?? null,
    isCollabOnline: metrics?.isCollabOnline ?? false,
    peerCount: clampPositive(metrics?.peerCount ?? 0),
    isCollabFallback: metrics?.isCollabFallback ?? true,
    engineId: metrics?.engineId ?? 'unknown',
    engineScopeId: metrics?.engineScopeId ?? null,
    scrollFpsP95: metrics?.scrollFpsP95 ?? null,
    scrollFpsAverage: metrics?.scrollFpsAverage ?? null,
    inputLatencyP95: metrics?.inputLatencyP95 ?? null,
    inputLatencyAverage: metrics?.inputLatencyAverage ?? null,
    scrollFpsSampleCount: clampPositive(metrics?.scrollFpsSampleCount ?? 0),
    inputLatencySampleCount: clampPositive(metrics?.inputLatencySampleCount ?? 0),
    hasInteractionSamples: metrics?.hasInteractionSamples ?? false,
    errorRatePct: clampPositive(metrics?.errorRatePct ?? 0),
    totalOperations: clampPositive(metrics?.totalOperations ?? 0),
    operationErrors: clampPositive(metrics?.operationErrors ?? 0),
    runtimeErrors: clampPositive(metrics?.runtimeErrors ?? 0),
    mountedHostCount: clampPositive(snapshot.mountedHostCount),
    visibleHostCount: clampPositive(snapshot.visibleHostCount),
    activePaneHostCount: clampPositive(snapshot.activePaneHostCount),
    isCurrentSpace: owner.spaceId === activeSpaceId,
    updatedAt: metrics?.updatedAt ?? snapshot.updatedAt,
  }
}

export function buildResourceMonitorViewModel(
  input: ResourceMonitorModelInput,
): ResourceMonitorViewModel {
  const snapshot = input.snapshot
  const spacesById = new Map(input.spaces.map((space) => [space.id, space]))
  const dataRuntime = buildTabDataRuntimeView(input.dataRuntime, spacesById, input.activeSpaceId)
  const docRuntime = buildTabDocRuntimeView(input.docRuntime, spacesById, input.activeSpaceId)
  const crawlspaceToSpaceId = new Map<string, string>()

  Object.entries(input.crawlspaceConfigById).forEach(([crawlspaceId, config]) => {
    const spaceId = getSpaceIdFromConfig(config)
    if (spaceId) {
      crawlspaceToSpaceId.set(crawlspaceId, spaceId)
    }
  })

  const runToSpaceId = buildRunToSpaceId(snapshot?.runs ?? [], crawlspaceToSpaceId)
  const viewTitleById = buildViewTitleById(input.crawlspaceContextCache)
  const terminalMetaById = buildTerminalMetaById(input.terminalSessionsBySpace)

  const paneCountBySpace = new Map<string, number>()
  let totalPaneCount = 0
  for (const [spaceId, groups] of Object.entries(input.spaceGroupsBySpace)) {
    const count = countVisiblePanes(groups)
    paneCountBySpace.set(spaceId, count)
    totalPaneCount += count
  }

  const drafts = new Map<string, SpaceDraft>()
  const ensureDraft = (spaceId: string): SpaceDraft => {
    const existing = drafts.get(spaceId)
    if (existing) return existing
    const created = createSpaceDraft(spaceId, input, spacesById, paneCountBySpace)
    drafts.set(spaceId, created)
    return created
  }

  const items: ResourceMonitorTrackedItem[] = []
  ;(snapshot?.browserViews ?? []).forEach((view) => {
    items.push(createBrowserItem(view, input, crawlspaceToSpaceId, runToSpaceId, viewTitleById))
  })
  ;(snapshot?.ptySessions ?? []).forEach((session) => {
    items.push(createTerminalItem(session, input, terminalMetaById))
  })

  let assignedSpaceCpu = 0
  let assignedSpaceMemory = 0
  const unassignedItems: ResourceMonitorTrackedItem[] = []

  items.forEach((item) => {
    if (!item.spaceId) {
      unassignedItems.push(item)
      return
    }

    const draft = ensureDraft(item.spaceId)
    draft.items.push(item)
    draft.trackedCpu += item.cpu
    draft.trackedMemory += item.memory
    if (item.kind === 'browser') {
      draft.browserCount += 1
    } else {
      draft.terminalCount += 1
      if (item.badgeLabel === 'Agent') {
        draft.agentCount += 1
      }
    }
    assignedSpaceCpu += item.cpu
    assignedSpaceMemory += item.memory
  })

  ;(snapshot?.runs ?? []).forEach((run) => {
    const spaceId = run.spaceId ?? (run.crawlspaceId ? crawlspaceToSpaceId.get(run.crawlspaceId) : null) ?? null
    if (!spaceId) return
    ensureDraft(spaceId).runCount += 1
  })

  if (input.activeSpaceId) {
    ensureDraft(input.activeSpaceId)
  }

  const totalMemory = clampPositive(snapshot?.totalMemory ?? 0)
  const totalCpu = clampPositive(snapshot?.totalCpu ?? 0)
  const finalizedSpaces = Array.from(drafts.values())
    .map((draft) => finalizeSpaceView(draft, totalMemory))
    .filter((space) => {
      return space.itemCount > 0
        || space.tabCount > 0
        || space.paneCount > 0
        || space.runCount > 0
        || space.isCurrentSpace
    })
    .sort((left, right) => {
      if (left.isCurrentSpace !== right.isCurrentSpace) return left.isCurrentSpace ? -1 : 1
      if (right.totalMemory !== left.totalMemory) return right.totalMemory - left.totalMemory
      return left.spaceName.localeCompare(right.spaceName, i18n.language)
    })

  const trackedItemsCpu = items.reduce((sum, item) => sum + item.cpu, 0)
  const trackedItemsMemory = items.reduce((sum, item) => sum + item.memory, 0)
  const unassignedCpu = unassignedItems.reduce((sum, item) => sum + item.cpu, 0)
  const unassignedMemory = unassignedItems.reduce((sum, item) => sum + item.memory, 0)
  const browser = buildBrowserInsightsView(snapshot, items, input.activeSpaceId, input.history)
  const overheadCpu = clampPositive(totalCpu - trackedItemsCpu)
  const overheadMemory = clampPositive(totalMemory - trackedItemsMemory)
  const rendererResidualCpu = clampPositive((snapshot?.app.renderer.cpu ?? 0) - browser.totalCpu)
  const rendererResidualMemory = clampPositive((snapshot?.app.renderer.memory ?? 0) - browser.totalMemory)
  const hostOverheadCpu = clampPositive(overheadCpu - rendererResidualCpu)
  const hostOverheadMemory = clampPositive(overheadMemory - rendererResidualMemory)
  const backgroundItems = sortItemsByPriority(unassignedItems)
  const cpuCoreCount = Math.max(1, snapshot?.host.cpuCoreCount ?? 1)
  const overviewSeverity = getOverviewSeverity({
    ramSharePercent: snapshot?.host.totalMemory
      ? (totalMemory / snapshot.host.totalMemory) * 100
      : 0,
    totalCpu,
    cpuCoreCount,
    totalMemoryBytes: totalMemory,
  })
  const backgroundSeverity = getBackgroundSeverity({
    unassignedMemory,
    rendererResidualMemory,
    hostOverheadMemory,
    totalMemory,
    totalCpu: unassignedCpu + overheadCpu,
  })
  const currentSpace = finalizedSpaces.find((space) => space.spaceId === input.activeSpaceId) ?? null
  const activeTabScopeKey = input.activeTabScopeKey ?? input.activeSpaceId
  const currentTabCount = activeTabScopeKey
    ? (input.tabOrderBySpace[activeTabScopeKey]?.length ?? 0)
    : 0
  const tabScopesByScopeKey = new Map<string, ResourceMonitorTabScope>()
  for (const { sessionId, spaceId } of input.sessionScopes ?? []) {
    const scopeKey = `conversation:${sessionId}`
    tabScopesByScopeKey.set(scopeKey, {
      spaceId,
      scopeKey,
      tabKeys: input.tabOrderBySpace[scopeKey] ?? [],
    })
  }
  if (activeTabScopeKey && input.activeSpaceId && !input.excludeActiveTabScope) {
    tabScopesByScopeKey.set(activeTabScopeKey, {
      spaceId: input.activeSpaceId,
      scopeKey: activeTabScopeKey,
      tabKeys: input.tabOrderBySpace[activeTabScopeKey] ?? [],
    })
  }
  const sessionTabScopes = [...tabScopesByScopeKey.values()]
  const closableSessionTabScopes = sessionTabScopes.filter((scope) => scope.tabKeys.length > 0)
  const totalTabCount = sessionTabScopes.reduce((sum, scope) => sum + scope.tabKeys.length, 0)
  const overview: ResourceMonitorOverview = {
    severity: overviewSeverity,
    hasSnapshot: Boolean(snapshot),
    collectedAt: snapshot?.collectedAt ?? null,
    totalCpu,
    totalMemory,
    ramSharePercent: snapshot?.host.totalMemory
      ? (totalMemory / snapshot.host.totalMemory) * 100
      : 0,
    trackedCpu: assignedSpaceCpu + unassignedCpu,
    trackedMemory: assignedSpaceMemory + unassignedMemory,
    cpuCoreCount,
    browserViewCount: snapshot?.browserViews.length ?? 0,
    ptySessionCount: snapshot?.ptySessions.length ?? 0,
    currentTabCount,
    totalTabCount,
    totalPaneCount,
    totalRuns: snapshot?.runSummary.totalRuns ?? 0,
    activeRuns: snapshot?.runSummary.activeRuns ?? 0,
    trackedSpaceCount: finalizedSpaces.filter((space) => space.itemCount > 0).length,
    hostUsedMemoryPercent: snapshot?.host.memoryUsagePercent ?? 0,
    hostUsedMemory: snapshot?.host.usedMemory ?? 0,
    viewFactoryTotal: snapshot?.viewFactory.total ?? 0,
    viewFactoryInUse: snapshot?.viewFactory.inUse ?? 0,
    viewFactoryIdle: snapshot?.viewFactory.idle ?? 0,
  }
  const background: ResourceMonitorBackgroundView = {
    severity: backgroundSeverity,
    unassignedCpu,
    unassignedMemory,
    overheadCpu,
    overheadMemory,
    rendererResidualCpu,
    rendererResidualMemory,
    hostOverheadCpu,
    hostOverheadMemory,
    totalCpu: unassignedCpu + overheadCpu,
    totalMemory: unassignedMemory + overheadMemory,
    explanations: buildBackgroundExplanationNotes({
      unassignedMemory,
      rendererResidualMemory,
      hostOverheadMemory,
      totalMemory: unassignedMemory + overheadMemory,
    }),
    itemCount: backgroundItems.length,
    items: backgroundItems,
    topItems: backgroundItems.slice(0, 5),
  }
  const suggestions = buildResourceMonitorSuggestions({
    history: input.history,
    currentSpace,
    background,
    browser,
    dataRuntime,
    docRuntime,
  })
  if (totalTabCount > 0) {
    suggestions.push({
      id: 'close-all-tabs',
      severity: overview.severity,
      title: '关闭全部标签',
      description: `关闭左侧所有未归档会话中打开的 ${totalTabCount} 个标签。关闭前仍会执行各类标签自身的保存与确认规则。`,
      note: null,
      actionLabel: '关闭全部标签',
      target: {
        kind: 'close-tabs',
        scopes: closableSessionTabScopes,
      },
    })
  }

  return {
    overview,
    history: input.history,
    currentSpace,
    spaces: finalizedSpaces,
    background,
    browser,
    dataRuntime,
    docRuntime,
    suggestions,
    topItems: sortItemsByPriority(items).slice(0, 8),
  }
}
