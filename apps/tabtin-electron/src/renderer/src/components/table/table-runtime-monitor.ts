import type { TableEngineObservabilitySnapshot } from './controller/useTableEngineObservability'
import {
  countActivePaneRuntimeHosts,
  countVisibleRuntimeHosts,
  createKeyedRuntimeReporter,
  createRuntimeMonitorInstanceId,
  getRuntimeHostActivityScore,
  getRuntimeOwnerStrategy,
  type RuntimeReporterHostState,
  type RuntimeReporterMetricState,
  type RuntimeReporterOwnerStrategy,
} from '@tabtin/runtime-reporter'

export type TabDataRuntimeOwnerStrategy = RuntimeReporterOwnerStrategy

export interface TabDataRuntimeHostMeta {
  tableId: string | null
  title: string | null
  spaceId: string | null
  organizationId: string | null
  tabKey: string | null
  isPaneActive: boolean
  isVisible: boolean
  isLoading: boolean
  hasError: boolean
}

export interface TabDataRuntimeMetrics {
  tableName: string | null
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
  /** Provider 连接生命周期；stuck-connecting = 握手持久挂起 */
  collabConnectionStatus: string | null
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
  updatedAt: number
}

export interface TabDataRuntimeMonitorSnapshot {
  owner: (TabDataRuntimeHostMeta & { instanceId: string }) | null
  ownerStrategy: TabDataRuntimeOwnerStrategy
  metrics: TabDataRuntimeMetrics | null
  mountedHostCount: number
  visibleHostCount: number
  activePaneHostCount: number
  updatedAt: number | null
}

type TabDataRuntimeHostState = RuntimeReporterHostState<TabDataRuntimeHostMeta>
type TabDataRuntimeMetricState = RuntimeReporterMetricState<TabDataRuntimeMetrics>

const DEFAULT_META: TabDataRuntimeHostMeta = {
  tableId: null,
  title: null,
  spaceId: null,
  organizationId: null,
  tabKey: null,
  isPaneActive: false,
  isVisible: false,
  isLoading: false,
  hasError: false,
}

const normalizeText = (value: string | null | undefined): string | null => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed || null
}

const normalizeTableId = (value: string | null | undefined): string | null => {
  return normalizeText(value)
}

const clampCount = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

const normalizeMetricValue = (value: number | null | undefined): number | null => {
  if (!Number.isFinite(Number(value))) return null
  const next = Number(value)
  return next >= 0 ? next : null
}

const countEnabledFilters = (value: unknown): number => {
  if (!Array.isArray(value)) return 0
  return value.filter((item) => {
    if (!item || typeof item !== 'object') return false
    const enabled = (item as { enabled?: boolean }).enabled
    return enabled !== false
  }).length
}

const countArray = (value: unknown): number => {
  return Array.isArray(value) ? value.length : 0
}

const getHostActivityScore = (
  host: TabDataRuntimeHostState,
  metricStateByTableId: Map<string, TabDataRuntimeMetricState>,
): number => {
  const tableId = normalizeTableId(host.meta.tableId)
  return getRuntimeHostActivityScore(
    host.meta,
    Boolean(tableId && metricStateByTableId.has(tableId)),
  )
}

const getHostFreshness = (
  host: TabDataRuntimeHostState,
  metricStateByTableId: Map<string, TabDataRuntimeMetricState>,
): number => {
  const tableId = normalizeTableId(host.meta.tableId)
  const metricsUpdatedAt = tableId ? (metricStateByTableId.get(tableId)?.updatedAt ?? 0) : 0
  return Math.max(host.registeredAt, host.metaUpdatedAt, metricsUpdatedAt)
}

const compareHosts = (
  left: TabDataRuntimeHostState,
  right: TabDataRuntimeHostState,
  metricStateByTableId: Map<string, TabDataRuntimeMetricState>,
): number => {
  const leftScore = getHostActivityScore(left, metricStateByTableId)
  const rightScore = getHostActivityScore(right, metricStateByTableId)
  if (rightScore !== leftScore) return rightScore - leftScore

  const leftFreshness = getHostFreshness(left, metricStateByTableId)
  const rightFreshness = getHostFreshness(right, metricStateByTableId)
  if (rightFreshness !== leftFreshness) return rightFreshness - leftFreshness

  return right.registeredAt - left.registeredAt
}

