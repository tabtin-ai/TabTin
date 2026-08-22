import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { guardedHandle } from './utils/guarded-handle'
import { setCapabilityDiscoveryService } from './capability-discovery-accessor'
import { startupPerf, createLogger } from './logger'
import { withStepTimeout, STEP_TIMEOUT_MS } from './deferred-utils'
import type { ActionRequiredEventData, ActionResultRequest } from '@tabtin/chat-client'
import type { FrontendActionBridge } from './services/FrontendActionBridge'
import { loadAppConfig } from '@tabtin/app-config'
import {
  buildTabDesktopExecutorConstructorOptions,
  resolveTabDesktopAppManifestRoot,
} from './services/desktop-app-config-bridge'

const mainLog = createLogger('Main')
const ipcLog = createLogger('MainIPC')

let frontendActionBridge: FrontendActionBridge | null = null
let electronAgentServiceRef: {
  start(): Promise<void>
  stop(): Promise<void>
  pauseTimers(): void
  resumeTimers(): void
  ensureConnected(): Promise<boolean>
  retryConnect(): Promise<boolean>
} | null = null

let electronAgentHostRef: {
  stop(): Promise<void>
  getCodeWorktreeController?(): import('@tabtin/cli-routes').CodeWorktreeController
  materializeAppSkill?(params: {
    organizationId: string
    /** @deprecated  本地落盘不再按 space */
    spaceId?: string
    userId?: string
    appId: string
    slug: string
  }): Promise<{ installed: number; skipped: number; errors: string[] }>
  /**  / ：刷新本机 ~/.agents/skills 扫描根 */
  addInteropRoot?(rootPath: string): Promise<void>
} | null = null

export function getElectronAgentServiceRef() {
  return electronAgentServiceRef
}

function hasAgentStreamTopic(topics: unknown[]): boolean {
  return topics.some(topic => (
    typeof topic === 'string'
    && (topic === 'agent.stream' || topic.startsWith('agent.stream.'))
  ))
}

export function isAgentStreamGatewaySubscribePayload(payload: {
  messageType?: string
  payload?: Record<string, unknown>
} | null | undefined): boolean {
  const messageType = payload?.messageType
  const body = payload?.payload
  const topics = Array.isArray((body as { topics?: unknown } | undefined)?.topics)
    ? (body as { topics: unknown[] }).topics
    : null
  return (
    (messageType === 'subscribe' || messageType === 'unsubscribe')
    && topics !== null
    && hasAgentStreamTopic(topics)
  )
}

export function rebindActionBridge(mainWindow: BrowserWindow): void {
  frontendActionBridge?.setMainWindow(mainWindow)
}

