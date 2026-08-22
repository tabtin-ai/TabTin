import type { BrowserWindow } from 'electron'
import { app } from 'electron'

import { electronApp, optimizer } from '@electron-toolkit/utils'

import { registerAuthHandlers } from './auth'
import { registerUninstallCleanupHandlers } from './services/UninstallCleanupService'
import { registerApiProxyHandlers } from './api-proxy'
import { initContextMenuI18n } from './context-menu'
import { resolveStartupUiLocale } from './startup-ui-locale'
import { setupApplicationMenu } from './application-menu'
import { setTerminalCoreLocale } from '@tabtin/terminal-core'
import { registerCheckpointIpcHandlers } from './checkpoint/checkpoint-ipc'
import { registerFileHistoryIpcHandlers } from './file-history/file-history-ipc'
import { registerFileEditPatchIpcHandlers } from './file-edit-patches/file-edit-patch-ipc'
import { registerTabtinFileProtocol } from './file-system/protocol'
import { registerGitIpcHandlers } from './git-ipc'
import { registerDeferredIpcStubs } from './ipc-lazy'
import { registerSurfaceAsIpc } from './wire/register-surface-as-ipc'
import { chatExportMd } from '@tabtin/cli-server-core/surfaces/chat-export-md'
import { createSessionSurfaces } from '@tabtin/cli-server-core/surfaces/session'
import { getSessionManager } from './session/SessionManager'
import {
  registerMainProcessIPCHandlers,
  type MainProcessIpcRegistryDependencies,
} from './ipc-registry'
import { registerNativeMenuHandlers } from './native-menu'
import { type DisplayMediaLogger, installDisplayMediaHandlers } from './services/display-media'
import { installExternalProtocolGuards } from './external-protocol-guard'
import { notificationService } from './services/notification'
import { registerOrganizationHandlers } from './organization-handler'
import { registerDiagnosticsIpc } from './diagnostics/diagnostics-ipc'
import { startDiagnosticSession } from './diagnostics/diagnostic-runtime'
import { startDiagnosticUploader } from './diagnostics/diagnostic-uploader'
import { registerNetworkRecoveryIpc } from './network-recovery'
import { installElectronTelemetrySink } from './agent/platform/telemetry-sink'
import { kickoffUpgradePartitionStartupClear } from './services/FrontendActionBridge'
import { initDesktopAuditLogger } from './services/desktop-audit-logger'
import { registerSkillsPreinstalledBucket } from './services/SkillsBucketRegistration'
import { registerMarketplaceAppsBucket } from './services/MarketplaceAppInstaller'
import { registerPersonalPluginMarketplaceIpc } from './services/PersonalPluginMarketplaceService'
import { registerMcpLocalConnectionsBucket } from './services/LocalMcpService'
import { registerTinSandboxBucket } from './tins/tin-sandbox'
import { initDaemonStorageBridge } from './services/DaemonStorageBridgeService'
import { initStorageManagerIpc } from './services/StorageManagerIpcService'
import { registerBrowserStorageBuckets } from './services/BrowserStorageBucketRegistration'
import { registerMediaStorageBuckets } from './services/MediaStorageBucketRegistration'
import { registerCheckpointSummaryExportBucket } from './services/CheckpointSummaryExport'
import { registerConversationSummaryExportBucket } from './services/ConversationSummaryExport'
import { registerStorageExportFileWriter } from './services/StorageExportFileWriter'
import { setUserDataOverride } from '@tabtin/shared/storage-paths'
import { shouldAllowMainDevTools } from './package-protection'
import { createLogger } from './logger'

const log = createLogger('startup-services')

export interface StartupServicesLogger extends DisplayMediaLogger {}

export interface StartupServicesOptions {
  isDev: boolean
  appUserModelId: string
  rendererUrl?: string
  displayMediaTrustedOrigins?: string[]
  log?: StartupServicesLogger
  ipcDependencies: MainProcessIpcRegistryDependencies
  ensureMainWindowForNotification: () => Promise<BrowserWindow | null>
}

