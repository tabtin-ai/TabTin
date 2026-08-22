import type { ContextActiveKey, ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { CrawlspacePersistedViewSeed, CrawlspaceViewInfo } from '@stores/useCrawlTabStore'

export type RestoreTabStatusKind =
  | 'valid'
  | 'recoverable'
  | 'suspended'
  | 'unknown'
  | 'stale'

export type RestoreActiveSurface = 'real_tab' | 'desktop'

export type RestoreGeneration = {
  spaceId: string
  scopeKey: string
  /**
   * 每次进入新的 restore identity 都递增。
   * 同一个 session 快速切回时，旧结果不能因为 scopeKey 相同而重新生效。
   */
  scopeVersion: number
  sequence: number
}

export interface RestoreReadiness {
  contextTabsHydrated: boolean
  canvasLayoutHydrated: boolean
  crawlTabsHydrated: boolean
  terminalSessionsHydrated: boolean
  browserColdStartPending: boolean
}

export interface RestoreTabStatus {
  tabKey: string
  kind: RestoreTabStatusKind
  reason: string
  type?: string
  id?: string
}

export interface WorkbenchRestoreInput {
  spaceId: string
  nowMs?: number
  isIsolatedScope?: boolean
  crawlspaceId?: string | null
  tabOrder: string[]
  itemsByTabKey: Record<string, ContextItemRecord>
  activeKey: ContextActiveKey
  displayKey: ContextActiveKey
  lastActiveSurface: RestoreActiveSurface
  canvasGroups: CanvasLayoutGroup[]
  browser: {
    items: ContextItemRecord[]
    viewList: CrawlspaceViewInfo[]
    activeViewId: string | null
    persistedSeeds: CrawlspacePersistedViewSeed[]
    recentlyClosedViewIds: Set<string>
    coldStartPending: boolean
  }
  table: {
    items: ContextItemRecord[]
    isLoading: boolean
    hasError: boolean
  }
  terminal: {
    items: ContextItemRecord[]
    sessionIds: string[]
    splitSubPaneSessionIds: Set<string>
    hydrated: boolean
  }
  apps: {
    ready: boolean
    isAppEnabled: (appId?: string) => boolean
    getAppId: (type: string) => string | undefined
    /** 此 type 是否需要做资源存在性校验（handler.requireResourceMembership） */
    requireResourceMembership: (type: string) => boolean
  }
  /**
   * Space 内具名资源的存在性索引（来自 useUnifiedResources）。
   *
   * 用途：让 classifyRestoreTab 对 tabdoc / tabdata 这类「id 即资源 id」的 tab
   * 校验资源是否仍在 Space 里——资源被删后冷启动恢复时直接标 stale，避免出现
   * 「未命名表格 / 未命名文档」的死链 tab。
   *
   * - byType: key 为前端 type（已 normalizeBackendType），value 为该 type 下所有
   *   resource_id 的集合
   * - loaded: 资源列表是否已成功加载完成。loading / error 状态下保持 false，
   *   policies 会维持 unknown 不做存在性判定，避免误删
   */
  resourceMembership: {
    byType: Record<string, ReadonlySet<string>>
    loaded: boolean
  }
  readiness: RestoreReadiness
}

export interface RestoreDecision {
  settled: boolean
  statusByTabKey: Record<string, RestoreTabStatus>
  contextPatch: {
    tabOrder: string[]
    items: Record<string, ContextItemRecord>
    activeKey: ContextActiveKey
    displayKey: ContextActiveKey
  }
  canvasPatch: {
    groups: CanvasLayoutGroup[]
  }
  activeSurface: RestoreActiveSurface
  desiredActiveViewId: string | null
  baseSignature: {
    contextTabs: string
    canvasLayout: string
  }
  changed: {
    contextTabs: boolean
    canvasLayout: boolean
  }
  trace: {
    prunedTabKeys: string[]
    prunedPaneIds: string[]
    keptUnknownKeys: string[]
    suspendedKeys: string[]
    recoverableKeys: string[]
    activeReason: string
  }
}
