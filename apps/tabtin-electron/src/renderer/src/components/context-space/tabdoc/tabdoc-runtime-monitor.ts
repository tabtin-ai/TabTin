import type { SaveState } from '@tabtin/tabdoc-ui/use-doc-editor'
import { countDocumentWords } from '@tabtin/tabdoc-ui/editor'
import {
  countActivePaneRuntimeHosts,
  countVisibleRuntimeHosts,
  createHostBoundRuntimeReporter,
  createRuntimeMonitorInstanceId,
  getRuntimeHostActivityScore,
  getRuntimeOwnerStrategy,
  selectMostRecentRuntimeMetricsHost,
  type HostBoundRuntimeReporterHostState,
  type RuntimeReporterOwnerStrategy,
} from '@tabtin/runtime-reporter'

export type TabDocRuntimeOwnerStrategy = RuntimeReporterOwnerStrategy

export interface TabDocRuntimeHostMeta {
  documentId: string | null
  title: string | null
  spaceId: string | null
  organizationId: string | null
  tabKey: string | null
  isPaneActive: boolean
  isVisible: boolean
  isLoading: boolean
  hasError: boolean
}

export interface TabDocRuntimeMetrics {
  saveState: SaveState
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
  /** Y.js / Hocuspocus CollabStatus（连接明细「协作同步」用这个，不是 event stream） */
  collabStatus: string | null
  /** Provider 连接生命周期；stuck-connecting = 握手持久挂起 */
  collabConnectionStatus: string | null
  eventStreamStatus: string | null
  isFallback: boolean
  hasYdoc: boolean
  updatedAt: number
}

export interface TabDocRuntimeMonitorSnapshot {
  owner: (TabDocRuntimeHostMeta & { instanceId: string }) | null
  ownerStrategy: TabDocRuntimeOwnerStrategy
  metrics: TabDocRuntimeMetrics | null
  mountedHostCount: number
  visibleHostCount: number
  activePaneHostCount: number
  updatedAt: number | null
}

type TabDocRuntimeHostState = HostBoundRuntimeReporterHostState<
  TabDocRuntimeHostMeta,
  TabDocRuntimeMetrics
>

