import type { BrowserWindow, WebContents } from 'electron'
import { startupPerf, createLogger } from './logger'
import { withStepTimeout, STEP_TIMEOUT_MS } from './deferred-utils'
import type { UpdateManager } from './services/UpdateManager'
import type {
  ContextSpaceShortcutGuardOptions,
  MainWindowAppearance,
} from './types/runtime'

const mainLog = createLogger('Main')

let updateManagerRef: UpdateManager | null = null

let _crossCuttingDeps: {
  getRunSessionManager: () => { stopTimeoutChecker(): void; endAllRuns(): Promise<void> }
  cleanupApprovalManager: () => void
  getLocalMcpService: () => { dispose(): void }
  getEventPersistence: () => { init(): Promise<void>; destroy(): Promise<void> }
  electronWsGateway: { close(): void; setMainWindow?(win: BrowserWindow | null): void }
} | null = null

// ── 域模块引用（init 时填充，dispose 时使用） ──

let _viewFactoryDomain: typeof import('./deferred-init-view-factory') | null = null
let _actionBridgeDomain: typeof import('./deferred-init-action-bridge') | null = null
let _crawlspaceDomain: typeof import('./deferred-init-crawlspace') | null = null
let _tinsDomain: typeof import('./deferred-init-tins') | null = null
let _miscDomain: typeof import('./deferred-init-misc') | null = null

// ── 公共接口（保持原有导出签名） ──

export function setDeferredServicesUpdateManager(updateManager: UpdateManager | null): void {
  updateManagerRef = updateManager
}

export function getDeferredViewFactory(): ReturnType<typeof import('./view-factory').getViewFactory> | null {
  return _viewFactoryDomain?.getDeferredViewFactory() ?? null
}

export { getCapabilityDiscoveryService } from './capability-discovery-accessor'

export interface DeferredServiceHooks {
  getCurrentAppearance: () => MainWindowAppearance
  isQuitting: () => boolean
  registerContextSpaceShortcutGuard: (
    webContents: WebContents,
    options?: ContextSpaceShortcutGuardOptions,
  ) => void
  cleanupContextSpaceShortcutGuard: (webContents: WebContents) => void
  ensureWebContentsThemeSync: (webContents: WebContents) => void
  cleanupWebContentsThemeSync: (webContents: WebContents) => void
  applyAppearanceToWebContents: (
    webContents: WebContents,
    appearance: MainWindowAppearance,
  ) => void
}

// ── 初始化编排 ──

