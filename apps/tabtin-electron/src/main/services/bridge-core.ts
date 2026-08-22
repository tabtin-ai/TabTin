/**
 * bridge-core.ts — 核心 API 注入桥接
 *
 * 将 Electron 主进程各服务（RunSession、ViewFactory、CrawlView、
 * ContextSpace、HttpCrawl、PtyManager 等）桥接到 @tabtin/action-tools
 * 的 set*API 接口，使工具层无需直接依赖 app 层路径。
 */

import { BrowserWindow, ipcMain, session } from 'electron'
import {
  getSharedBrowserToolImpl,
  getSharedSessionToolImpl,
  setCrawlToolRunnerFactory,
  cleanHtml,
  generateSkeletonHtml,
  filterHtmlByContentTypes,
  parseContentTypeWhitelist,
} from '@tabtin/action-tools/impl'
import {
  setRunSessionAPI,
  setViewFactoryAPI,
  setOrganizationTabManagerAPI,
  setViewStateRegistryAPI,
  setCrawlViewAPI,
  setContextSpaceAPI,
  setHttpCrawlAPI,
  setPtyManagerAPI,
  setPtyManagerBridge,
  setBrowserEnvAPI,
  setOffscreenRenderAPI,
  setUIThemeAPI,
  type UITheme,
} from '@tabtin/action-tools/runtime'
import { WidgetRenderService } from './WidgetRenderService'
import { initWidgetAuditLogger } from './widgetAuditLogger'
import { initResourceOpenTelemetryService } from './resourceOpenTelemetryService'
import { getBrowserEnvironmentService } from '../browser-env/BrowserEnvironmentService'
import { setBrowserCoreBridge } from '@tabtin/browser-core'
import { ElectronBrowserContext } from '../context/ElectronBrowserContext'

import { executeScript, getNavigationState, goBack, goForward, reload, stop, loadUrl, waitForTabReady, waitForSelector } from '../embedded-crawl-view'
import { getRunSessionManager } from '../run-session/RunSessionManager'
import { getViewFactory } from '../view-factory'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import { getViewStateRegistry } from '../webcontents/ViewStateRegistry'
import { ContextSpaceToolBridge } from './ContextSpaceToolBridge'
import { getCLISpaceId, getCLICrawlspaceId, setCLIContextSpaceBridge, getCLIOrganizationId, getCLIWorkspaceScopeKey } from '../cli/cli-context'
import { getPtyManager } from '../terminal/PtyManager'
import { getOrCreateElectronPtyManagerBridge as _getOrCreateElectronPtyManagerBridge, type ElectronPtyManagerBridge } from '../terminal/ElectronPtyManagerBridge'
import { TokenManager } from '../auth'
import { API_BASE_URL } from '../config/api'
import { ElectronCrawlToolRunner } from './ElectronCrawlToolRunner'
import { createLogger } from '../logger'
import { cdpCapture } from './cdp-actions'
import { ensureMainWindow } from '../window-manager'

const log = createLogger('ActionBridge:Core')

export interface BridgeCoreResult {
  contextSpaceBridge: ContextSpaceToolBridge
}

/**
 * 注入所有核心 API 桥接（RunSession / ViewFactory / CrawlView / ContextSpace / HttpCrawl / Pty 等）。
 * 返回需要由 FrontendActionBridge 管理生命周期的对象。
 */