const setupBrowserWindowShortcuts = (isDev: boolean, allowMainDevTools: boolean): void => {
  app.on('browser-window-created', (_, window) => {
    if (isDev) {
      optimizer.watchWindowShortcuts(window, { escToCloseWindow: false, zoom: true })
    }

    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key.toLowerCase() === 'p' && (input.control || input.meta) && !input.shift && !input.alt) {
        event.preventDefault()
        window.webContents.send('shortcut:quick-open')
      }

      if (!allowMainDevTools) {
        if (input.key === 'F12') {
          event.preventDefault()
        }
        if (input.key === 'I' && input.shift && (input.control || input.meta)) {
          event.preventDefault()
        }
        if (input.key === 'J' && input.shift && (input.control || input.meta)) {
          event.preventDefault()
        }
        if (input.key === 'U' && (input.control || input.meta) && !input.shift && !input.alt) {
          event.preventDefault()
        }
      }
    })
  })
}

const registerCoreProcessHandlers = (): void => {
  registerAuthHandlers()
  registerUninstallCleanupHandlers()
  registerApiProxyHandlers()
  registerNativeMenuHandlers()
  initContextMenuI18n()
  const startupLocale = resolveStartupUiLocale()
  setTerminalCoreLocale(startupLocale === 'zh-CN' || startupLocale === 'zh-TW' ? 'zh-CN' : 'en-US')
  registerOrganizationHandlers()
  registerGitIpcHandlers()
  registerCheckpointIpcHandlers()
  registerFileHistoryIpcHandlers()
  registerFileEditPatchIpcHandlers()
  registerDiagnosticsIpc()
  void startDiagnosticSession()
  startDiagnosticUploader()
  registerNetworkRecoveryIpc()
  // 注：W7 resource_open telemetry 上报通路 (ResourceOpenTelemetryService) 由
  // services/bridge-core.ts 内 init 期挂载（与 widgetAuditLogger / WidgetRenderService
  // 等 agent runtime bridge 同生命周期），避免本文件的"core handlers"层级混入
  // tab-app 派生服务的依赖链。详见 RFC v1.0 §8.3 + 总控 §2 W7。
  // tabtin-file:// 协议：不是 IPC handler 而是 session.protocol，必须在
  // 任何 BrowserWindow 创建前注册——否则首屏组件加载本地资源（FilePreview /
  // MarkdownViewer / 沙箱内图片）会拿到 net::ERR_UNKNOWN_URL_SCHEME。
  // app.whenReady 已 resolve，session.defaultSession 在此处可用。
  registerTabtinFileProtocol()

  // W1.3 / A2-H2：访问受限升级流程复用单一 transient partition，启动期一次性
  // 清掉上次会话残留——保证升级 view 永远从干净状态出发，而 partition 目录
  // 不会跨会话累积。fire-and-forget：清理失败不阻塞启动。
  //
  // **R2 F3 修复**：把 promise 存到模块级 gate，让首次升级流程能 await 等它
  // 跑完，避免"启动期清理与第一次升级 race 误清刚写入 cookies"的 race。
  void kickoffUpgradePartitionStartupClear()

  // W1.3 / A1-H3 / R2 F1+F2：旧版单文件 desktop-audit.jsonl 流式异步迁移到
  // 当前月份分片。fire-and-forget：失败不阻塞启动；首次 writeAuditLog 在
  // migration 还在跑时可以正常写当前月份分片（sentinel 文件隔离 + append
  // 模式天然安全）。
  void initDesktopAuditLogger()

  // W2.3：注入 DaemonStorageFetcher——把"主进程通过 cli-server-core HTTP
  // 调 daemon /storage/* 路由"封装好挂到 storage-manager。
  // - daemon 不在线时 listBuckets() 自动返回 []，其他操作抛 DaemonNotRunningError
  // - daemon 重启时 socket / token 变化也透明处理（每次请求重读 discovery）
  // - 同步调用：仅做模块级状态注入，不发任何 IO；失败不阻塞主进程启动。
  try {
    initDaemonStorageBridge()
  } catch (err) {
    // 防御式：模块级初始化理论上不应抛错；真抛了也只 warn 不阻断启动。
    log.warn('initDaemonStorageBridge 失败（降级不阻断启动）:', err)
  }

  // W2.2 G1：4 个 main 进程 business-app bucket 集中注册。
  // 都是显式调用而非"模块加载即注册"——后者依赖别处碰巧 import，lazy IPC
  // 重构后会有"启动顺序炸弹"风险（R3 视角的 #10 修复）。
  // 每个注册函数自己 try/catch 内部的 BucketAlreadyRegisteredError，
  // 外层再 try/catch 兜住任何同步异常，保证任一注册失败不影响其他注册或主进程启动。
  for (const [name, register] of [
    ['skills:preinstalled', registerSkillsPreinstalledBucket],
    ['marketplace:apps', registerMarketplaceAppsBucket],
    ['mcp:local-connections', registerMcpLocalConnectionsBucket],
    ['tin:sandboxes', registerTinSandboxBucket],
  ] as const) {
    try {
      register()
    } catch (err) {
      log.warn(`注册 bucket ${name} 失败（降级不阻断启动）:`, err)
    }
  }

  // W2.2 G3：把浏览器 partition / cache + 媒体 / 下载类本地存储登记到
  // storage-manager。所有 bucket 都走 lazy sizeFn（只在 UI 进 tab 时扫盘），
  // 启动期注册本身不读盘，失败不阻塞。
  //
  // renderer 端的 3 个 bucket（browser:bookmarks / browser:browsing-history /
  // oss:pending-confirms）在各自 store 模块顶部自注册，这里只登记 main
  // 进程 7 个 bucket。
  try {
    registerBrowserStorageBuckets()
  } catch (err) {
    log.warn('registerBrowserStorageBuckets 失败（降级不阻断启动）:', err)
  }
  try {
    registerMediaStorageBuckets()
  } catch (err) {
    log.warn('registerMediaStorageBuckets 失败（降级不阻断启动）:', err)
  }

  // W3.3 D-5：5 核心资产导出。Voice / Bookmarks / 草稿聚合 3 个 bucket
  // 在 renderer 进程注册（顶部副作用 import）；Checkpoint / 对话历史摘要
  // 这两个由主进程独立 bucket 暴露 exportFn——本块把它们登记到 storage-manager。
  // 顺序：本块必须早于 initStorageManagerIpc，否则首屏 listAllBuckets()
  // 拿不到这 2 个 bucket。
  for (const [name, register] of [
    ['checkpoint:summary-export', registerCheckpointSummaryExportBucket],
    ['conversation:summary-export', registerConversationSummaryExportBucket],
  ] as const) {
    try {
      register()
    } catch (err) {
      log.warn(`注册导出 bucket ${name} 失败（降级不阻断启动）:`, err)
    }
  }

  // W3.3 D-5 §6：把 storage-manager:save-export IPC 挂上——渲染端
  // exportToFile helper 拿到 ExportPayload 后调本 IPC 落到
  // ~/Downloads/TabTin/exports/。失败仅 warn 不阻塞启动。
  try {
    registerStorageExportFileWriter()
  } catch (err) {
    log.warn('registerStorageExportFileWriter 失败（降级不阻断启动）:', err)
  }

  // W3.1：把 storage-manager 注册中心通过 5 个 IPC 通道暴露给渲染进程，
  // 让"个人资料 → 存储管理"面板能通过 RendererStorageBridge 聚合
  // main / renderer / daemon 三方的 bucket。
  //
  // 必须在所有 bucket 注册之后挂——这样首屏 listAllBuckets() 拿到的是
  // 完整列表，不会出现 "进面板看到 8 个 bucket → 1 秒后又跳到 36 个"
  // 的渲染抖动。本调用是同步的，仅做 ipcMain.handle 注入，不做 IO。
  try {
    initStorageManagerIpc()
  } catch (err) {
    log.warn('initStorageManagerIpc 失败（降级不阻断启动）:', err)
  }

  try {
    registerPersonalPluginMarketplaceIpc()
  } catch (err) {
    log.warn('registerPersonalPluginMarketplaceIpc 失败（降级不阻断启动）:', err)
  }
}