const DEFAULT_META: TabDocRuntimeHostMeta = {
  documentId: null,
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

const clampCount = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

const getHostFreshness = (host: TabDocRuntimeHostState): number => {
  return Math.max(host.registeredAt, host.metaUpdatedAt, host.metricsUpdatedAt)
}

const compareHosts = (left: TabDocRuntimeHostState, right: TabDocRuntimeHostState): number => {
  const leftScore = getRuntimeHostActivityScore(left.meta, Boolean(left.metrics))
  const rightScore = getRuntimeHostActivityScore(right.meta, Boolean(right.metrics))
  if (rightScore !== leftScore) return rightScore - leftScore

  const leftFreshness = getHostFreshness(left)
  const rightFreshness = getHostFreshness(right)
  if (rightFreshness !== leftFreshness) return rightFreshness - leftFreshness

  return right.registeredAt - left.registeredAt
}

const mergeMeta = (
  prev: TabDocRuntimeHostMeta,
  next: Partial<TabDocRuntimeHostMeta>,
): TabDocRuntimeHostMeta => {
  return {
    documentId: next.documentId !== undefined ? normalizeText(next.documentId) : prev.documentId,
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

export function createTabDocRuntimeMonitorInstanceId(): string {
  return createRuntimeMonitorInstanceId('tabdoc-runtime')
}

export function buildTabDocRuntimeMetrics(input: {
  saveState: SaveState
  saveMessage: string | null
  latestVersion: number | null | undefined
  revisionCount: number
  historyCount: number
  markdown: string
  plaintext: string
  isCollaborating: boolean
  activeEditorCount: number
  peerCount: number
  isAgentEditing: boolean
  collabStatus: string | null | undefined
  collabConnectionStatus?: string | null
  eventStreamStatus: string | null | undefined
  isFallback: boolean
  hasYdoc: boolean
}): TabDocRuntimeMetrics {
  const markdown = input.markdown ?? ''
  const plaintext = input.plaintext ?? ''

  return {
    saveState: input.saveState,
    saveMessage: normalizeText(input.saveMessage),
    latestVersion: typeof input.latestVersion === 'number' ? input.latestVersion : null,
    revisionCount: clampCount(input.revisionCount),
    historyCount: clampCount(input.historyCount),
    markdownLength: markdown.length,
    plaintextLength: plaintext.length,
    wordCount: countDocumentWords(plaintext),
    isCollaborating: input.isCollaborating,
    activeEditorCount: clampCount(input.activeEditorCount),
    peerCount: clampCount(input.peerCount),
    isAgentEditing: input.isAgentEditing,
    collabStatus: normalizeText(input.collabStatus),
    collabConnectionStatus: normalizeText(input.collabConnectionStatus),
    eventStreamStatus: normalizeText(input.eventStreamStatus),
    isFallback: input.isFallback,
    hasYdoc: input.hasYdoc,
    updatedAt: Date.now(),
  }
}

export function deriveTabDocRuntimeMonitorSnapshot(
  hostStates: TabDocRuntimeHostState[],
): TabDocRuntimeMonitorSnapshot | null {
  if (hostStates.length === 0) return null

  const orderedHosts = [...hostStates].sort(compareHosts)
  const ownerHost = orderedHosts[0] ?? null
  const metricsHost = selectMostRecentRuntimeMetricsHost(orderedHosts)

  if (!ownerHost) return null

  const metrics = ownerHost.metrics ?? null
  const ownerStrategy = getRuntimeOwnerStrategy(ownerHost.meta)
  const visibleHostCount = countVisibleRuntimeHosts(hostStates)
  const activePaneHostCount = countActivePaneRuntimeHosts(hostStates)
  const updatedAt = Math.max(
    ownerHost.metaUpdatedAt,
    ownerHost.metricsUpdatedAt,
    metricsHost?.metricsUpdatedAt ?? 0,
  )

  return {
    owner: {
      instanceId: ownerHost.instanceId,
      ...ownerHost.meta,
    },
    ownerStrategy,
    metrics,
    mountedHostCount: hostStates.length,
    visibleHostCount,
    activePaneHostCount,
    updatedAt: updatedAt > 0 ? updatedAt : null,
  }
}

const tabDocRuntimeReporter = createHostBoundRuntimeReporter<
  TabDocRuntimeHostMeta,
  TabDocRuntimeMetrics,
  TabDocRuntimeMonitorSnapshot
>({
  defaultMeta: DEFAULT_META,
  mergeMeta,
  deriveSnapshot: deriveTabDocRuntimeMonitorSnapshot,
})

export function registerTabDocRuntimeHost(
  instanceId: string,
  meta: Partial<TabDocRuntimeHostMeta> = {},
): void {
  tabDocRuntimeReporter.registerHost(instanceId, meta)
}

export function updateTabDocRuntimeHost(
  instanceId: string,
  meta: Partial<TabDocRuntimeHostMeta>,
): void {
  tabDocRuntimeReporter.updateHost(instanceId, meta)
}

export function publishTabDocRuntimeMetrics(
  instanceId: string,
  metrics: TabDocRuntimeMetrics | null,
): void {
  tabDocRuntimeReporter.publishMetrics(instanceId, metrics)
}

export function unregisterTabDocRuntimeHost(instanceId: string): void {
  tabDocRuntimeReporter.unregisterHost(instanceId)
}

export function subscribeTabDocRuntimeMonitor(listener: () => void): () => void {
  return tabDocRuntimeReporter.subscribe(listener)
}

export function getTabDocRuntimeMonitorSnapshot(): TabDocRuntimeMonitorSnapshot | null {
  return tabDocRuntimeReporter.getSnapshot()
}

export function useTabDocRuntimeMonitorSnapshot(): TabDocRuntimeMonitorSnapshot | null {
  return tabDocRuntimeReporter.useSnapshot()
}
