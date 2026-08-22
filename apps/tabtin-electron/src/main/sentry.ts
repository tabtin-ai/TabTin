/**
 * 主进程 Sentry 初始化（，errors-only）
 *
 * 启用条件：`VITE_SENTRY_DSN` 有值——dev 由根 .env 灌入 process.env，
 * 打包版本由 electron-vite 构建期静态替换 `import.meta.env.VITE_SENTRY_DSN`
 * （必须精确写这个表达式，见 mainErrorReporter 的同款说明）。不配置时
 * 不初始化，零开销。
 *
 * **必须同步初始化**（在 index.ts 模块体内直接调用，不能 fire-and-forget）：
 * 1. SDK 要求在 app 'ready' 前初始化（configureProtocol 在 ready 后直接 throw）；
 * 2. Electron 的 protocol.registerSchemesAsPrivileged 后调覆盖前调——SDK 注册
 *    sentry-ipc scheme 后会给该函数装 append 代理，保证之后 deep-link.ts 注册
 *    tabtin-file 时两个 scheme 共存；反过来（deep-link 先注册、SDK 后注册）
 *    tabtin-file 的特权会被抹掉。所以 Sentry 必须抢在 main-app 加载之前，
 *    而 dynamic import 与 'ready' 事件的先后在事件循环上没有保证。
 * SDK 用 createRequire 同步加载（@sentry/electron 被 externalizeDepsPlugin
 * 保留在 node_modules，有 CJS 入口）；DSN 未配置时不加载，保持零开销。
 *
 * 主/渲染是两个 SDK 实例：本模块只管主进程（native crash / 主进程未捕获
 * 异常）；渲染进程见 renderer/src/services/sentry.ts，其事件经 @sentry/electron
 * 的 IPC 通道汇到主进程统一发送。
 *
 * 字段契约（tags 白名单 / 脱敏红线）：docs/agent/error-context-schema.md。
 */

import { createRequire } from 'node:module'
import { app } from 'electron'
import { scrubSentryEvent } from '../shared/sentry-scrub'
import { resolveRuntimeProfile } from './app-identity'
import { getDeviceFingerprint } from './utils/deviceFingerprint'
import { linkDiagnosticSentryEvent, scheduleFatalDiagnostic } from './diagnostics/diagnostic-runtime'
import { resolveSentryEnvironment } from './sentry-environment'

const BUILD_TIME_DSN: string = import.meta.env.VITE_SENTRY_DSN || ''
const BUILD_TIME_GIT_SHA: string = import.meta.env.VITE_GIT_COMMIT || ''

const requireModule = createRequire(import.meta.url)

type SentryMain = typeof import('@sentry/electron/main')

let sdk: SentryMain | null = null

function buildMetadataContext(): Record<string, string> {
  return {
    app_version: app.getVersion(),
    build_number: app.getVersion(),
    platform: 'desktop',
    ...(BUILD_TIME_GIT_SHA ? { git_sha: BUILD_TIME_GIT_SHA } : {}),
  }
}

/** 供诊断/自检读取：主进程 Sentry 是否真正启用。 */
export function isSentryEnabled(): boolean {
  return sdk !== null
}

/**
 * 同步初始化主进程 Sentry。在 index.ts 里 loadRootEnvironment() 之后、
 * main-app import 之前直接调用（原因见模块头注释）。失败绝不阻塞启动。
 */
export function initSentryMain(): void {
  const dsn = (BUILD_TIME_DSN || process.env.VITE_SENTRY_DSN || '').trim()
  if (!dsn) return

  try {
    const Sentry = requireModule('@sentry/electron/main') as SentryMain
    Sentry.init({
      dsn,
      environment: resolveSentryEnvironment(resolveRuntimeProfile()),
      release: `tabtin-electron@${app.getVersion()}`,
      // errors-only：不采集性能事务
      tracesSampleRate: 0,
      sendDefaultPii: false,
      // These process hooks are classified manually below; keep one event per failure.
      integrations: (defaults) => defaults.filter((integration) =>
        integration.name !== 'OnUncaughtException'
        && integration.name !== 'OnUnhandledRejection'),
      beforeSend: (event) => scrubSentryEvent(event),
    })

    Sentry.setTag('source', 'client')
    Sentry.setTag('service', 'tabtin-client')
    Sentry.setTag('client_platform', 'desktop')
    Sentry.setTag('runtime', 'electron-main')
    Sentry.setContext('tabtin', {
      ...buildMetadataContext(),
      client_install_id: getDeviceFingerprint(),
    })

    sdk = Sentry
    console.info('[Sentry] 主进程错误上报已启用')
  } catch (error) {
    console.error('[Sentry] 主进程初始化失败（继续启动，不上报）:', error)
  }
}

