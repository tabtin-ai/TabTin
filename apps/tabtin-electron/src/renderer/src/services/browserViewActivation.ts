import { useSyncExternalStore } from 'react'
import { createLogger } from '@/utils/logger'
import { crawlspaceContextClient } from '@/crawlspace/electron/crawlspace-context-client'
import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { useCrawlTabStore, type CrawlspacePersistedViewSeed, type CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { seedManager } from '@stores/seed-manager'

const log = createLogger('BrowserViewActivation')

export type BrowserViewActivationPhase = 'idle' | 'restoring' | 'failed'

export type BrowserViewActivationState = {
  phase: BrowserViewActivationPhase
  code?: BrowserViewActivationFailureCode
  message?: string
}

export type BrowserViewActivationFailureCode =
  | 'missing_metadata'
  | 'create_failed'
  | 'activate_failed'

export type BrowserViewActivationResult =
  | { ok: true; code: 'activated' | 'restored' | 'superseded' | 'cancelled' }
  | { ok: false; code: BrowserViewActivationFailureCode; message?: string }

export type RestorableView = Pick<
  CrawlspaceViewInfo | CrawlspacePersistedViewSeed,
  'viewId' | 'url' | 'title' | 'favicon' | 'runId' | 'openIntentHints'
> & {
  /** ：本地 HTML 预览 tab 的 file:// 放行根（仅持久种子携带）。 */
  localPreviewRoot?: string
}

export type BrowserViewSelectionTarget = {
  tabScopeKey: string
  tabKey?: string
}

export type BrowserViewActivationOptions = {
  spaceId?: string
  fallbackView?: RestorableView
  /** 页面真实存在且激活成功后才提交 renderer 选中态。 */
  selection?: BrowserViewSelectionTarget
  /**
   * 调度激活时的 Space activeKey 快照（内部填充）。
   * 用于判断完成时用户是否已切到「与启动时不同」的非浏览器 tab。
   */
  selectionActiveKeyAtStart?: string | null
  /**
   * 调度激活时的导航 intent revision（内部填充）。
   * 完成时若 revision 已前进，说明用户另有导航意图，不得再抢焦点。
   */
  selectionNavRevisionAtStart?: number
}

const IDLE_STATE: BrowserViewActivationState = Object.freeze({ phase: 'idle' })
const states = new Map<string, BrowserViewActivationState>()
const listeners = new Map<string, Set<() => void>>()
const intentListeners = new Map<string, Set<() => void>>()
const inFlight = new Map<string, Promise<BrowserViewActivationResult>>()
const inFlightOptions = new Map<string, BrowserViewActivationOptions>()
const latestIntentByCrawlspace = new Map<string, string>()
const cancelledKeys = new Set<string>()

const stateKey = (crawlspaceId: string, viewId: string) => `${crawlspaceId}\u0000${viewId}`

function emit(key: string): void {
  listeners.get(key)?.forEach(listener => listener())
}

function emitIntent(crawlspaceId: string): void {
  intentListeners.get(crawlspaceId)?.forEach(listener => listener())
}

function setLatestIntent(crawlspaceId: string, viewId: string): void {
  if (latestIntentByCrawlspace.get(crawlspaceId) === viewId) return
  latestIntentByCrawlspace.set(crawlspaceId, viewId)
  emitIntent(crawlspaceId)
}

function clearLatestIntent(crawlspaceId: string, viewId: string): void {
  if (latestIntentByCrawlspace.get(crawlspaceId) !== viewId) return
  latestIntentByCrawlspace.delete(crawlspaceId)
  emitIntent(crawlspaceId)
}

function setActivationState(
  crawlspaceId: string,
  viewId: string,
  next: BrowserViewActivationState,
): void {
  const key = stateKey(crawlspaceId, viewId)
  const previous = states.get(key) ?? IDLE_STATE
  if (
    previous.phase === next.phase &&
    previous.code === next.code &&
    previous.message === next.message
  ) {
    return
  }
  if (next.phase === 'idle') {
    states.delete(key)
  } else {
    states.set(key, next)
  }
  emit(key)
}

function getRestorableView(
  crawlspaceId: string,
  viewId: string,
  fallbackView?: RestorableView,
): RestorableView | null {
  const store = useCrawlTabStore.getState()
  const cached = store.crawlspaceContextCache?.[crawlspaceId]?.viewList.find(view => view.viewId === viewId)
  const persisted = store.crawlspacePersistedViews?.[crawlspaceId]?.find(view => view.viewId === viewId)
  const candidates = [cached, persisted, fallbackView]
    .filter((view): view is RestorableView => Boolean(view && view.viewId === viewId))
  return candidates.find(view => Boolean(view.url?.trim())) ?? candidates[0] ?? null
}

function getSeedBoundOpenIntentHints(
  crawlspaceId: string,
  viewId: string,
  url: string,
  restorable?: RestorableView | null,
  fallbackView?: RestorableView,
): RestorableView['openIntentHints'] {
  if (restorable?.url === url && restorable.openIntentHints) {
    return restorable.openIntentHints
  }
  const persisted = useCrawlTabStore.getState().crawlspacePersistedViews?.[crawlspaceId]
    ?.find(view => view.viewId === viewId)
  if (persisted?.url === url && persisted.openIntentHints) {
    return persisted.openIntentHints
  }
  if (fallbackView?.url === url && fallbackView.openIntentHints) {
    return fallbackView.openIntentHints
  }
  return undefined
}

function isDeferredView(crawlspaceId: string, viewId: string): boolean {
  return useCrawlTabStore.getState().crawlspaceDeferredViewIdsByCS?.[crawlspaceId]?.has(viewId) ?? false
}

function fail(
  crawlspaceId: string,
  viewId: string,
  code: BrowserViewActivationFailureCode,
  message?: string,
): BrowserViewActivationResult {
  setActivationState(crawlspaceId, viewId, { phase: 'failed', code, message })
  log.warn('激活浏览器标签失败', { crawlspaceId, viewId, code, message })
  return { ok: false, code, message }
}

function finishCancelled(
  crawlspaceId: string,
  viewId: string,
): BrowserViewActivationResult {
  const key = stateKey(crawlspaceId, viewId)
  cancelledKeys.delete(key)
  clearLatestIntent(crawlspaceId, viewId)
  setActivationState(crawlspaceId, viewId, IDLE_STATE)
  return { ok: true, code: 'cancelled' }
}

function readActiveKey(tabScopeKey: string): string | null {
  return useSpaceContextTabsStore.getState().activeKeyBySpace?.[tabScopeKey] ?? null
}

/**
 * 激活异步完成时是否仍应提交 selection。
 * 启动时在表格等非浏览器前景是正常的（点 URL 开页）；若期间用户已切到
 * **另一个**非浏览器 tab，则 selection 过期，不得再抢焦点。
 */
export function shouldCommitBrowserSelection(args: {
  currentActiveKey: string | null | undefined
  nextTabKey: string
  activeKeyAtStart: string | null | undefined
}): boolean {
  const current = args.currentActiveKey ?? null
  if (!current) return true
  if (current === args.nextTabKey) return true
  if (current.startsWith('tabweb:')) return true
  // 仍停在启动时的非浏览器前景 → 允许首次切到网页
  if (args.activeKeyAtStart !== undefined && current === args.activeKeyAtStart) return true
  // 启动快照缺失时保守提交（兼容旧调用）
  if (args.activeKeyAtStart === undefined) return true
  return false
}

function withSelectionBaseline(
  options?: BrowserViewActivationOptions,
): BrowserViewActivationOptions | undefined {
  if (!options?.selection?.tabScopeKey) return options
  const tabScopeKey = options.selection.tabScopeKey
  const next: BrowserViewActivationOptions = { ...options }
  if (next.selectionActiveKeyAtStart === undefined) {
    next.selectionActiveKeyAtStart = readActiveKey(tabScopeKey)
  }
  if (next.selectionNavRevisionAtStart === undefined) {
    const getRevision = useSpaceContextTabsStore.getState().getNavigationRevision
    next.selectionNavRevisionAtStart = getRevision?.(tabScopeKey) ?? 0
  }
  return next
}

function completeActivation(
  crawlspaceId: string,
  viewId: string,
  code: 'activated' | 'restored',
  options?: BrowserViewActivationOptions,
): BrowserViewActivationResult {
  if (latestIntentByCrawlspace.get(crawlspaceId) !== viewId) {
    setActivationState(crawlspaceId, viewId, IDLE_STATE)
    return { ok: true, code: 'superseded' }
  }

  const selection = options?.selection
  if (selection?.tabScopeKey) {
    const nextTabKey = selection.tabKey ?? `tabweb:${viewId}`
    const currentActiveKey = readActiveKey(selection.tabScopeKey)
    if (
      shouldCommitBrowserSelection({
        currentActiveKey,
        nextTabKey,
        activeKeyAtStart: options?.selectionActiveKeyAtStart,
      })
    ) {
      const applied = useSpaceContextTabsStore.getState().setActiveKey(
        selection.tabScopeKey,
        nextTabKey,
        {
          writer: 'async_completion',
          reason: 'browserViewActivation.complete',
          expectedRevision: options?.selectionNavRevisionAtStart,
        },
      )
      if (!applied) {
        log.info('跳过过期 selection：导航 intent revision 已前进', {
          crawlspaceId,
          viewId,
          tabScopeKey: selection.tabScopeKey,
          startedActive: options?.selectionActiveKeyAtStart ?? null,
          startedRevision: options?.selectionNavRevisionAtStart ?? null,
          currentActive: currentActiveKey,
          nextTabKey,
        })
      }
    } else {
      log.info('跳过过期 selection：激活期间用户已切到其他非浏览器 tab', {
        crawlspaceId,
        viewId,
        tabScopeKey: selection.tabScopeKey,
        startedActive: options?.selectionActiveKeyAtStart ?? null,
        currentActive: currentActiveKey,
        nextTabKey,
      })
    }
  }
  setActivationState(crawlspaceId, viewId, IDLE_STATE)
  clearLatestIntent(crawlspaceId, viewId)
  return { ok: true, code }
}

function isMissingViewError(message?: string): boolean {
  return Boolean(message && /view not found|不存在/i.test(message))
}

async function runActivation(
  crawlspaceId: string,
  viewId: string,
  options?: BrowserViewActivationOptions,
): Promise<BrowserViewActivationResult> {
  const startedAt = Date.now()
  const restorable = getRestorableView(crawlspaceId, viewId, options?.fallbackView)
  const key = stateKey(crawlspaceId, viewId)

  if (!isDeferredView(crawlspaceId, viewId)) {
    const activeResult = await crawlspaceContextClient.setActiveView(crawlspaceId, viewId)
    if (cancelledKeys.has(key)) {
      return finishCancelled(crawlspaceId, viewId)
    }
    if (activeResult?.success) {
      log.debug('浏览器标签已激活', { crawlspaceId, viewId, elapsedMs: Date.now() - startedAt })
      return completeActivation(
        crawlspaceId,
        viewId,
        'activated',
        inFlightOptions.get(key) ?? options,
      )
    }
    if (!isMissingViewError(activeResult?.error)) {
      return fail(crawlspaceId, viewId, 'activate_failed', activeResult?.error)
    }
    // renderer 可能因旧版本或异常退出丢过 deferred 标记；main 明确说 view 不存在时，
    // 只要持久层仍有 URL，就按冷启动恢复处理，避免再次落入白屏。
  }

  if (!restorable) {
    return fail(crawlspaceId, viewId, 'missing_metadata')
  }

  setActivationState(crawlspaceId, viewId, { phase: 'restoring' })
  log.info('开始恢复浏览器标签', { crawlspaceId, viewId })

  const config = useCrawlTabStore.getState().getCrawlspaceConfig(crawlspaceId)
  const ipcAdapter = createElectronIpcAdapter(
    crawlspaceId,
    options?.spaceId ?? config?.spaceId ?? config?.projectId,
  )
  const url = restorable.url?.trim() || 'about:blank'
  // ：本地 HTML 预览 tab 的 file:// 放行根。restorable 可能命中主进程
  // 快照缓存（不带 root），这里显式从持久种子 / fallback 补——缺失则重建出的
  // view 会被主进程 file:// 门禁拒绝，恢复后空白。
  const localPreviewRoot =
    restorable.localPreviewRoot ||
    useCrawlTabStore.getState().crawlspacePersistedViews?.[crawlspaceId]
      ?.find(view => view.viewId === viewId)?.localPreviewRoot ||
    options?.fallbackView?.localPreviewRoot
  const openIntentHints = getSeedBoundOpenIntentHints(
    crawlspaceId,
    viewId,
    url,
    restorable,
    options?.fallbackView,
  )
  const createOptions =
    localPreviewRoot || openIntentHints
      ? {
          ...(localPreviewRoot ? { localPreviewRoot } : {}),
          ...(openIntentHints ? { openIntentHints } : {}),
        }
      : undefined
  let created = false
  try {
    created = await ipcAdapter.createView(
      viewId,
      url,
      restorable.runId,
      restorable.title,
      undefined,
      createOptions,
    )
  } catch (error) {
    if (cancelledKeys.has(key)) {
      return finishCancelled(crawlspaceId, viewId)
    }
    return fail(
      crawlspaceId,
      viewId,
      'create_failed',
      error instanceof Error ? error.message : String(error),
    )
  }

  if (!created) {
    if (cancelledKeys.has(key)) {
      return finishCancelled(crawlspaceId, viewId)
    }
    if (latestIntentByCrawlspace.get(crawlspaceId) !== viewId) {
      setActivationState(crawlspaceId, viewId, IDLE_STATE)
      return { ok: true, code: 'superseded' }
    }
    // 另一入口可能刚好先创建成功。最后再以“能否激活”判定，避免把成功竞态误报为失败。
    const racedActivation = await crawlspaceContextClient.setActiveView(crawlspaceId, viewId)
    if (cancelledKeys.has(key)) {
      return finishCancelled(crawlspaceId, viewId)
    }
    if (!racedActivation?.success) {
      return fail(crawlspaceId, viewId, 'create_failed', racedActivation?.error)
    }
  }

  if (cancelledKeys.has(key)) {
    await ipcAdapter.destroyView(viewId)
    log.info('浏览器标签恢复被关闭操作取消', {
      crawlspaceId,
      viewId,
      elapsedMs: Date.now() - startedAt,
    })
    return finishCancelled(crawlspaceId, viewId)
  }

  useCrawlTabStore.getState().unmarkCrawlspaceViewDeferred(crawlspaceId, viewId)
  seedManager.ensureSeed(crawlspaceId, {
    viewId,
    url,
    title: restorable.title,
    favicon: restorable.favicon,
    runId: restorable.runId,
    localPreviewRoot,
    openIntentHints,
  })

  // A、B 快速连续点击时，A 可以完成重建以便下次秒开，但不能在完成较晚时抢回焦点。
  if (latestIntentByCrawlspace.get(crawlspaceId) !== viewId) {
    log.debug('浏览器标签恢复完成但激活意图已被替换', {
      crawlspaceId,
      viewId,
      elapsedMs: Date.now() - startedAt,
    })
    return completeActivation(
      crawlspaceId,
      viewId,
      'restored',
      inFlightOptions.get(key) ?? options,
    )
  }

  const activeResult = await crawlspaceContextClient.setActiveView(crawlspaceId, viewId)
  if (cancelledKeys.has(key)) {
    return finishCancelled(crawlspaceId, viewId)
  }
  if (!activeResult?.success) {
    return fail(crawlspaceId, viewId, 'activate_failed', activeResult?.error)
  }

  log.info('浏览器标签恢复并激活完成', {
    crawlspaceId,
    viewId,
    elapsedMs: Date.now() - startedAt,
  })
  return completeActivation(
    crawlspaceId,
    viewId,
    'restored',
    inFlightOptions.get(key) ?? options,
  )
}

/**
 * 浏览器标签唯一激活入口。
 *
 * 调用方把选中目标放在 options.selection 中；本函数只在真实 view 已存在且 main 进程
 * 激活成功后提交 renderer 选中态。失败状态通过 useBrowserViewActivationState 暴露给 UI。
 */
export function activateBrowserView(
  crawlspaceId: string,
  viewId: string,
  options?: BrowserViewActivationOptions,
): Promise<BrowserViewActivationResult> {
  setLatestIntent(crawlspaceId, viewId)
  const key = stateKey(crawlspaceId, viewId)
  const normalizedOptions = withSelectionBaseline(options)
  const existing = inFlight.get(key)
  if (existing) {
    if (normalizedOptions) {
      const previous = inFlightOptions.get(key)
      inFlightOptions.set(key, {
        ...previous,
        ...normalizedOptions,
        fallbackView: normalizedOptions.fallbackView ?? previous?.fallbackView,
        selection: normalizedOptions.selection ?? previous?.selection,
        // 保留首次调度时的前景快照，避免合并后到的 options 覆盖基线
        selectionActiveKeyAtStart:
          previous?.selectionActiveKeyAtStart !== undefined
            ? previous.selectionActiveKeyAtStart
            : normalizedOptions.selectionActiveKeyAtStart,
        selectionNavRevisionAtStart:
          previous?.selectionNavRevisionAtStart !== undefined
            ? previous.selectionNavRevisionAtStart
            : normalizedOptions.selectionNavRevisionAtStart,
      })
    }
    return existing
  }
  cancelledKeys.delete(key)
  if (normalizedOptions) inFlightOptions.set(key, normalizedOptions)

  const task = runActivation(crawlspaceId, viewId, normalizedOptions)
    .catch(error => fail(
      crawlspaceId,
      viewId,
      'activate_failed',
      error instanceof Error ? error.message : String(error),
    ))
    .finally(() => {
      inFlight.delete(key)
      inFlightOptions.delete(key)
    })
  inFlight.set(key, task)
  return task
}

export function cancelBrowserViewActivation(crawlspaceId: string, viewId: string): void {
  const key = stateKey(crawlspaceId, viewId)
  if (inFlight.has(key)) {
    cancelledKeys.add(key)
  }
  if (latestIntentByCrawlspace.get(crawlspaceId) === viewId) {
    clearLatestIntent(crawlspaceId, viewId)
  }
  setActivationState(crawlspaceId, viewId, IDLE_STATE)
}

export function retryBrowserViewActivation(
  crawlspaceId: string,
  viewId: string,
  options?: BrowserViewActivationOptions,
): Promise<BrowserViewActivationResult> {
  setActivationState(crawlspaceId, viewId, { phase: 'restoring' })
  return activateBrowserView(crawlspaceId, viewId, options)
}

export function getBrowserViewActivationState(
  crawlspaceId?: string | null,
  viewId?: string | null,
): BrowserViewActivationState {
  if (!crawlspaceId || !viewId) return IDLE_STATE
  return states.get(stateKey(crawlspaceId, viewId)) ?? IDLE_STATE
}

export function subscribeBrowserViewActivationState(
  crawlspaceId: string | null | undefined,
  viewId: string | null | undefined,
  listener: () => void,
): () => void {
  if (!crawlspaceId || !viewId) return () => undefined
  const key = stateKey(crawlspaceId, viewId)
  const bucket = listeners.get(key) ?? new Set<() => void>()
  bucket.add(listener)
  listeners.set(key, bucket)
  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) listeners.delete(key)
  }
}

