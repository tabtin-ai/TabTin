import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { guardedOn } from './utils/guarded-handle'
import { startupPerf, createLogger } from './logger'
import { withStepTimeout, STEP_TIMEOUT_MS } from './deferred-utils'

const mainLog = createLogger('Main')

let tinManagerRef: import('./tins/tin-manager').TinManager | null = null
const pendingAgentRequests = new Map<
  string,
  {
    resolve: (value: string) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
let tinsAgentResponseHandler: ((_event: IpcMainEvent, requestId: string, result: { reply?: string; error?: string }) => void) | null = null

function cleanupPendingAgentRequests(): void {
  for (const [, pending] of pendingAgentRequests) {
    clearTimeout(pending.timer)
    pending.reject(new Error('App shutting down'))
  }
  pendingAgentRequests.clear()
}

export async function initTins(mainWindow: BrowserWindow): Promise<void> {
  mainLog.info('初始化 Tins 模块...')
  try {
    const [
      { initTinManager },
      { initTinBridge },
      crawlViewIntMod,
      { getCrawlViewEventManager },
      { getView: getEmbeddedView },
    ] = await Promise.all([
      import('./tins/tin-manager'),
      import('./tins/tin-bridge'),
      import('./tins/crawlview-integration'),
      import('./crawl-view-events'),
      import('./embedded-crawl-view'),
    ])

    const {
      initCrawlViewIntegration,
      connectCrawlViewEvents,
      getPageContent,
      getPageSelection,
    } = crawlViewIntMod

    const tinMgr = initTinManager(mainWindow)

    ipcMain.removeAllListeners('tins:agent-response')
    tinsAgentResponseHandler = (_event: IpcMainEvent, requestId: string, result: { reply?: string; error?: string }) => {
      const pending = pendingAgentRequests.get(requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingAgentRequests.delete(requestId)
      if (result.error) {
        pending.reject(new Error(result.error))
      } else {
        pending.resolve(result.reply || '')
      }
    }
    guardedOn('tins:agent-response', tinsAgentResponseHandler)

    initTinBridge({
      getPageContent,
      getPageSelection,
      invokeAgent: (instruction, organizationId) => {
        const requestId = randomUUID()
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (pendingAgentRequests.has(requestId)) {
              pendingAgentRequests.delete(requestId)
              reject(new Error('Agent request timed out'))
            }
          }, 120_000)
          pendingAgentRequests.set(requestId, { resolve, reject, timer })
          mainWindow.webContents.send('tins:agent-request', { requestId, instruction, organizationId })
        })
      },
    })
    initCrawlViewIntegration({ getView: getEmbeddedView })

    const eventManager = getCrawlViewEventManager()
    if (eventManager) {
      connectCrawlViewEvents(eventManager.addExternalListener.bind(eventManager))
    }

    tinManagerRef = tinMgr
    mainLog.info('Tins 模块初始化成功')
  } catch (error) {
    mainLog.error('Tins 模块初始化失败:', error)
  }
}

export function rebindTins(mainWindow: BrowserWindow): void {
  if (tinManagerRef) {
    try {
      tinManagerRef.setMainWindow?.(mainWindow)
      mainLog.info('Tins 模块已 rebind 到新窗口')
    } catch (err) {
      mainLog.warn('Tins rebind 失败（非致命）:', err)
    }
  }
}

export async function disposeTins(): Promise<void> {
  if (!tinManagerRef) return

  if (tinsAgentResponseHandler) {
    ipcMain.removeAllListeners('tins:agent-response')
    tinsAgentResponseHandler = null
  }
  cleanupPendingAgentRequests()

  await withStepTimeout(
    async () => {
      mainLog.info('清理 Tins 模块...')
      const [crawlViewMod, bridgeMod, managerMod] = await Promise.all([
        import('./tins/crawlview-integration'),
        import('./tins/tin-bridge'),
        import('./tins/tin-manager'),
      ])
      crawlViewMod.disposeCrawlViewIntegration()
      bridgeMod.disposeTinBridge()
      managerMod.disposeTinManagerSingleton()
      mainLog.info('Tins 模块清理完成')
    },
    STEP_TIMEOUT_MS,
    'Tins 模块清理',
  )
  tinManagerRef = null
}