/** run 上下文 tags（键名以 error-context-schema.md 白名单为准）。 */
export interface RunErrorContext {
  handled_by: string
  error_category: 'AGENT_RUN_FATAL' | 'AGENT_DOOM_LOOP' | 'AGENT_PROTOCOL_FATAL'
  error_code: string
  run_id?: string
  session_id?: string
  agent_id?: string
  organization_id?: string
  workspace_id?: string
  space_id?: string
  task_id?: string
}

export interface ClientErrorContext {
  handled_by: string
  error_category:
    | 'CLIENT_CRASH'
    | 'RENDERER_CRASH'
    | 'STARTUP_FATAL'
    | 'IPC_FATAL'
    | 'NETWORK_FATAL'
    | 'GPU_CRASH'
    | 'HANG'
  error_code: string
  severity: 'actionable' | 'fatal' | 'crash'
  recoverability: 'recovered' | 'degraded' | 'unrecoverable' | 'unknown'
  runtime?: 'electron-main' | 'electron-renderer' | 'electron-preload'
}

/** Capture an actionable desktop failure without putting high-cardinality IDs in tags. */
export function captureClientError(error: unknown, context: ClientErrorContext): void {
  const diagnosticBundleId = context.severity === 'fatal' || context.severity === 'crash'
    ? scheduleFatalDiagnostic({
      severity: context.severity,
      errorCategory: context.error_category,
      errorCode: context.error_code,
      handledBy: context.handled_by,
      clientInstallId: getDeviceFingerprint(),
    })
    : undefined
  if (!sdk) return
  try {
    sdk.withScope((scope) => {
      scope.setTag('source', 'client')
      scope.setTag('service', 'tabtin-client')
      scope.setTag('client_platform', 'desktop')
      scope.setTag('runtime', context.runtime ?? 'electron-main')
      scope.setTag('handled_by', context.handled_by)
      scope.setTag('error_category', context.error_category)
      scope.setTag('error_code', context.error_code)
      scope.setTag('severity', context.severity)
      scope.setTag('recoverability', context.recoverability)
      scope.setContext('tabtin', {
        ...buildMetadataContext(),
        client_install_id: getDeviceFingerprint(),
        diagnostic_bundle_id: diagnosticBundleId,
      })
      scope.setFingerprint([
        'client-failure',
        context.error_category,
        context.error_code,
      ])
      const eventId = sdk!.captureException(error)
      if (diagnosticBundleId) void linkDiagnosticSentryEvent(diagnosticBundleId, eventId)
    })
  } catch {
    // Observability must never interrupt the product flow.
  }
}

/**
 * Run 级致命错误收口上报：runtime 外层 catch rethrow 的
 * AgentError 被 ElectronAgentHost 的 catch 接住后属于 handled exception，
 * uncaughtException 集成抓不到，必须在此显式上报。未启用时 no-op。
 *
 * tags 走 withScope 逐事件设置——不能用全局 setTag（并发 session 互相污染）。
 */
export function captureRunError(error: unknown, context: RunErrorContext): void {
  const diagnosticBundleId = scheduleFatalDiagnostic({
    severity: 'fatal',
    errorCategory: context.error_category,
    errorCode: context.error_code,
    handledBy: context.handled_by,
    organizationId: context.organization_id,
    clientInstallId: getDeviceFingerprint(),
  })
  if (!sdk) return
  try {
    sdk.withScope((scope) => {
      scope.setTag('source', 'client')
      scope.setTag('service', 'tabtin-client')
      scope.setTag('client_platform', 'desktop')
      scope.setTag('runtime', 'electron-main')
      scope.setTag('handled_by', context.handled_by)
      scope.setTag('error_category', context.error_category)
      scope.setTag('error_code', context.error_code)
      scope.setTag('severity', 'fatal')
      scope.setContext('tabtin', {
        ...buildMetadataContext(),
        client_install_id: getDeviceFingerprint(),
        organization_id: context.organization_id,
        workspace_id: context.workspace_id,
        space_id: context.space_id,
        agent_id: context.agent_id,
        session_id: context.session_id,
        run_id: context.run_id,
        task_id: context.task_id,
        diagnostic_bundle_id: diagnosticBundleId,
      })
      scope.setFingerprint([
        'agent-run',
        context.error_category,
        context.error_code,
      ])
      const eventId = sdk!.captureException(error)
      void linkDiagnosticSentryEvent(diagnosticBundleId, eventId)
    })
  } catch {
    // 上报失败不影响主流程
  }
}