const mergeMeta = (
  prev: TabDataRuntimeHostMeta,
  next: Partial<TabDataRuntimeHostMeta>,
): TabDataRuntimeHostMeta => {
  return {
    tableId: next.tableId !== undefined ? normalizeTableId(next.tableId) : prev.tableId,
    title: next.title !== undefined ? normalizeText(next.title) : prev.title,
    spaceId: next.spaceId !== undefined ? normalizeText(next.spaceId) : prev.spaceId,
    organizationId: next.organizationId !== undefined ? normalizeText(next.organizationId) : prev.organizationId,
    tabKey: next.tabKey !== undefined ? normalizeText(next.tabKey) : prev.tabKey,
    isPaneActive: next.isPaneActive ?? prev.isPaneActive,
    isVisible: next.isVisible ?? prev.isVisible,
    isLoading: next.isLoading ?? prev.isLoading,
    hasError: next.hasError ?? prev.hasError,
  }
}

export function buildTabDataRuntimeMetrics(input: {
  tableName: string | null | undefined
  tableRowCount: number
  viewRowCount: number
  loadedRowCount: number
  renderedRowCount: number
  fieldCount: number
  visibleFieldCount: number
  currentViewId: string | null | undefined
  currentViewName: string | null | undefined
  filters: unknown
  sorts: unknown
  groups: unknown
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
  collabStatus: string | null | undefined
  collabConnectionStatus?: string | null
  isCollabOnline: boolean
  peerCount: number
  isCollabFallback: boolean
  engineSnapshot: TableEngineObservabilitySnapshot | null | undefined
}): TabDataRuntimeMetrics {
  const engineCurrent = input.engineSnapshot?.current ?? null
  const fieldCount = clampCount(input.fieldCount)
  const visibleFieldCount = clampCount(input.visibleFieldCount)
  const hiddenFieldCount = Math.max(0, fieldCount - visibleFieldCount)
  const scrollFpsSampleCount = clampCount(engineCurrent?.scrollFps.count ?? 0)
  const inputLatencySampleCount = clampCount(engineCurrent?.inputLatencyMs.count ?? 0)
  const totalOperations = clampCount(engineCurrent?.errorRate.totalOperations ?? 0)
  const runtimeErrors = clampCount(engineCurrent?.errorRate.runtimeErrors ?? 0)

  return {
    tableName: normalizeText(input.tableName),
    tableRowCount: clampCount(input.tableRowCount),
    viewRowCount: clampCount(input.viewRowCount),
    loadedRowCount: clampCount(input.loadedRowCount),
    renderedRowCount: clampCount(input.renderedRowCount),
    fieldCount,
    visibleFieldCount,
    hiddenFieldCount,
    currentViewId: normalizeText(input.currentViewId),
    currentViewName: normalizeText(input.currentViewName),
    filterCount: countEnabledFilters(input.filters),
    sortCount: countArray(input.sorts),
    groupCount: countArray(input.groups),
    hasGrouping: input.hasGrouping,
    hasSubRecordTree: input.hasSubRecordTree,
    isPersonalViewEnabled: input.isPersonalViewEnabled,
    currentPage: clampCount(input.currentPage),
    currentPageSize: clampCount(input.currentPageSize),
    gridLoading: input.gridLoading,
    isRecordsLoading: input.isRecordsLoading,
    isRecordLoading: input.isRecordLoading,
    selectedRowCount: clampCount(input.selectedRowCount),
    useViewData: input.useViewData,
    collabStatus: normalizeText(input.collabStatus),
    collabConnectionStatus: normalizeText(input.collabConnectionStatus),
    isCollabOnline: input.isCollabOnline,
    peerCount: clampCount(input.peerCount),
    isCollabFallback: input.isCollabFallback,
    engineId: normalizeText(engineCurrent?.engineId) ?? normalizeText(input.engineSnapshot?.currentEngineId) ?? 'unknown',
    engineScopeId: normalizeText(engineCurrent?.scopeId) ?? normalizeText(input.engineSnapshot?.currentScopeId),
    scrollFpsP95: normalizeMetricValue(engineCurrent?.scrollFps.p95),
    scrollFpsAverage: normalizeMetricValue(engineCurrent?.scrollFps.average),
    inputLatencyP95: normalizeMetricValue(engineCurrent?.inputLatencyMs.p95),
    inputLatencyAverage: normalizeMetricValue(engineCurrent?.inputLatencyMs.average),
    scrollFpsSampleCount,
    inputLatencySampleCount,
    hasInteractionSamples: scrollFpsSampleCount > 0 || inputLatencySampleCount > 0 || totalOperations > 0 || runtimeErrors > 0,
    errorRatePct: normalizeMetricValue(engineCurrent?.errorRate.ratePct) ?? 0,
    totalOperations,
    operationErrors: clampCount(engineCurrent?.errorRate.operationErrors ?? 0),
    runtimeErrors,
    updatedAt: clampCount(engineCurrent?.updatedAt ?? Date.now()),
  }
}