export async function initializeDeferredServices(
  mainWindow: BrowserWindow,
  hooks: DeferredServiceHooks,
): Promise<void> {
  startupPerf.mark('deferred-imports')

  const [
    viewFactoryDomain,
    actionBridgeDomain,
    crawlspaceDomain,
    tinsDomain,
    miscDomain,
    { getEventPersistence },
    { electronWsGateway },
    { getRunSessionManager },
    { cleanupApprovalManager, initApprovalSync },
    { getLocalMcpService },
    { getMainWindow: getMainWindowFromManager },
  ] = await Promise.all([
    import('./deferred-init-view-factory'),
    import('./deferred-init-action-bridge'),
    import('./deferred-init-crawlspace'),
    import('./deferred-init-tins'),
    import('./deferred-init-misc'),
    import('./run-session/EventPersistence'),
    import('./ws/ElectronWsGateway'),
    import('./run-session/RunSessionManager'),
    import('./services/ApprovalManager'),
    import('./services/LocalMcpService'),
    import('./window-manager'),
  ])

  _viewFactoryDomain = viewFactoryDomain
  _actionBridgeDomain = actionBridgeDomain
  _crawlspaceDomain = crawlspaceDomain
  _tinsDomain = tinsDomain
  _miscDomain = miscDomain

  _crossCuttingDeps = {
    getRunSessionManager,
    cleanupApprovalManager,
    getLocalMcpService,
    getEventPersistence,
    electronWsGateway,
  }

  startupPerf.measure('deferred-imports')

  // ── IPC 延迟注册（极轻量，提前注册以消除竞态窗口） ──

  const { registerDeferredIpcHandlers } = await import('./ipc-lazy')
  await registerDeferredIpcHandlers()

  // ── Browser Environment 主进程单例启动(本地化退役 Wave 1) ──
  //
  // BrowserEnvironmentService 构造时已经同步用 guest snapshot 初始化,IPC
  // 立即可用(getPartitionForSpace 永远返回真实 partition)。`start()` 是
  // 异步切到真实 userId 的快照(并注册 onAuthChanged 监听任意 auth 变化:
  // 登录/刷新/登出/部分清除都会触发 reload),失败不影响主流程 —— 服务
  // 继续用 guest 数据工作。
  //
  // CookieSyncService 链式 await 启动:确保第一次 rebuild 拿得到 envs。
  // 失败降级:跨 Space 登录同步暂时不工作,其他功能正常。
  import('./browser-env/BrowserEnvironmentService')
    .then(async ({ getBrowserEnvironmentService }) => {
      // 边界改造 Phase 3a：把"当前活跃 Organization id"解析器注入 BES，让普通
      // 浏览器走 Organization 级共享 cookie partition。getCLIOrganizationId 由
      // `space:set-active` / chat query 链路维护，是主进程当前 organization 的真相。
      try {
        const { getCLIOrganizationId } = await import('./cli/cli-context')
        getBrowserEnvironmentService().setCurrentOrganizationIdResolver(() => getCLIOrganizationId())
      } catch (err) {
        mainLog.warn('注入 organization partition 解析器失败(普通浏览器回落默认 env partition):', err)
      }
      return getBrowserEnvironmentService().start()
    })
    .then(async () => {
      try {
        const { getCookieSyncService } = await import('./browser-env/CookieSyncService')
        await getCookieSyncService().start()
        mainLog.info('CookieSyncService 启动完成')
      } catch (err) {
        mainLog.warn('CookieSyncService 启动失败(跨 Space 登录同步暂时不可用):', err)
      }
    })
    .catch((err) => {
      mainLog.warn('BrowserEnvironmentService 启动失败(继续使用 guest snapshot):', err)
    })

  // ── Phase 1 并行：ViewFactory + DownloadManager + EventPersistence ──

  startupPerf.mark('Phase1 并行')

  const initEventPersistenceTask = async () => {
    startupPerf.mark('EventPersistence')
    try {
      await getEventPersistence().init()
      mainLog.info('EventPersistence 初始化完成')
    } catch (err) {
      mainLog.warn('EventPersistence 初始化失败（非致命）:', err)
    }
    startupPerf.measure('EventPersistence')
  }

  await Promise.allSettled([
    viewFactoryDomain.initViewFactory(mainWindow, hooks),
    initEventPersistenceTask(),
    import('./overlay/init-overlay-view').then(({ initOverlayView }) => initOverlayView(mainWindow)),
  ])

  startupPerf.measure('Phase1 并行')

  if (hooks.isQuitting()) return

  // ── Phase 2：Action Bridge + Crawlspace 并行 ──

  startupPerf.mark('Phase2')

  const [actionResult, crawlResult, agentHostResult] = await Promise.allSettled([
    actionBridgeDomain.initActionBridge(mainWindow),
    crawlspaceDomain.initCrawlspace(mainWindow),
    actionBridgeDomain.initLocalAgentHost(),
  ])

  if (actionResult.status === 'rejected') {
    mainLog.error('Phase2 ActionBridge 域初始化失败:', actionResult.reason)
  }
  if (crawlResult.status === 'rejected') {
    mainLog.error('Phase2 Crawlspace 域初始化失败:', crawlResult.reason)
  }
  if (agentHostResult.status === 'rejected') {
    mainLog.error('Phase2 LocalAgentHost 域初始化失败:', agentHostResult.reason)
  }

  if (hooks.isQuitting()) return

  // ── 审批偏好跨设备同步初始化（#20）──
  try {
    initApprovalSync()
  } catch (err) {
    mainLog.debug('initApprovalSync 失败（非致命）:', err)
  }

  // ── 串行尾部：Tins（依赖 CrawlView）+ Misc ──

  const crawlViewOk = crawlResult.status === 'fulfilled' && crawlResult.value.crawlViewPipelineOk
  if (!crawlViewOk) {
    mainLog.warn('CrawlView 管线初始化失败，跳过 Tins 模块（依赖 CrawlView）')
  } else {
    await tinsDomain.initTins(mainWindow)
  }

  await miscDomain.initMisc({
    getMainWindow: getMainWindowFromManager,
    wsGateway: electronWsGateway,
    agentServicePause: () => actionBridgeDomain.getElectronAgentServiceRef()?.pauseTimers(),
    agentServiceResume: () => actionBridgeDomain.getElectronAgentServiceRef()?.resumeTimers(),
    eventPersistence: getEventPersistence(),
  })

  startupPerf.measure('Phase2')
  mainLog.info('延迟初始化全部完成')
}

