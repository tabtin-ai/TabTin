import { fileURLToPath } from 'node:url'

import { is } from '@electron-toolkit/utils'
import { app, dialog, ipcMain } from 'electron'

import { createAppLifecycleController } from './app-lifecycle'
import { resolveRuntimeProfile } from './app-identity'
import { registerAppSettingsHandlers, syncAutoStartOnStartup } from './app-settings-ipc'
import { setAppBeforeRelaunch } from './agent/platform/app-relaunch-registry'
import { makeExitGuardRelaunchHook } from './agent/platform/exit-guard-relaunch-hook'
import { getActiveSubtaskCount } from './agent/subagents/proactive-poller'
import { electronAgentHost } from './agent/ElectronAgentHost'
import { getCapabilityDiscoveryService } from './capability-discovery-accessor'
import { createDeepLinkController } from './deep-link'
import { startDevParentWatchdog } from './dev-parent-watchdog'
import { createExitGuardController } from './exit-guard'
import { createLogger } from './logger'
import { configureMainProcess } from './main-process-config'
import { createMainRuntimeContext } from './main-runtime-context'
import { installMainProcessErrorHooks } from './main-process-errors'
import { captureClientError } from './sentry'
import { installPackagedAuditSmokeExit } from './packaged-audit-smoke'
import { initMainErrorReporter, reportMainError } from './services/mainErrorReporter'
import { createTrayController, type TrayController } from './tray'
import { shouldHideToTrayOnClose, shouldHideToTrayOnMinimize } from './tray-policy'
import { configService } from './services/ConfigService'
import { buildSystemUserAgent } from './utils/system-ua'
import { getMainWindow } from './window-manager'

/**
 * Dock / 托盘图标路径（ /  回归）。
 *
 * - 必须用 `import.meta.url`：主进程产物是 ESM `.mjs`，`?asset` 会编成
 *   `join(__dirname, …)`，安装包启动直接 ReferenceError。
 * - `static/icon*.png` 需打进 asar：见 package.json `build.files`；仅 `out/**`
 *   时相对路径在安装包里不存在。
 */
const iconFileName = resolveRuntimeProfile() === 'preprod' ? 'icon-preprod.png' : 'icon.png'
const icon = fileURLToPath(new URL(`../../static/${iconFileName}`, import.meta.url))

const mainLog = createLogger('Main')
const rendererVerbose = process.env.ELECTRON_VERBOSE === 'true'

initMainErrorReporter()

installMainProcessErrorHooks({
  log: mainLog,
  reportError: (error, source) => {
    reportMainError(error, {}, 'error')
    captureClientError(error, {
      handled_by: source,
      error_category: 'CLIENT_CRASH',
      error_code: source === 'main_uncaught_exception'
        ? 'MAIN_UNCAUGHT_EXCEPTION'
        : 'MAIN_UNHANDLED_REJECTION',
      severity: 'fatal',
      recoverability: 'unrecoverable',
    })
  },
})

ipcMain.on('observability:preload-fatal', (_event, payload: unknown) => {
  const code = payload && typeof payload === 'object' && 'code' in payload
    && typeof (payload as { code?: unknown }).code === 'string'
    ? (payload as { code: string }).code
    : 'PRELOAD_UNKNOWN_FATAL'
  captureClientError(new Error(`Preload initialization failed: ${code}`), {
    handled_by: 'preload_initialization_guard',
    error_category: code === 'PRELOAD_CONTEXT_BRIDGE_EXPOSURE_FAILED'
      ? 'IPC_FATAL'
      : 'STARTUP_FATAL',
    error_code: code,
    severity: 'fatal',
    recoverability: 'unrecoverable',
    runtime: 'electron-preload',
  })
})