export function setupCoreAPIs(mainWindow: BrowserWindow): BridgeCoreResult {
  // ── global.tabtin 初始化 ──────────────────────────────────────────────
  if (global.tabtin?.crawlView?.executeScript) {
    log.warn('global.tabtin 已被之前的 FrontendActionBridge 实例写入，即将覆盖 — 请确认不存在多实例')
  }
  if (!global.tabtin) global.tabtin = {}
  global.tabtin.apiBaseUrl = API_BASE_URL
  if (!global.tabtin.crawlView) global.tabtin.crawlView = {}
  global.tabtin.crawlView.executeScript = executeScript
  if (!global.tabtin.auth) {
    global.tabtin.auth = {
      getAccessToken: () => TokenManager.getAccessToken(),
    }
  }

  // ── C9 防御 #6：注入 `global.tabtin.organizationId` lazy getter ──────────
  //
  // 背景（C9 file_not_in_organization bug 收口审计）：ActionTool 内调
  // `uploadFileToOSS` 的 fallback 链路是
  //   `opts.organizationId || g?.tabtin?.organizationId || undefined`。
  // Daemon 端 `injectGlobalTabtin` 写了固定 organizationId（daemon 是启动期
  // 就定的单 organization 模型），但 Electron main 之前**完全没注入**，
  // fallback 永远 undefined → Django `_oss_resolve_organization` 退到用户
  // default organization，与 active organization 可能不同 → FileRecord 写错归属。
  //
  // 为什么用 lazy getter（不是固定赋值）：
  //   - Electron 是用户随时切换的多 organization（与 daemon 单 organization 不同）；
  //     `global.tabtin.organizationId = currentOrganizationId` 这种固定值在切
  //     organization 后就过期了。
  //   - 用 `Object.defineProperty + get()` 把字段读语义代理到
  //     `getCLIOrganizationId()`，每次属性访问跑函数拿 cli-context 模块的
  //     `currentOrganizationId` 真值。
  //   - oss-upload.ts:205 的 `g?.tabtin?.organizationId` 是属性访问语法，
  //     getter 与字面字段读语义完全等价（标准 JS），调用方无感知。
  //
  // 为什么不加新 IPC（A/B/C 方案都不选）：
  //   - cli-context.ts 的 `currentOrganizationId` 已经被 `space:set-active`
  //     链路 + chat IPC `syncCLISpaceContextFromQueryRequest` 兜底同步好，
  //     与 renderer `useOrganizationStore.getEffectiveOrganizationId()` 一致
  //     （是 main 端唯一可信的 active organization 真值源）。再加 IPC 就是
  //     重复造同款 state，引入"两条同步路径不一致"风险。
  //   - 同样语义在 `getCLISpaceId / getCLICrawlspaceId` 已经被 main 各处
  //     广泛复用（ElectronToolProvider / tabphone/ipc / cli-routes 等），
  //     organizationId 是它们的兄弟字段，复用现成 getter 是契合的。
  //
  // 详docs/agent/cli-spec/api-evolution-mutual-protection.md C9 §防御
  if (!Object.getOwnPropertyDescriptor(global.tabtin, 'organizationId')?.get) {
    Object.defineProperty(global.tabtin, 'organizationId', {
      get: () => getCLIOrganizationId() ?? undefined,
      configurable: true,
      enumerable: true,
    })
  }
  if (!global.tabtin.runSession) {
    global.tabtin.runSession = {
      get: (runId: string) => {
        try {
          return getRunSessionManager().getRun(runId)
        } catch { return null }
      },
      addEvent: (event: unknown) => {
        try {
          getRunSessionManager().addObservation?.(event as any)
        } catch { /* ignore */ }
      },
      openTab: async (options: any) => {
        try {
          return await getRunSessionManager().openTab(options)
        } catch (err) {
          log.warn('global.tabtin.runSession.openTab 失败:', err)
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }
  }

  // ── Browser / Session Tool Impl ──────────────────────────────────────
  //
  //  Phase 3: Agent 工具注入面统一走 ViewFactory.getWebContents 容器
  // 无关路径——原先注入 getView（WCV 容器对象），flag=webview 的 guest 条目
  // view 恒 null，Agent 浏览器/会话工具在 webview 模式全部拿不到 tab。
  // viewGetter 的消费方（TabResolver / SessionToolImpl）只读 `.webContents`，
  // 用 `{ webContents }` 适配对象即可，无须动 packages 层契约。
  const getPageWebContents = (tabId: string) => {
    const wc = getViewFactory().getWebContents(tabId)
    return wc && !wc.isDestroyed() ? wc : null
  }
  const browserImpl = getSharedBrowserToolImpl()
  browserImpl.setElectronViewGetter((tabId: string) => {
    log.debug('获取 View:', tabId)
    const wc = getPageWebContents(tabId)
    return wc ? { webContents: wc } : null
  })
  browserImpl.setContextFactory((tabId: string) => {
    const wc = getPageWebContents(tabId)
    if (!wc) return null
    return new ElectronBrowserContext(wc)
  })

  const sessionImpl = getSharedSessionToolImpl()
  sessionImpl.setElectronViewGetter((tabId: string) => {
    const wc = getPageWebContents(tabId)
    return wc ? { webContents: wc } : null
  })
  sessionImpl.setDefaultSessionGetter(() => session.defaultSession)

  browserImpl.setRunEventRecorder((event: any) => {
    try {
      const manager = getRunSessionManager();
      manager.addObservation(event);
    } catch (error) {
      log.warn('记录事件失败:', error);
    }
  })

  // 验证码人工介入：不再弹全局 toast、不再 await 用户（旧路径最长 120s，
  // CLI 先超时 → Agent 空转 glance）。墙信号由 browser-core 投影 captcha_required，
  // Agent captcha-wall-gate + 对话 ask_user 卡片接手。此处仅把相关 Tab 提到前台。
  browserImpl.setCaptchaInterventionCallback(async (tabId: string, _captchaInfo: any) => {
    try {
      const rsm = getRunSessionManager()
      rsm.switchTab({ viewId: tabId })
    } catch (e) {
      log.warn('switchTab 失败:', e)
    }
    return false
  })

  // ── RunSession API ───────────────────────────────────────────────────
  const manager = getRunSessionManager()
  setRunSessionAPI({
    openTab: manager.openTab.bind(manager),
    switchTab: manager.switchTab.bind(manager),
    closeTab: manager.closeTab.bind(manager),
    get: manager.getRun.bind(manager),
    addEvent: manager.addObservation.bind(manager)
  })

  // ── ViewFactory API ──────────────────────────────────────────────────
  const viewFactory = getViewFactory()
  setViewFactoryAPI({
    getViewState: viewFactory.getViewState.bind(viewFactory),
    getCurrentViewId: viewFactory.getCurrentViewId.bind(viewFactory),
  })

  // ── browser-core Bridge 注入 ────────────────────────────────────────
  setBrowserCoreBridge({
    cdpScreenshot: { capture: cdpCapture },
    viewFactory: {
      getViewState: viewFactory.getViewState.bind(viewFactory),
      getCurrentViewId: viewFactory.getCurrentViewId.bind(viewFactory),
    },
    // htmlCleaner：使 Electron snapshot 的 clean_html / skeleton_html 生成可用，并支撑
    // 内容类型白名单过滤（，browser --include），与 Daemon 端口径一致。
    htmlCleaner: {
      cleanHtml: (html: string) => cleanHtml(html),
      generateSkeletonHtml: (html: string) => generateSkeletonHtml(html),
      filterHtmlByContentTypes: (html: string, includeTypes: string[]) =>
        filterHtmlByContentTypes(html, parseContentTypeWhitelist(includeTypes) ?? new Set()),
    },
  })

  // ── Widget Wave 4: OffscreenRenderAPI 注入 ─────────────────────────
  // show_widget 工具 execute 时会 resolveOffscreenRenderAPI() 拿到这里注入
  // 的实现 → 烤 SVG 成 PNG buffer → 上传 OSS → emit RICH_CONTENT 带 image_url。
  // WidgetRenderService 内部走 OffscreenWindowPool（并发上限 2 + idle 30s evict）。
  // 详见 widget RFC §五 4.1 / 4.3。
  const widgetRenderService = WidgetRenderService.getInstance({
    logger: (msg) => log.debug(msg),
  })
  setOffscreenRenderAPI({
    renderToImage: (input) => widgetRenderService.renderToImage(input),
  })

  // ── Widget Wave 7 补丁: UIThemeAPI 注入 ──────────────────────────
  // 桥接 renderer 的当前 theme → show-widget 烤图 → OSS 上传 image_url。
  //
  // **为什么需要**：Wave 4 上线后 `show-widget/bake-upload.ts` 调 `renderToImage`
  // 没传 theme → 一路走默认 `'light'`。用户 dark mode 下 desktop chat 的 widget
  // 读 `useIsDarkMode()` 显示 dark，但移动端从 OSS 拿到的烤图永远是 light，跨端
  // 视觉分裂。
  //
  // **链路**：
  //   renderer useIsDarkMode useEffect → `tabtin.uiTheme.report('light' | 'dark')`
  //   → main ipcMain `ui:report-theme` handler → 更新 currentTheme 变量
  //   → show-widget execute 时 `resolveUITheme()` 读最新值 → 传给 renderToImage.
  //
  // **Daemon 模式**：Daemon 不注入 UIThemeAPI → `resolveUITheme()` 返回 null
  // → show-widget 内 fallback 到 `'light'`，与 Wave 4 上线的默认行为字面一致，
  // 不引入 Daemon 回归（Daemon 本身也没 UI theme 概念）。
  //
  // **线程安全**：main 单线程 event loop，currentTheme 变量读写无并发问题。
  let currentTheme: UITheme = 'light'
  setUIThemeAPI({ getCurrentTheme: () => currentTheme })
  ipcMain.handle('ui:report-theme', (_event, theme: unknown) => {
    if (theme === 'light' || theme === 'dark') {
      currentTheme = theme
    }
    return { ok: true, theme: currentTheme }
  })

  // ── Widget Wave 7 补丁: widgetAuditLogger 初始化 ──────────────────
  // renderer 每次成功触发 sendPrompt 时 fire-and-forget IPC 调
  // `widget-audit:append` 把 { timestamp, session_id, widget_id, text, meta,
  // trigger_source } append 到 `~/.tabtin/widget-audit.log`（JSON lines）。
  //
  // 运维 / 开发者出事故时：`tail -f ~/.tabtin/widget-audit.log` 能看到每条
  // sendPrompt 的完整上下文，哪怕 app 重启过 —— 修 RFC 决策 13 承诺的 audit
  // log 重启丢的短板。真正后端 audit 接口留给 Wave 8。
  initWidgetAuditLogger()

  // ── 「Agent 产物在 Space 内的打开」W7：埋点上报通路初始化 ──────
  // renderer 端 ResourceRouter.emitEvent 通过 IPC `telemetry:resource-open:emit`
  // 把 ResourceOpenEvent 转给 main 进程 telemetry queue（5s flush 或 100 条
  // flush 触发批量 POST 到 Django），失败重试 3 次仍失败落 DLQ
  // (`~/.tabtin/telemetry/resource_open_dlq.jsonl`)。
  //
  // 这是 PRD §6 三个成功标准的数据基础：上线后由 PM 跑 SQL/抽样脚本得到
  // "可见率"/"无意外感"/"评分配套" 真实数字，做不通这条上报通路 = 整个
  // 专题没法验证做对了。详见 RFC §8 + 总控 §2 W7。
  initResourceOpenTelemetryService()

  viewFactory.on('view:crash', (data: { id: string; reason: string; url: string }) => {
    log.warn(`View ${data.id} crashed (${data.reason}), notifying renderer`)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('crawl-view:crash-recovered', {
        viewId: data.id,
        reason: data.reason,
        url: data.url,
      })
    }
  })

  // ── WorkspaceTabManager API ──────────────────────────────────────────
  const organizationTabManager = getOrganizationTabManager()
  setOrganizationTabManagerAPI({
    getViewsByTab: organizationTabManager.getViewsByTab.bind(organizationTabManager),
    getViewMetadata: organizationTabManager.getViewMetadata.bind(organizationTabManager)
  })

  // ── ViewStateRegistry API ────────────────────────────────────────────
  const viewStateRegistry = getViewStateRegistry()
  setViewStateRegistryAPI({
    getState: viewStateRegistry.getState.bind(viewStateRegistry)
  })

  // ── CrawlView API ───────────────────────────────────────────────────
  setCrawlViewAPI({
    executeScript,
    getNavigationState,
    goBack,
    goForward,
    reload,
    stop,
    loadUrl,
    waitForTabReady,
    waitForSelector
  })

  // ── CrawlToolRunner Factory ──────────────────────────────────────────
  setCrawlToolRunnerFactory(() => new ElectronCrawlToolRunner())

  // ── HTTP Crawl API（轻量 fetch 实现，替代旧 EngineManager.scrape）────
  setHttpCrawlAPI({
    fetch: async (options) => {
      try {
        const controller = new AbortController()
        const timeout = options.timeout ?? 30000
        const timer = setTimeout(() => controller.abort(), timeout)

        const startTime = Date.now()
        const response = await globalThis.fetch(options.url, {
          headers: options.headers,
          signal: controller.signal,
          redirect: 'follow',
        })
        clearTimeout(timer)

        const contentType = response.headers.get('content-type') ?? 'text/html'
        const rawContent = await response.text()
        const title = contentType.includes('text/html')
          ? (rawContent.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? '')
          : ''

        return {
          success: true,
          data: {
            url: response.url || options.url,
            title,
            content: rawContent,
            content_type: contentType,
            status_code: response.status,
            response_time_ms: Date.now() - startTime,
          },
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
    },
  })

  // ── ContextSpace API ─────────────────────────────────────────────────
  const contextSpaceBridge = new ContextSpaceToolBridge(ensureMainWindow)
  setContextSpaceAPI({
    listContextSpace: (input) => contextSpaceBridge.invoke('list_context_space', input),
    closeContextTab: (input) => contextSpaceBridge.invoke('close_context_tab', input),
    setActiveContextTab: (input) => contextSpaceBridge.invoke('set_active_context_tab', input),
    restoreContextGroup: (input) => contextSpaceBridge.invoke('restore_context_group', input),
    assignPaneContent: (input) => contextSpaceBridge.invoke('assign_pane_content', input),
    splitPaneWithTab: (input) => contextSpaceBridge.invoke('split_pane_with_tab', input),
    movePane: (input) => contextSpaceBridge.invoke('move_pane', input),
    dockPane: (input) => contextSpaceBridge.invoke('dock_pane', input),
    createWebTab: (input) => contextSpaceBridge.invoke('create_web_tab', input)
  })

  setCLIContextSpaceBridge((action, payload, timeoutMs) => {
    const threadId =
      (typeof payload?._thread_id === 'string' && payload._thread_id.trim()) ||
      (typeof payload?.thread_id === 'string' && payload.thread_id.trim()) ||
      (typeof payload?.threadId === 'string' && payload.threadId.trim()) ||
      null
    // ：仅在带发起 thread 时注入该 thread 登记的 scope。
    // 无人手 thread 不把全局「最近一次」写成显式 tabScopeKey，避免人手 CLI
    // 在并行 Agent 期间被盖成最近会话桶；交给 renderer 升前台。
    const threadScopedKey = threadId ? getCLIWorkspaceScopeKey(threadId) : null
    const scopedPayload = threadScopedKey && !payload?.tabScopeKey && !payload?.workspaceScopeKey
      ? {
          ...(payload || {}),
          tabScopeKey: threadScopedKey,
          workspaceScopeKey: threadScopedKey,
        }
      : payload
    return contextSpaceBridge.invoke(action, scopedPayload, timeoutMs)
  })

  // ── PtyManager API（4 件套，人控路径）─────────────────────────────────
  setPtyManagerAPI({
    readOutput: (sessionId, options) => {
      return getPtyManager().getSessionOutput(sessionId, options)
    },
    listWithStatus: (spaceId) => {
      return getPtyManager().getAllSessionsWithStatus(spaceId)
    },
    executeCommand: (sessionId, command, options) => {
      return getPtyManager().executeCommand(sessionId, command, options)
    },
    spawnAgentSession: (spaceId, options) => {
      return getPtyManager().spawnAgentSession(spaceId, options)
    },
    getOrSpawnAgentSession: (threadId, spaceId, options) => {
      return getPtyManager().getOrSpawnAgentSession(threadId, spaceId, options)
    },
    resolveThreadSession: (threadId) => {
      return getPtyManager().resolveThreadSession(threadId)
    },
    write: (sessionId, data) => {
      return getPtyManager().write(sessionId, data)
    },
  })

  // ── PtyManagerBridge（本地 LLM ShellCap 路径）─────────────────────────
  // bootstrap 顺序契约（agent-bridge.ts L544-548）：
  //   PtyManager 就绪 → setPtyManagerBridge(bridge) → AgentHost 装配 ShellCap
  // Electron 端 PtyManager 单例同步可用（首次 getPtyManager() 即构造），
  // 在此立即调用 setPtyManagerBridge 完成注入，让后续 ElectronAgentHost
  // 装配 ShellCap 时 resolvePtyManagerBridge() 拿到真实 bridge 实例。
  // 注入失败 / 缺失 → AgentHost 装配段 fail-fast throw（D6 决策）。
  setPtyManagerBridge(getOrCreateElectronPtyManagerBridge())

  // ── Browser Environment API（Wave 2b-F） ─────────────────────────────
  //
  // 让 `packages/action-tools/src/tools/tab-management.ts` 的 `open_tab`
  // 能按 Space 绑定查到正确的登录环境 partition，从而 Agent 打开的 view
  // 自动继承 Space 的登录态。
  //
  // 直接把 Service 的**同步** getter 转过去——Service 自身已做了"未
  // ready → 默认 partition"的降级，不抛异常。
  setBrowserEnvAPI({
    getPartitionForSpace: (spaceId: string) => {
      try {
        return getBrowserEnvironmentService().getPartitionForSpace(spaceId)
      } catch (err) {
        log.warn('[BrowserEnvBridge] getPartitionForSpace 异常，返回 null 让调用方走兼容分支:', err)
        return null
      }
    },
  })

  return { contextSpaceBridge }
}

/**
 * 暴露 ElectronPtyManagerBridge 工厂。
 *
 * **生产装配点**：本文件 `setupCoreAPIs` 在 `setPtyManagerAPI` 之后立即调
 * `setPtyManagerBridge(getOrCreateElectronPtyManagerBridge())` 完成注入,
 * 时序满足 agent-bridge.ts L544-548 硬约束：
 *   `PtyManager 就绪` → `setPtyManagerBridge` → `assemble ShellCap`
 * （Electron 端 PtyManager 单例同步可用，无需 await ready；ElectronAgentHost
 * 装配 ShellCap 时通过 `resolvePtyManagerBridge()` 拿这里注入的实例。）
 *
 * **本函数仍 export**：单测 / 其它装配场景如需自行拿 bridge 实例（如直接
 * 构造 mock host）可继续 import 调用。
 *
 * **单例语义**：内部 cache，重复调返回同实例；首次调用同时跑磁盘 GC。
 *
 * @returns 直接挂在 Electron PtyManager 单例上的 bridge 实例
 */
export function getOrCreateElectronPtyManagerBridge(): ElectronPtyManagerBridge {
  return _getOrCreateElectronPtyManagerBridge(getPtyManager())
}