// ── rebind ──

export function rebindMainWindowServices(mainWindow: BrowserWindow): void {
  updateManagerRef?.setMainWindow(mainWindow)
  _viewFactoryDomain?.rebindViewFactory(mainWindow)
  _actionBridgeDomain?.rebindActionBridge(mainWindow)
  _crawlspaceDomain?.rebindCrawlspace(mainWindow)
  _tinsDomain?.rebindTins(mainWindow)
  _crossCuttingDeps?.electronWsGateway?.setMainWindow?.(mainWindow)
  void import('./overlay/init-overlay-view').then(({ rebindOverlayView }) => {
    rebindOverlayView(mainWindow)
  })
}

// ── 清理编排 ──

export async function disposeDeferredServices(): Promise<void> {
  if (!_crossCuttingDeps) {
    mainLog.warn('disposeDeferredServices: 模块引用不可用（initializeDeferredServices 未执行）')
    return
  }

  const deps = _crossCuttingDeps

  // ── Phase 1: 串行 — 停止定时器与前置清理 ──

  try {
    deps.getRunSessionManager().stopTimeoutChecker()
  } catch {
    // ignore — RunSessionManager 可能未初始化
  }

  _miscDomain?.disposeSleepGuardSync()
  _crawlspaceDomain?.disposeCrawlspaceEarly()
  deps.cleanupApprovalManager()
  void import('./overlay/init-overlay-view').then(({ destroyOverlayView }) => {
    destroyOverlayView()
  })

  // ── Phase 2: 并行 — 互不依赖的模块同时清理 ──

  const parallelCleanups: Promise<void>[] = []

  parallelCleanups.push(
    withStepTimeout(
      () => deps.getRunSessionManager().endAllRuns(),
      STEP_TIMEOUT_MS,
      'RunSessionManager.endAllRuns',
    ).then(() => {}),
  )

  if (_tinsDomain) {
    parallelCleanups.push(
      _tinsDomain.disposeTins(),
    )
  }

  if (_actionBridgeDomain) {
    parallelCleanups.push(
      withStepTimeout(
        () => _actionBridgeDomain!.disposeActionBridgeParallel(),
        STEP_TIMEOUT_MS,
        'electronAgentService.stop',
      ).then(() => {}),
    )
  }

  parallelCleanups.push(
    withStepTimeout(
      () => Promise.resolve(deps.getLocalMcpService().dispose()),
      STEP_TIMEOUT_MS,
      'LocalMcpService.dispose',
    ).then(() => {}),
  )

  await Promise.all(parallelCleanups)

  // ── EventPersistence ──

  await withStepTimeout(
    async () => {
      await deps.getEventPersistence().destroy()
      mainLog.info('EventPersistence 已关闭')
    },
    STEP_TIMEOUT_MS,
    'EventPersistence.destroy',
  )

  // ── Phase 3: 串行 — 依赖 Phase 2 完成的 CrawlView / ActionBridge 清理 ──

  if (_crawlspaceDomain) {
    await _crawlspaceDomain.disposeCrawlspaceFull()
  }

  if (_actionBridgeDomain) {
    await _actionBridgeDomain.disposeActionBridgeSerial()
  }

  // ── Phase 4: 同步清理 — 关闭连接 / 置空引用 ──

  try {
    // Wave 2b 任务 E：停止 CookieSync 监听，避免在进程退出清理阶段仍继续
    // 触发 session.cookies 回调（退出期的 session 引用可能已不稳定）。
    const { getCookieSyncService } = await import('./browser-env/CookieSyncService')
    getCookieSyncService().stop()
  } catch { /* ignore */ }

  try {
    deps.electronWsGateway.close()
  } catch { /* ignore */ }

  _viewFactoryDomain?.disposeViewFactory()

  updateManagerRef = null
  _crossCuttingDeps = null
  _viewFactoryDomain = null
  _actionBridgeDomain = null
  _crawlspaceDomain = null
  _tinsDomain = null
  _miscDomain = null
}