export function deriveTabDataRuntimeMonitorSnapshot(
  hostStates: TabDataRuntimeHostState[],
  metricStateByTableId: Map<string, TabDataRuntimeMetricState>,
): TabDataRuntimeMonitorSnapshot | null {
  if (hostStates.length === 0) return null

  const orderedHosts = [...hostStates].sort((left, right) =>
    compareHosts(left, right, metricStateByTableId),
  )
  const ownerHost = orderedHosts[0] ?? null
  if (!ownerHost) return null

  const ownerTableId = normalizeTableId(ownerHost.meta.tableId)
  const ownerMetrics = ownerTableId
    ? metricStateByTableId.get(ownerTableId)?.metrics ?? null
    : null

  const ownerStrategy = getRuntimeOwnerStrategy(ownerHost.meta)
  const visibleHostCount = countVisibleRuntimeHosts(hostStates)
  const activePaneHostCount = countActivePaneRuntimeHosts(hostStates)
  const updatedAt = Math.max(
    ownerHost.metaUpdatedAt,
    ownerMetrics?.updatedAt ?? 0,
  )

  return {
    owner: {
      instanceId: ownerHost.instanceId,
      ...ownerHost.meta,
    },
    ownerStrategy,
    metrics: ownerMetrics,
    mountedHostCount: hostStates.length,
    visibleHostCount,
    activePaneHostCount,
    updatedAt: updatedAt > 0 ? updatedAt : null,
  }
}

export function createTabDataRuntimeMonitorInstanceId(): string {
  return createRuntimeMonitorInstanceId('tabdata-runtime')
}

const tabDataRuntimeReporter = createKeyedRuntimeReporter<
  TabDataRuntimeHostMeta,
  TabDataRuntimeMetrics,
  TabDataRuntimeMonitorSnapshot
>({
  defaultMeta: DEFAULT_META,
  mergeMeta,
  normalizeMetricKey: normalizeTableId,
  getMetricKeyFromMeta: (meta) => normalizeTableId(meta.tableId),
  deriveSnapshot: deriveTabDataRuntimeMonitorSnapshot,
})

export function registerTabDataRuntimeHost(
  instanceId: string,
  meta: Partial<TabDataRuntimeHostMeta> = {},
): void {
  tabDataRuntimeReporter.registerHost(instanceId, meta)
}

export function updateTabDataRuntimeHost(
  instanceId: string,
  meta: Partial<TabDataRuntimeHostMeta>,
): void {
  tabDataRuntimeReporter.updateHost(instanceId, meta)
}

export function publishTabDataRuntimeMetrics(
  tableId: string | null | undefined,
  metrics: TabDataRuntimeMetrics | null,
): void {
  tabDataRuntimeReporter.publishMetrics(tableId, metrics)
}

export function unregisterTabDataRuntimeHost(instanceId: string): void {
  tabDataRuntimeReporter.unregisterHost(instanceId)
}

export function subscribeTabDataRuntimeMonitor(listener: () => void): () => void {
  return tabDataRuntimeReporter.subscribe(listener)
}

export function getTabDataRuntimeMonitorSnapshot(): TabDataRuntimeMonitorSnapshot | null {
  return tabDataRuntimeReporter.getSnapshot()
}

export function useTabDataRuntimeMonitorSnapshot(): TabDataRuntimeMonitorSnapshot | null {
  return tabDataRuntimeReporter.useSnapshot()
}