export async function initActionBridge(mainWindow: BrowserWindow): Promise<void> {
  const [
    { createFrontendActionBridge },
    { setCLIActionExecutor, setCLIViewGetter, setCLIDesktopExecutor, setCLIDesktopGuard },
    { getViewPageHandle },
    { CapabilityDiscoveryService },
    { electronAgentService },
    { DesktopExecutorService },
    DesktopUseGuard,
    { electronWsGateway },
  ] = await Promise.all([
    import('./services/FrontendActionBridge'),
    import('./cli/cli-server'),
    import('./embedded-crawl-view'),
    import('./services/CapabilityDiscoveryService'),
    import('./agent/ElectronAgentService'),
    import('./services/DesktopExecutorService'),
    import('./services/DesktopUseGuard'),
    import('./ws/ElectronWsGateway'),
  ])

  electronAgentServiceRef = electronAgentService

  // DesktopExecutorService: mainWindow getter avoids stale reference after window recreation。
  //
  // v2.1 模块零（规范 § 3.5.5 + § 9.1）· app.json → runtime plumbing 接通：
  // 通过 @tabtin/app-config loadAppConfig 读 packages/apps/tabdesktop/app.json
  // 的 configSchema 默认值（imageResize / pixelCompare），传入 Executor 构造
  // opts。这是 v1.8 § 10 Q11 登记的 "TabDesktop app.json 开关声明了不生效"
  // 债的偿还：改 app.json 重启 → runtime 行为真变。
  //
  // v2.2 模块零扫尾（独立验收 P0-1 + P1-1）：接通胶水提取到
  // services/desktop-app-config-bridge.ts，作为纯函数可被单元测试断言；
  // 显式传 manifestRoot（开发态 undefined → 自动推断；打包态走
  // process.resourcesPath/app.asar.unpacked），不再 silent fallback。
  const tabDesktopExecutorConfig = buildTabDesktopExecutorConstructorOptions(
    loadAppConfig,
    {
      manifestRoot: resolveTabDesktopAppManifestRoot({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
      diagnostics: {
        onExplicitMissing: ({ tried, appId }) => {
          mainLog.warn(
            `[TabDesktop plumbing] manifestRoot 不存在: ${tried} (appId=${appId})。` +
            `打包态 packages/apps 是否在 electron-builder asarUnpack 列表里？` +
            `本次将 fallback 到 hard-default，改 app.json 重启不会生效。`,
          )
        },
      },
    },
  )

  setCLIDesktopExecutor(new DesktopExecutorService(
    () => {
      try { return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null }
      catch { return null }
    },
    {
      onSessionTimeout: (sessionId) => {
        mainLog.info(`[IdleTimeout] Session ${sessionId} timed out, releasing guard`)
        DesktopUseGuard.release(sessionId).catch((err: unknown) =>
          mainLog.warn('[IdleTimeout] Guard release failed:', err),
        )
      },
      pixelCompareEnabled: tabDesktopExecutorConfig.pixelCompareEnabled,
      imageResize: tabDesktopExecutorConfig.imageResize,
    },
  ))
  setCLIDesktopGuard(DesktopUseGuard)

  const initFrontendActionBridgeStep = async () => {
    startupPerf.mark('Phase2:A1-FrontendActionBridge')
    mainLog.info('初始化 FrontendActionBridge 服务...')
    try {
      frontendActionBridge = createFrontendActionBridge(mainWindow)
      setCLIActionExecutor(async (action) => {
        if (!frontendActionBridge) throw new Error('FrontendActionBridge 未初始化')
        return frontendActionBridge.executeAction(action)
      })

      // : 用容器无关句柄——webview guest 条目 view=null，只给 getView 的话
      // CLI 的 resolveTabId/validateViewExists 会把 webview tab 一律当"不存在"。
      setCLIViewGetter((tabId: string) => getViewPageHandle(tabId))

      type ActionPayload = ActionRequiredEventData & { crawlTabId?: string }
      const executeActionHandler = async (action: ActionPayload): Promise<ActionResultRequest> => {
        const actionType = action.action || 'unknown'
        ipcLog.info('execute-action', actionType, 'task:', action.task_id)
        ipcLog.debug('execute-action params:', JSON.stringify(action, null, 2))

        if (!frontendActionBridge) {
          ipcLog.error('FrontendActionBridge 未初始化')
          return {
            success: false,
            error: 'FrontendActionBridge 未初始化',
          }
        }

        try {
          const result = await frontendActionBridge.executeAction(action)

          ipcLog.debug('execute-action result:', {
            success: result.success,
            contentLength: result.clean_html?.length || 0,
            title: result.title,
            url: result.url,
            keys: Object.keys(result),
          })

          return result
        } catch (error) {
          ipcLog.error('执行前端动作失败:', error)
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }

      const getRegisteredToolsHandler = () => {
        if (!frontendActionBridge) {
          return []
        }
        return frontendActionBridge.getRegisteredTools()
      }

      const hasToolForActionHandler = (_event: IpcMainInvokeEvent, actionType: string) => {
        if (!frontendActionBridge) {
          return false
        }
        if (!actionType) {
          return false
        }
        return frontendActionBridge.hasToolForAction(actionType)
      }

      guardedHandle('agent:execute-action', async (_event, action) => executeActionHandler(action))
      guardedHandle('agent:get-registered-tools', getRegisteredToolsHandler)
      guardedHandle('agent:has-tool-for-action', hasToolForActionHandler)
      guardedHandle('ws:agent-gateway-status-get', () => {
        return electronWsGateway.getStatus()
      })
      const agentStreamIpcOnlyResponse = () => ({
        ok: false,
        type: 'error',
        requestId: '',
        error: {
          code: 'AGENT_STREAM_IPC_ONLY',
          message: 'agent.stream topics are owned by the main agent-host IPC stream',
        },
      })
      guardedHandle('ws:agent-gateway-request', async (
        _event,
        payload: {
          messageType?: string
          payload?: Record<string, unknown>
          requestOptions?: Record<string, unknown>
        },
      ) => {
        ipcLog.info('Agent Gateway request', { messageType: payload?.messageType ?? '' })
        const messageType = payload?.messageType
        if (!messageType) {
          return {
            ok: false,
            type: 'error',
            requestId: '',
            error: { code: 'BAD_REQUEST', message: 'messageType is required' },
          }
        }
        if (isAgentStreamGatewaySubscribePayload(payload)) {
          return agentStreamIpcOnlyResponse()
        }
        return electronWsGateway.requestWithLastAuth(
          messageType,
          payload?.payload ?? {},
          payload?.requestOptions as never,
        )
      })
      guardedHandle('ws:agent-gateway-send', (
        _event,
        payload: {
          messageType?: string
          payload?: Record<string, unknown>
          requestOptions?: Record<string, unknown>
        },
      ) => {
        ipcLog.debug('Agent Gateway send', { messageType: payload?.messageType ?? '' })
        const messageType = payload?.messageType
        if (!messageType) {
          return { ok: false, error: { code: 'BAD_REQUEST', message: 'messageType is required' } }
        }
        if (isAgentStreamGatewaySubscribePayload(payload)) {
          return agentStreamIpcOnlyResponse()
        }
        return { ok: electronWsGateway.send(messageType, payload?.payload ?? {}, payload?.requestOptions as never) }
      })
      guardedHandle('ws:agent-gateway-subscribe', (_event, payload: { topics?: string[]; options?: { topicContexts?: Record<string, Record<string, unknown>> } }) => {
        const topics = Array.isArray(payload?.topics)
          ? payload.topics.filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
          : []
        ipcLog.info('Agent Gateway subscribe', { topicCount: topics.length })
        if (topics.length === 0) {
          return {
            ok: false,
            type: 'error',
            requestId: '',
            error: { code: 'BAD_REQUEST', message: 'topics are required' },
          }
        }
        if (hasAgentStreamTopic(topics)) {
          return agentStreamIpcOnlyResponse()
        }
        return electronWsGateway.subscribe(topics, payload?.options)
      })
      guardedHandle('ws:agent-gateway-unsubscribe', (_event, payload: { topics?: string[] }) => {
        const topics = Array.isArray(payload?.topics)
          ? payload.topics.filter((topic): topic is string => typeof topic === 'string' && topic.length > 0)
          : []
        ipcLog.info('Agent Gateway unsubscribe', { topicCount: topics.length })
        if (topics.length === 0) {
          return {
            ok: false,
            type: 'error',
            requestId: '',
            error: { code: 'BAD_REQUEST', message: 'topics are required' },
          }
        }
        if (hasAgentStreamTopic(topics)) {
          return agentStreamIpcOnlyResponse()
        }
        return electronWsGateway.unsubscribe(topics)
      })
      guardedHandle('ws:agent-gateway-reconnect', () => {
        ipcLog.info('Agent Gateway reconnect requested')
        return electronAgentService.retryConnect()
      })
      guardedHandle('ws:agent-gateway-organization-ids', () => {
        return electronWsGateway.getOrganizationIds()
      })
      setCapabilityDiscoveryService(new CapabilityDiscoveryService(
        () => frontendActionBridge?.getRegisteredTools() ?? [],
      ))

      mainLog.info('FrontendActionBridge 服务初始化成功')
    } catch (error) {
      mainLog.error('FrontendActionBridge 服务初始化失败:', error)
    }
    startupPerf.measure('Phase2:A1-FrontendActionBridge')
  }

  const initElectronAgentStep = async () => {
    startupPerf.mark('Phase2:A3-ElectronAgent')
    try {
      await electronAgentService.start()
    } catch (err) {
      mainLog.error('ElectronAgentService 启动失败:', err)
    }
    startupPerf.measure('Phase2:A3-ElectronAgent')
  }

  await Promise.allSettled([initFrontendActionBridgeStep(), initElectronAgentStep()])
}

/**
 * 独立于 initActionBridge 的本地 Agent Runtime 初始化。
 * 与 WS 连接装配（ElectronAgentService）解耦，让本地 Runtime 即使在 WS
 * 连接尚未就绪时也能独立启动。
 */
export async function initLocalAgentHost(): Promise<void> {
  try {
    mainLog.info('[LocalAgentHost] 开始动态导入 ElectronAgentHost...')
    const { electronAgentHost } = await import('./agent/ElectronAgentHost')
    mainLog.info('[LocalAgentHost] 导入成功，调用 start()...')
    electronAgentHostRef = electronAgentHost
    await electronAgentHost.start()
    // ：CLI skill enable 后物化 app skill
    // ：npm 装完后刷新 ~/.agents/skills 本机扫描
    const {
      setCLISkillsMaterializer,
      setCLISkillsInteropAdder,
      setCLICodeWorktreeController,
    } = await import('./cli/cli-server')
    setCLICodeWorktreeController(
      electronAgentHost.getCodeWorktreeController?.() ?? null,
    )
    setCLISkillsMaterializer(async (params) => {
      const host = electronAgentHostRef
      if (!host?.materializeAppSkill) {
        throw new Error('Skill registry 未初始化')
      }
      return host.materializeAppSkill(params)
    })
    setCLISkillsInteropAdder(async (rootPath) => {
      const host = electronAgentHostRef
      if (!host?.addInteropRoot) {
        throw new Error('Skill registry 未初始化')
      }
      await host.addInteropRoot(rootPath)
    })
    mainLog.info('[LocalAgentHost] IPC handlers 已注册')
  } catch (err) {
    mainLog.error('[LocalAgentHost] 启动失败:', err instanceof Error ? err.stack : err)
    throw err
  }
}

export async function disposeActionBridgeParallel(): Promise<void> {
  await Promise.allSettled([
    electronAgentServiceRef?.stop(),
    electronAgentHostRef?.stop(),
  ])
}

export async function disposeActionBridgeSerial(): Promise<void> {
  ipcMain.removeHandler('agent:execute-action')
  ipcMain.removeHandler('agent:get-registered-tools')
  ipcMain.removeHandler('agent:has-tool-for-action')
  ipcMain.removeHandler('ws:agent-gateway-status-get')
  ipcMain.removeHandler('ws:agent-gateway-request')
  ipcMain.removeHandler('ws:agent-gateway-send')
  ipcMain.removeHandler('ws:agent-gateway-subscribe')
  ipcMain.removeHandler('ws:agent-gateway-unsubscribe')
  ipcMain.removeHandler('ws:agent-gateway-reconnect')
  ipcMain.removeHandler('ws:agent-gateway-organization-ids')

  if (frontendActionBridge) {
    mainLog.info('清理 FrontendActionBridge 服务...')
    await withStepTimeout(
      () => frontendActionBridge!.destroy(),
      STEP_TIMEOUT_MS,
      'frontendActionBridge.destroy',
    )
    frontendActionBridge = null
  }
  setCapabilityDiscoveryService(null)
  const { setCLICodeWorktreeController } = await import('./cli/cli-server')
  setCLICodeWorktreeController(null)
  electronAgentServiceRef = null
  electronAgentHostRef = null
}