export function useBrowserViewActivationState(
  crawlspaceId?: string | null,
  viewId?: string | null,
): BrowserViewActivationState {
  return useSyncExternalStore(
    listener => subscribeBrowserViewActivationState(crawlspaceId, viewId, listener),
    () => getBrowserViewActivationState(crawlspaceId, viewId),
    () => IDLE_STATE,
  )
}

export function getBrowserViewActivationIntent(crawlspaceId?: string | null): string | null {
  if (!crawlspaceId) return null
  return latestIntentByCrawlspace.get(crawlspaceId) ?? null
}

export function subscribeBrowserViewActivationIntent(
  crawlspaceId: string | null | undefined,
  listener: () => void,
): () => void {
  if (!crawlspaceId) return () => undefined
  const bucket = intentListeners.get(crawlspaceId) ?? new Set<() => void>()
  bucket.add(listener)
  intentListeners.set(crawlspaceId, bucket)
  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) intentListeners.delete(crawlspaceId)
  }
}

export function useBrowserViewActivationIntent(crawlspaceId?: string | null): string | null {
  return useSyncExternalStore(
    listener => subscribeBrowserViewActivationIntent(crawlspaceId, listener),
    () => getBrowserViewActivationIntent(crawlspaceId),
    () => null,
  )
}

/** 仅供单元测试隔离模块级并发状态。 */
export function resetBrowserViewActivationStateForTests(): void {
  states.clear()
  listeners.clear()
  intentListeners.clear()
  inFlight.clear()
  inFlightOptions.clear()
  latestIntentByCrawlspace.clear()
  cancelledKeys.clear()
}