export function initializeStartupServices(options: StartupServicesOptions): void {
  // W1.2 SSoT：越早越好地把 userData 路径注入到 storage-paths，让后续
  // 任何模块都能通过 `getUserDataPath()` 决议 Electron userData 下的路径，
  // 不用散落 `app.getPath('userData')`。app.whenReady() 已在此处 resolve。
  try {
    setUserDataOverride(app.getPath('userData'))
  } catch (err) {
    log.warn('setUserDataOverride 失败（降级不阻断启动）:', err)
  }

  // H1-E：越早越好地把 telemetry sink 挂上，让启动链路上任何位置的埋点都能
  // 落地到 electron-log。`ElectronAgentHost.start()` 晚于此处，其内部再次调用
  // `installElectronTelemetrySink()` 时因幂等不会重复注入。
  installElectronTelemetrySink()

  electronApp.setAppUserModelId(options.appUserModelId)
  const allowMainDevTools = shouldAllowMainDevTools({ isDev: options.isDev })
  setupApplicationMenu({ allowMainDevTools })
  setupBrowserWindowShortcuts(options.isDev, allowMainDevTools)
  installDisplayMediaHandlers({
    rendererUrl: options.rendererUrl,
    trustedOrigins: options.displayMediaTrustedOrigins,
    isDev: options.isDev,
    log: options.log,
  })
  // 须在 display-media 之后：defaultSession 的 openExternal 策略已折叠进
  // shouldGrantPermissionRequest；此处为 crawl partition 补装 handler。
  installExternalProtocolGuards()

  registerMainProcessIPCHandlers(options.ipcDependencies)
  registerCoreProcessHandlers()

  // Deferred IPC stub 注册：在窗口创建前同步占位所有 deferred channel，
  // 消除 "No handler registered for 'fs:readDir'" 类启动竞态。模块的真
  // 实加载仍然推迟到 deferred-services 阶段（或第一次调用触发）。
  registerDeferredIpcStubs()

  // PlatformSurface IPC 注册（Wave 3）：在 deferred stub 之后注册，
  // surface handler 通过 guardedHandle 享受 sender 校验 + trace stamp。
  registerSurfaceAsIpc(chatExportMd)

  // W6 批次 1：session 模块 4 个 surface，从 session/ipc.ts guardedHandle 迁入。
  // 工厂模式：传入 SessionManager 实例的操作接口，handler 闭包捕获依赖。
  const sm = getSessionManager()
  const sessionSurfaces = createSessionSurfaces({
    create: (config) => sm.createSession(config),
    get: (sid) => sm.getSession(sid),
    list: () => sm.listSessions(),
    delete: (sid) => sm.deleteSession(sid),
  })
  registerSurfaceAsIpc(sessionSurfaces.sessionCreate)
  registerSurfaceAsIpc(sessionSurfaces.sessionGet)
  registerSurfaceAsIpc(sessionSurfaces.sessionList)
  registerSurfaceAsIpc(sessionSurfaces.sessionDelete)

  notificationService.init({
    ensureMainWindow: options.ensureMainWindowForNotification,
  })

  log.info(`启动服务初始化完成 isDev=${options.isDev} allowMainDevTools=${allowMainDevTools}`)
}
