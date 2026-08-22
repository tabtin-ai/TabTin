/**
 * 渲染进程 Sentry 接入（，errors-only）
 *
 * 启用条件：构建期注入 `VITE_SENTRY_DSN`（dev 读根 .env，改后需重启 pnpm dev）。
 * 未配置时本模块所有导出都是廉价 no-op，不加载 SDK chunk。
 *
 * 职责：
 * 1. SDK 初始化（动态 import，不拖慢首屏）；事件经 @sentry/electron 的
 *    IPC 通道汇到主进程统一发送；
 * 2. context provider：订阅 auth / organization / space store，把契约 tags
 *    （organization_id / space_id / agent_id / client_install_id）与 user
 *    （仅内部 ID + 昵称）写进 Sentry scope——上报时自动附带，别处禁止散落 setTag；
 * 3. 与诊断包互认：环形记录最近 N 个 event_id，导出诊断包时进 meta.json。
 *
 * 字段契约（白名单 / 脱敏红线）：docs/agent/error-context-schema.md。
 * 面包屑红线：console 面包屑关闭（可能夹带对话/文档内容——内容性现场只进
 * 用户主动导出的诊断包）；dom（选择器）/ fetch（URL+状态码）/ history 保留。
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('Sentry')

const MAX_RECENT_EVENT_IDS = 10
const BUILD_TIME_APP_VERSION = import.meta.env.VITE_APP_VERSION || ''
const BUILD_TIME_GIT_SHA = import.meta.env.VITE_GIT_COMMIT || ''

const buildMetadataContext = {
  app_version: BUILD_TIME_APP_VERSION,
  build_number: BUILD_TIME_APP_VERSION,
  platform: 'desktop',
  ...(BUILD_TIME_GIT_SHA ? { git_sha: BUILD_TIME_GIT_SHA } : {}),
}

let enabled = false
let rendererSdk: SentryRendererModule | null = null
const recentEventIds: string[] = []

/** 诊断包互认：最近上报的 Sentry event_id（新在前）。未启用时为空数组。 */
export function getRecentSentryEventIds(): string[] {
  return [...recentEventIds]
}

export function isSentryEnabled(): boolean {
  return enabled
}

function rememberEventId(eventId: string | undefined): void {
  if (!eventId) return
  recentEventIds.unshift(eventId)
  if (recentEventIds.length > MAX_RECENT_EVENT_IDS) {
    recentEventIds.length = MAX_RECENT_EVENT_IDS
  }
}

export function captureRendererFatal(error: unknown, handledBy: string): void {
  if (!rendererSdk) return
  try {
    rendererSdk.withScope((scope) => {
      scope.setTag('error_category', 'RENDERER_CRASH')
      scope.setTag('error_code', 'REACT_ERROR_BOUNDARY')
      scope.setTag('severity', 'fatal')
      scope.setTag('handled_by', handledBy)
      scope.setTag('recoverability', 'degraded')
      scope.setFingerprint(['renderer-failure', 'RENDERER_CRASH', 'REACT_ERROR_BOUNDARY'])
      const eventId = rendererSdk!.captureException(error)
      rememberEventId(eventId)
    })
  } catch {
    // Observability must never interrupt error recovery.
  }
}

/** 防御式读字符串字段（store 类型演进不应弄坏错误上报，同 collectContext）。 */
function readStr(obj: unknown, key: string): string | null {
  if (obj && typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[key]
    if (typeof v === 'string' && v) return v
  }
  return null
}

type SentryRendererModule = typeof import('@sentry/electron/renderer')

function installContextProvider(Sentry: SentryRendererModule, clientInstallId: string): void {
  // 登录用户：只带内部 ID + 昵称（契约：绝不上报手机号/邮箱）
  void import('@/stores/useAuthStore').then(({ useAuthStore }) => {
    const applyUser = (state: unknown) => {
      const user = (state as { user?: unknown }).user
      const id = readStr(user, 'id')
      Sentry.setUser(id ? { id } : null)
    }
    applyUser(useAuthStore.getState())
    useAuthStore.subscribe(applyUser)
  }).catch((e) => log.warn('auth store 订阅失败', e))

  // space 取值复用诊断包同一回退逻辑（契约 B 表）：设置页/IM 会清空
  // selectedSpace，回退到列表选择与 spaces 缓存，避免这段时间的事件丢 space_id。
  // 动态 import 打破与 collectContext 的循环依赖（它静态引本模块的互认导出）。
  void Promise.all([import('@tabtin/app-shell'), import('./diagnostics/collectContext')])
    .then(([shell, { resolveDiagnosticsSpace, resolveDiagnosticsAgent }]) => {
      const { useOrganizationStore, useSpaceStore, useSpaceListStore } = shell
      const applyTabtinContext = () => {
        const organizationId = readStr(useOrganizationStore.getState().selectedOrganization, 'id')
        const space = resolveDiagnosticsSpace()
        const agent = resolveDiagnosticsAgent(space)
        Sentry.setContext('tabtin', {
          ...buildMetadataContext,
          client_install_id: clientInstallId,
          organization_id: organizationId,
          space_id: readStr(space, 'id'),
          agent_id: readStr(agent, 'id') ?? readStr(space, 'agent_id'),
        })
      }
      applyTabtinContext()
      useOrganizationStore.subscribe(applyTabtinContext)
      useSpaceStore.subscribe(applyTabtinContext)
      useSpaceListStore.subscribe(applyTabtinContext)
    })
    .catch((e) => log.warn('app-shell store 订阅失败', e))
}

/**
 * 初始化渲染进程 Sentry。在 bootstrap 里 errorReporter 之后调用；
 * 幂等、失败不影响启动。
 */
export async function initSentryRenderer(): Promise<void> {
  if (enabled) return
  const dsn = (import.meta.env.VITE_SENTRY_DSN || '').trim()
  if (!dsn) return

  try {
    const Sentry = await import('@sentry/electron/renderer')
    const { scrubSentryEvent } = await import('../../../shared/sentry-scrub')

    Sentry.init({
      // DSN / release / environment 由主进程 SDK 经 IPC 下发，这里不重复配置
      sendDefaultPii: false,
      // 面包屑红线：console 可能夹带对话/文档内容，关闭；其余默认集成保留
      integrations: (defaults) => [
        ...defaults.filter((integration) => integration.name !== 'Breadcrumbs'),
        Sentry.breadcrumbsIntegration({ console: false }),
      ],
      beforeSend: (event) => {
        rememberEventId(event.event_id)
        return scrubSentryEvent(event)
      },
    })

    // client_install_id：与诊断包 meta.json 的互认 join key。
    // 用 syncDeviceFingerprint（主进程磁盘指纹为准）而非 getOrCreateDeviceId：
    // 全新安装时 localStorage 还没同步，后者会自造一个与主进程不同的 ID，
    // 导致首个会话主/渲染两端 join key 对不上。
    const { syncDeviceFingerprint } = await import('@/utils/deviceId')
    const clientInstallId = await syncDeviceFingerprint()
    Sentry.setTag('source', 'client')
    Sentry.setTag('service', 'tabtin-client')
    Sentry.setTag('client_platform', 'desktop')
    Sentry.setTag('runtime', 'electron-renderer')
    Sentry.setContext('tabtin', {
      ...buildMetadataContext,
      client_install_id: clientInstallId,
    })

    installContextProvider(Sentry, clientInstallId)

    rendererSdk = Sentry
    enabled = true
    log.info('渲染进程错误上报已启用')
  } catch (error) {
    log.error('初始化失败（继续运行，不上报）', error)
  }
}
