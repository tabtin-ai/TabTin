import { useEffect, useMemo, useRef, useState } from 'react'
import { contextRegistry } from '@components/context-space/registry'
import { useCanvasLayoutStore, type CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { useCrawlTabStore, type CrawlspacePersistedViewSeed, type CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore, type ContextActiveKey, type ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useTerminalSplitStore } from '@stores/useTerminalSplitStore'
import { useTerminalSessionStore } from '../sources/terminal'
import { useUnifiedResources } from '@stores/useUnifiedResources'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import { isCloudDocsScopeKey } from '@/components/layout/cloudDocsDomain'
import { isIsolatedScopeKey } from '@/components/layout/workspaceContextState'
import { resolveRestoreResourceMembershipCacheKey } from './resourceMembershipScope'
import { logger } from '@/utils/logger'
import {
  buildCanvasLayoutSignature,
  buildContextTabsSignature,
} from '@stores/workbenchRestoreSignature'
import {
  reconcileWorkbenchRestore,
  signatureRestoreDecision,
} from './reconcileWorkbenchRestore'
import { requiresChatSessionIndex } from './policies'
import {
  gateRestoreResultForScope,
  type RestoreScopeIdentity,
} from './restoreScope'
import type { RestoreActiveSurface, RestoreDecision, RestoreGeneration } from './types'

interface PersistApiLike {
  hasHydrated?: () => boolean
  onFinishHydration?: (cb: () => void) => () => void
}

const getPersistApi = (store: unknown): PersistApiLike | null => {
  const api = (store as { persist?: PersistApiLike }).persist
  return api ?? null
}

function usePersistHydrated(store: unknown): boolean {
  const api = getPersistApi(store)
  const [hydrated, setHydrated] = useState(() => api?.hasHydrated?.() ?? true)

  useEffect(() => {
    if (hydrated) return
    if (api?.hasHydrated?.()) {
      setHydrated(true)
      return
    }
    return api?.onFinishHydration?.(() => setHydrated(true))
  }, [api, hydrated])

  return hydrated
}

interface WorkbenchRestoreCoordinatorParams {
  spaceId: string
  tabScopeKey?: string | null
  crawlspaceId?: string | null
  isForeground: boolean
  tabOrder: string[]
  activeKey: ContextActiveKey
  displayKey: ContextActiveKey
  itemsByTabKey: Record<string, ContextItemRecord>
  canvasGroups: CanvasLayoutGroup[]
  browserSource: {
    items: ContextItemRecord[]
    viewList: CrawlspaceViewInfo[]
    activeViewId: string | null
  }
  tableSource: {
    items: ContextItemRecord[]
    isLoading: boolean
    error: string | null
  }
  terminalSource: {
    items: ContextItemRecord[]
    sessions: { id: string }[]
  }
  appsReady: boolean
  isAppEnabled: (appId?: string) => boolean
  lastActiveSurface: RestoreActiveSurface
}

interface WorkbenchRestoreCoordinatorResult {
  restoreSettled: boolean
  desiredActiveViewId: string | null
  activeSurface: RestoreActiveSurface
  generation: RestoreGeneration
  lastDecision: RestoreDecision | null
}

const EMPTY_SEEDS: CrawlspacePersistedViewSeed[] = []

// 死循环护栏：只捕捉“短时间内连续重触发”的真死循环（React  那类
// setResult→重渲染→重触发 的紧密循环），放过长会话里稀疏的正常重触发。
// 两次 effect 间隔超过 LOOP_WINDOW_RESET_MS 视为稀疏 churn（开关标签 / Space
// merge 等），重置计数窗口；只有连续快速触发累计超过 LOOP_RUN_THRESHOLD 才判定。
// abort 只是打断当前紧密循环，之后触发一旦变稀疏计数即归零，restore 自动恢复。
const LOOP_WINDOW_RESET_MS = 2000
const LOOP_RUN_THRESHOLD = 50

export function useWorkbenchRestoreCoordinator({
  spaceId,
  tabScopeKey,
  crawlspaceId,
  isForeground,
  tabOrder,
  activeKey,
  displayKey,
  itemsByTabKey,
  canvasGroups,
  browserSource,
  tableSource,
  terminalSource,
  appsReady,
  isAppEnabled,
  lastActiveSurface,
}: WorkbenchRestoreCoordinatorParams): WorkbenchRestoreCoordinatorResult {
  const storageKey = tabScopeKey || spaceId
  const isIsolatedScope = isIsolatedScopeKey(storageKey)
  const contextTabsHydrated = usePersistHydrated(useSpaceContextTabsStore)
  const canvasLayoutHydrated = usePersistHydrated(useCanvasLayoutStore)
  const crawlTabsHydrated = usePersistHydrated(useCrawlTabStore)
  const terminalSessionsHydrated = usePersistHydrated(useTerminalSessionStore)
  // PRD §4.13 / 红线 #11：subagent_session restore 决策依赖 chat sessions 索引，
  // 还没 hydrate 完成时 policies 必须返回 unknown 不返回 stale，避免冷启动期把
  // 所有 subagent tab 误清理。仅当当前 scope 真有 subagent_session 时才把
  // sessionsHydrated 纳入 readyToRestore；普通 IM 资源恢复不依赖 Agent 会话索引。
  const sessionsHydrated = useChatStore(s => s.sessionsHydrated)
  const chatSessionIndexRequired = useMemo(
    () => requiresChatSessionIndex(Object.values(itemsByTabKey)),
    [itemsByTabKey],
  )
  const chatSessionIndexReady = !chatSessionIndexRequired || sessionsHydrated

  const persistedSeeds = useCrawlTabStore(state =>
    crawlspaceId ? state.crawlspacePersistedViews[crawlspaceId] ?? EMPTY_SEEDS : EMPTY_SEEDS
  )
  const browserColdStartPending = useCrawlTabStore(state =>
    crawlspaceId ? Boolean(state._coldStartPendingByCS[crawlspaceId]) : false
  )
  const recentlyClosedViewIds = useCrawlTabStore(state => state._recentlyClosedViewIds)

  // ── 资源存在性索引（用于 stale tab 自清，见 W2 fix #3 /  / ）──
  // desktop / cloud-docs scope 读 organization 桶，conversation 读执行 Space 桶。
  const membershipCacheKey = resolveRestoreResourceMembershipCacheKey(storageKey, spaceId)
  const unifiedSpaceResources = useUnifiedResources(state =>
    state.resourcesBySpaceId[membershipCacheKey] ?? null,
  )
  const unifiedSpaceLoading = useUnifiedResources(state =>
    Boolean(state.loadingBySpaceId[membershipCacheKey]),
  )
  const unifiedSpaceError = useUnifiedResources(state =>
    state.errorBySpaceId[membershipCacheKey] ?? null,
  )
  const resourceMembership = useMemo(() => {
    const loaded =
      unifiedSpaceResources !== null &&
      !unifiedSpaceLoading &&
      !unifiedSpaceError
    const byType: Record<string, Set<string>> = {}
    if (loaded && unifiedSpaceResources) {
      for (const item of unifiedSpaceResources) {
        if (!item.resource_id) continue
        const frontendType = contextRegistry.normalizeBackendType(item.item_type)
        let bucket = byType[frontendType]
        if (!bucket) {
          bucket = new Set()
          byType[frontendType] = bucket
        }
        bucket.add(item.resource_id)
      }
    }
    return { byType, loaded }
  }, [unifiedSpaceResources, unifiedSpaceLoading, unifiedSpaceError])
  const splitLayouts = useTerminalSplitStore(state => state.layouts)
  const splitSubPaneSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const layout of Object.values(splitLayouts)) {
      for (const pane of Object.values(layout.panes)) {
        if (pane.sessionId && pane.sessionId !== layout.rootSessionId) {
          ids.add(pane.sessionId)
        }
      }
    }
    return ids
  }, [splitLayouts])

  const readiness = useMemo(() => ({
    contextTabsHydrated,
    canvasLayoutHydrated,
    crawlTabsHydrated,
    terminalSessionsHydrated,
    browserColdStartPending,
    chatSessionIndexRequired,
    chatSessionIndexReady,
  }), [
    browserColdStartPending,
    canvasLayoutHydrated,
    chatSessionIndexReady,
    chatSessionIndexRequired,
    contextTabsHydrated,
    crawlTabsHydrated,
    terminalSessionsHydrated,
  ])

  const readyToRestore =
    isForeground &&
    readiness.contextTabsHydrated &&
    readiness.canvasLayoutHydrated &&
    readiness.crawlTabsHydrated &&
    readiness.terminalSessionsHydrated &&
    chatSessionIndexReady &&
    !readiness.browserColdStartPending

  const decision = useMemo(() => {
    if (!readyToRestore) return null
    return reconcileWorkbenchRestore({
      spaceId,
      nowMs: Date.now(),
      isIsolatedScope,
      crawlspaceId,
      tabOrder,
      itemsByTabKey,
      activeKey,
      displayKey,
      lastActiveSurface,
      canvasGroups,
      browser: {
        items: browserSource.items,
        viewList: browserSource.viewList,
        activeViewId: browserSource.activeViewId,
        persistedSeeds,
        recentlyClosedViewIds,
        coldStartPending: browserColdStartPending,
      },
      table: {
        items: tableSource.items,
        isLoading: tableSource.isLoading,
        hasError: Boolean(tableSource.error),
      },
      terminal: {
        items: terminalSource.items,
        sessionIds: terminalSource.sessions.map(session => session.id),
        splitSubPaneSessionIds,
        hydrated: terminalSessionsHydrated,
      },
      apps: {
        ready: appsReady,
        isAppEnabled,
        getAppId: type => contextRegistry.getAppId(type as any),
        // 云文档域列表即组织级真源；再按 membership 自清会与 syncTabOrder/persistOnly
        // 互掐（打开可见文档反被判 missing → 主线程卡死，）。
        // ：conversation/im 隔离桶对称豁免 tabdoc——Space membership 自清会与
        // persistOnly 回补互掐（RestoreCoord LOOP → 编辑器重挂 → 列表编号突变）。
        requireResourceMembership: type => {
          if (isCloudDocsScopeKey(storageKey)) return false
          if (isIsolatedScopeKey(storageKey) && type === 'tabdoc') return false
          return Boolean(contextRegistry.getHandler(type as any)?.requireResourceMembership)
        },
      },
      resourceMembership,
      readiness,
    })
  }, [
    activeKey,
    appsReady,
    browserColdStartPending,
    browserSource.activeViewId,
    browserSource.items,
    browserSource.viewList,
    canvasGroups,
    crawlspaceId,
    displayKey,
    isAppEnabled,
    isIsolatedScope,
    itemsByTabKey,
    lastActiveSurface,
    persistedSeeds,
    readiness,
    readyToRestore,
    recentlyClosedViewIds,
    resourceMembership,
    spaceId,
    splitSubPaneSessionIds,
    storageKey,
    tabOrder,
    tableSource.error,
    tableSource.isLoading,
    tableSource.items,
    terminalSessionsHydrated,
    terminalSource.items,
    terminalSource.sessions,
  ])

  const restoreIdentity = `${spaceId}\u0000${storageKey}\u0000${crawlspaceId ?? ''}`
  const scopeVersionRef = useRef({ identity: restoreIdentity, version: 0 })
  if (scopeVersionRef.current.identity !== restoreIdentity) {
    scopeVersionRef.current = {
      identity: restoreIdentity,
      version: scopeVersionRef.current.version + 1,
    }
  }
  const scopeVersion = scopeVersionRef.current.version
  const restoreScopeIdentity = useMemo<RestoreScopeIdentity>(() => ({
    spaceId,
    scopeKey: storageKey,
    scopeVersion,
  }), [scopeVersion, spaceId, storageKey])
  const sequenceRef = useRef(0)
  const appliedSignatureRef = useRef<string | null>(null)
  const debugLoopCountRef = useRef(0)
  const debugLoopWindowStartRef = useRef(0)
  const debugLoopLastRunAtRef = useRef(0)
  const debugLastDecisionSigRef = useRef<string | null>(null)
  const [result, setResult] = useState<WorkbenchRestoreCoordinatorResult>(() => ({
    restoreSettled: false,
    desiredActiveViewId: null,
    activeSurface: 'real_tab',
    generation: {
      ...restoreScopeIdentity,
      sequence: 0,
    },
    lastDecision: null,
  }))
  const scopedResult = gateRestoreResultForScope(result, restoreScopeIdentity)
  const restoreSettled = scopedResult.restoreSettled

  useEffect(() => {
    appliedSignatureRef.current = null
    debugLoopCountRef.current = 0
    debugLoopWindowStartRef.current = Date.now()
    debugLoopLastRunAtRef.current = 0
    debugLastDecisionSigRef.current = null
    setResult(prev => ({
      ...prev,
      restoreSettled: false,
      desiredActiveViewId: null,
      activeSurface: 'real_tab',
      generation: {
        ...restoreScopeIdentity,
        sequence: ++sequenceRef.current,
      },
      lastDecision: null,
    }))
  }, [crawlspaceId, restoreScopeIdentity, spaceId, storageKey])

  useEffect(() => {
    const nowTs = Date.now()
    const sinceLastRun = nowTs - debugLoopLastRunAtRef.current
    debugLoopLastRunAtRef.current = nowTs
    // 触发稀疏（间隔够大）= 正常 churn，重置计数窗口，不让其跨会话累计。
    if (sinceLastRun > LOOP_WINDOW_RESET_MS) {
      debugLoopCountRef.current = 1
      debugLoopWindowStartRef.current = nowTs
    } else {
      debugLoopCountRef.current += 1
    }
    const debugRunId = debugLoopCountRef.current
    const debugSpaceTag = storageKey.slice(0, 8)
    const debugLogTag = `[RestoreCoord#${debugSpaceTag}] run#${debugRunId}`

    if (debugRunId > LOOP_RUN_THRESHOLD) {
      // 短时间内连续触发 = 真死循环。abort 打断循环后触发会变稀疏，
      // 上面的窗口重置会把计数归零，restore 随后自动恢复（不永久关停）。
      if (debugRunId === LOOP_RUN_THRESHOLD + 1 || debugRunId % 25 === 0) {
        logger.error(`${debugLogTag} LOOP DETECTED — effect ran ${debugRunId} times in ${nowTs - debugLoopWindowStartRef.current}ms, aborting`, {
          spaceId,
          tabScopeKey: storageKey,
          crawlspaceId: crawlspaceId ?? null,
          readyToRestore,
          hasDecision: !!decision,
          settled: restoreSettled,
          appliedSig: appliedSignatureRef.current?.slice(0, 80) ?? null,
          decisionChanged: decision?.changed,
        })
      }
      return
    }

    if (!readyToRestore || !decision) {
      logger.debug(`${debugLogTag} pending`, {
        readyToRestore,
        hasDecision: !!decision,
        readiness,
        settled: restoreSettled,
      })
      traceTabRestore('workbenchRestore:pending', {
        spaceId,
        tabScopeKey: storageKey,
        crawlspaceId: crawlspaceId ?? null,
        isForeground,
        readiness,
      })
      setResult(prev => restoreSettled ? { ...prev, restoreSettled: false, lastDecision: null } : prev)
      return
    }

    const decisionSignature = signatureRestoreDecision(decision)
    const decisionSigChanged = debugLastDecisionSigRef.current !== decisionSignature
    debugLastDecisionSigRef.current = decisionSignature

    if (appliedSignatureRef.current === decisionSignature && restoreSettled) {
      logger.debug(`${debugLogTag} guard-pass`, {
        sig: decisionSignature.slice(0, 60),
      })
      return
    }

    const contextState = useSpaceContextTabsStore.getState()
    const canvasState = useCanvasLayoutStore.getState()
    const currentContextSignature = buildContextTabsSignature({
      activeKey: contextState.activeKeyBySpace[storageKey] ?? null,
      displayKey: contextState.displayKeyBySpace[storageKey] ?? null,
      tabOrder: contextState.tabOrderBySpace[storageKey] ?? [],
      items: contextState.itemsBySpace[storageKey] ?? {},
    })
    const currentCanvasSignature = buildCanvasLayoutSignature(
      canvasState.spaceGroups[storageKey] ?? [],
    )
    const contextSignatureReady =
      !decision.changed.contextTabs || currentContextSignature === decision.baseSignature.contextTabs
    const canvasSignatureReady =
      !decision.changed.canvasLayout || currentCanvasSignature === decision.baseSignature.canvasLayout

    if (!contextSignatureReady || !canvasSignatureReady) {
      logger.debug(`${debugLogTag} sig-mismatch`, {
        decisionSigChanged,
        contextSignatureReady,
        canvasSignatureReady,
        decisionChanged: decision.changed,
        baseCtx: decision.baseSignature.contextTabs.slice(0, 60),
        curCtx: currentContextSignature.slice(0, 60),
        baseCanvas: decision.baseSignature.canvasLayout.slice(0, 60),
        curCanvas: currentCanvasSignature.slice(0, 60),
        prevSettled: restoreSettled,
      })
      traceTabRestore('workbenchRestore:signatureMismatch', {
        spaceId,
        tabScopeKey: storageKey,
        crawlspaceId: crawlspaceId ?? null,
        contextSignatureReady,
        canvasSignatureReady,
      })
      appliedSignatureRef.current = null
      setResult(prev => restoreSettled ? { ...prev, restoreSettled: false, lastDecision: decision } : prev)
      return
    }

    let contextApplied = true
    let canvasApplied = true
    if (decision.changed.contextTabs) {
      contextApplied = useSpaceContextTabsStore.getState().applyRestoreDecision(
        storageKey,
        decision.contextPatch,
        decision.baseSignature.contextTabs,
      )
    }
    if (decision.changed.canvasLayout) {
      canvasApplied = useCanvasLayoutStore.getState().applyRestoreDecision(
        storageKey,
        decision.canvasPatch.groups,
        decision.baseSignature.canvasLayout,
      )
    }

    logger.debug(`${debugLogTag} apply`, {
      decisionSigChanged,
      changed: decision.changed,
      applied: { ctx: contextApplied, canvas: canvasApplied },
      sig: decisionSignature.slice(0, 60),
      prevSettled: restoreSettled,
    })
    traceTabRestore('workbenchRestore:decision', {
      spaceId,
      tabScopeKey: storageKey,
      crawlspaceId: crawlspaceId ?? null,
      changed: decision.changed,
      applied: { contextTabs: contextApplied, canvasLayout: canvasApplied },
      activeSurface: decision.activeSurface,
      desiredActiveViewId: decision.desiredActiveViewId,
      trace: decision.trace,
    })

    if (!contextApplied || !canvasApplied) {
      logger.warn(`${debugLogTag} apply-failed`, {
        contextApplied,
        canvasApplied,
        changed: decision.changed,
      })
      appliedSignatureRef.current = null
      setResult(prev => restoreSettled ? { ...prev, restoreSettled: false, lastDecision: decision } : prev)
      return
    }

    appliedSignatureRef.current = decisionSignature
    const nextGeneration = {
      ...restoreScopeIdentity,
      sequence: ++sequenceRef.current,
    }
    setResult({
      restoreSettled: true,
      desiredActiveViewId: decision.desiredActiveViewId,
      activeSurface: decision.activeSurface,
      generation: nextGeneration,
      lastDecision: decision,
    })
  }, [
    isForeground,
    crawlspaceId,
    decision,
    readyToRestore,
    readiness,
    restoreSettled,
    restoreScopeIdentity,
    spaceId,
    storageKey,
  ])

  return scopedResult
}