if (!installPackagedAuditSmokeExit({ app, log: mainLog })) {
const deepLink = createDeepLinkController({
  log: mainLog,
  getMainWindow,
})

const SYSTEM_UA = buildSystemUserAgent()
const isDevRuntime = is.dev || !app.isPackaged

configureMainProcess({
  isDev: isDevRuntime,
  log: mainLog,
})

// Dev 模式 parent watchdog：electron-vite 父进程退出时（被 vite-plugin-checker
// 整死、Ctrl-C 没传到子进程、import 期 fatal 等），electron 子进程会变成孤儿继续
// 跑——renderer 一直 ERR_CONNECTION_REFUSED 白屏，⌘Q 又卡 exit-guard 30s。
// 探测到父进程消失立即 app.exit(0)，绕过 before-quit / exit-guard。
// prod 模式跳过——彼时 parent 是 Finder / launchctl，杀它不该退应用。
if (is.dev) {
  startDevParentWatchdog({ log: mainLog })
}

let appLifecycle: ReturnType<typeof createAppLifecycleController> | null = null

// W2.5 T9: 退出守卫——⌘Q / 关窗口前由 renderer 弹"合并 dirty 对话框"决定是否继续。
// 超时（默认 30s）= renderer 卡死，弹原生 fallback dialog 让用户最后决定。
// 在 createMainRuntimeContext 之前实例化，便于把 ask 回调透传给 main-window 的 close 钩子。
const exitGuard = createExitGuardController({
  log: mainLog,
  getMainWindow,
})

// Wave 1 第二轮：把 exit-guard 的"合并 dirty 对话框"复用给 relaunch_app
// 工具的 beforeRelaunch 钩子。Agent 调 relaunch_app（如用户授权 macOS Full
// Disk Access 后需要重启进程才生效）时，先弹"重启前确认未保存改动"对话框
// 让用户保存或取消，避免未保存改动被 app.relaunch() 直接吞掉。
//
// 时序安全：
//   - main-app.ts 在主进程启动早期就调 setAppBeforeRelaunch，hook 立即就位
//   - ElectronAgentHost.createRuntimeForSession 是惰性的——首次会话被请求时
//     才装配 ToolProvider，那时 hook 已注册。读取走 getAppBeforeRelaunch()
//
// reason 'app-relaunch'（M-3 修订）：让对话框文案显示"重启前确认未保存改动 ...
// 重启完成后 TabTin 会自动重新打开"——而不是"退出前确认"那种让用户怀疑"我
// 不是说让你重启吗，怎么变成退出了？"的认知断裂措辞。
//
// 拼装逻辑抽到 makeExitGuardRelaunchHook（exit-guard-relaunch-hook.ts）便于单测。
setAppBeforeRelaunch(makeExitGuardRelaunchHook(exitGuard))

// 桌面后台常驻：点 X 隐藏窗口、进程与后台服务照常运行。
// tray 需要 runtimeContext 的窗口重建能力，runtimeContext 需要 tray 的隐藏
// 回调——用 let + 闭包解环，onReady 里再真正创建托盘图标。
let trayController: TrayController | null = null

const runtimeContext = createMainRuntimeContext({
  icon,
  isDev: is.dev,
  rendererUrl: process.env['ELECTRON_RENDERER_URL'],
  rendererVerbose,
  displayMediaTrustedOrigins: process.env.TABTIN_DISPLAY_MEDIA_TRUSTED_ORIGINS
    ?.split(',')
    .map(item => item.trim())
    .filter(Boolean),
  log: mainLog,
  getMainWindow,
  getCapabilityDiscoveryService,
  isQuitting: () => appLifecycle?.isQuitting() ?? false,
  onMainWindowReady: () => {
    deepLink.flushPendingLinks()
  },
  onExitGuard: () => exitGuard.ask('window-close'),
  shouldHideToTray: () => shouldHideToTrayOnClose({
    platform: process.platform,
    settings: configService.get('settings'),
    isQuitting: appLifecycle?.isQuitting() ?? false,
  }),
  shouldHideToTrayOnMinimize: () => shouldHideToTrayOnMinimize({
    platform: process.platform,
    settings: configService.get('settings'),
  }),
  onHiddenToTray: () => trayController?.notifyHiddenToTray(),
})

// WinRT toast 协议激活与 Electron Notification click 共用 ensure 路径
deepLink.setEnsureMainWindow(() => runtimeContext.mainWindowRegistry.ensureForNotification())

trayController = createTrayController({
  icon,
  log: mainLog,
  restoreMainWindow: () => runtimeContext.mainWindowRegistry.restoreMainWindow(),
  recreateMainWindow: () => runtimeContext.lifecycleHandlers.onActivate(),
})

appLifecycle = createAppLifecycleController({
  isDev: is.dev,
  systemUserAgent: SYSTEM_UA,
  log: mainLog,
  onReady: async () => {
    registerAppSettingsHandlers({
      onMinimizeToTrayChanged: () => trayController?.syncFromSettings(),
    })
    await runtimeContext.lifecycleHandlers.onReady()
    trayController?.syncFromSettings()
    syncAutoStartOnStartup()
  },
  onSecondInstance: deepLink.handleSecondInstance,
  onActivate: runtimeContext.lifecycleHandlers.onActivate,
  onBeforeQuit: async () => {
    trayController?.destroy()
    await runtimeContext.lifecycleHandlers.onBeforeQuit()
  },
  isTrayResident: () => trayController?.isActive() ?? false,
  onWillQuit: () => {
    exitGuard.dispose()
    runtimeContext.lifecycleHandlers.onWillQuit()
  },
  onExitGuard: async () => {
    // PRD §11.3 + 终端假运行根治 v3 路线 A：Cmd+Q 退出时如有运行中任务 → 提示用户。
    //
    // 两类任务语义不同，文案必须拆分（治旧文案"继续在云端执行"对本地命令的误导）：
    //   - **本地后台 shell 命令**（ManagedTaskStore running）：路线 A = 退出即取消，
    //     退出后会被**停止**（杀整组 + flush 已终止终态）。
    //   - **云端子任务**（getActiveSubtaskCount）：跑在云端，退出后**继续执行**，
    //     重开可查看结果。
    try {
      const [cloudCount, localCount] = await Promise.all([
        getActiveSubtaskCount(),
        Promise.resolve(electronAgentHost.getRunningBackgroundTaskCount()),
      ])
      if (cloudCount > 0 || localCount > 0) {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          const lines: string[] = []
          if (localCount > 0) {
            lines.push(`有 ${localCount} 个本地后台命令正在运行，退出后它们将被停止。`)
          }
          if (cloudCount > 0) {
            lines.push(`有 ${cloudCount} 个云端子任务正在运行，退出后它们将继续在云端执行，重新打开时可查看结果。`)
          }
          const result = await dialog.showMessageBox(win, {
            type: 'info',
            title: '有任务正在运行',
            message: lines.join('\n'),
            buttons: ['取消', '仍然退出'],
            defaultId: 0,
            cancelId: 0,
          })
          if (result.response === 0) return 'cancel'
        }
      }
    } catch {
      // 任务检测失败不阻塞退出
    }
    return exitGuard.ask('app-quit')
  },
})

appLifecycle.start()
}
