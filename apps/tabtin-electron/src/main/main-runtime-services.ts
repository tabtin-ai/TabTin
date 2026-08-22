import type { BrowserWindow } from 'electron'
import os from 'os'
import { app } from 'electron'

import { ensureCLIServerReady, stopCLIServer } from './cli/cli-server'
import { API_BASE_URL } from './config/api.js'
import {
  disposeDeferredServices,
  initializeDeferredServices,
  rebindMainWindowServices,
  setDeferredServicesUpdateManager,
  type DeferredServiceHooks,
} from './deferred-services'
import { startupPerf, type StartupTimingData } from './logger'
import { getEventBridge } from './run-session/EventBridge'
import { UpdateManager } from './services/UpdateManager'
import { getDeviceFingerprint } from './utils/deviceFingerprint'
import { WsGatewayClient as MainWsGatewayClient } from './ws/WsGatewayClient'
import { joinApiPath } from '@tabtin/config'
import { reportCommunityDevReady } from './community-dev-readiness'

export interface MainRuntimeServicesLogger {
  info: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface MainRuntimeServicesController {
  getUpdateManager: () => UpdateManager | null
  handleMainWindowRegistered: (mainWindow: BrowserWindow) => void
  handleMainWindowDidFinishLoad: (mainWindow: BrowserWindow) => Promise<void>
  startBackgroundServices: (mainWindow: BrowserWindow) => void
  stop: () => void | Promise<void>
}

export interface MainRuntimeServicesControllerOptions extends DeferredServiceHooks {
  isDev: boolean
  log: MainRuntimeServicesLogger
  onMainWindowReady?: () => void
}

const PERF_REPORT_SAMPLE_RATE = Math.max(
  0,
  Math.min(1, parseFloat(process.env.TABTIN_PERF_REPORT_RATE || '0.1')),
) || 0.1

function reportStartupTiming(data: StartupTimingData): void {
  if (process.env.TABTIN_PERF_REPORT === '0') return
  if (Math.random() >= PERF_REPORT_SAMPLE_RATE) return

  const url = joinApiPath(API_BASE_URL, '/client-errors/report-anonymous')
  const body = JSON.stringify({
    events: [
      {
        error_type: 'startup-timing',
        message: `Startup completed in ${data.totalMs}ms`,
        stack_trace: '',
        level: 'info',
        source: 'main',
        file: '',
        line: null,
        column: null,
        breadcrumbs: [],
        app_version: app.getVersion(),
        electron_version: process.versions.electron || '',
        os_name: os.platform(),
        os_version: os.release(),
        arch: os.arch(),
        locale: app.getLocale?.() || '',
        extra: {
          device_id: getDeviceFingerprint(),
          startup_timestamps: data.timestamps,
          startup_total_ms: data.totalMs,
        },
        occurred_at: new Date().toISOString(),
      },
    ],
  })

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    // fire-and-forget：上报失败不影响应用
  })
}

export function createMainRuntimeServicesController(
  options: MainRuntimeServicesControllerOptions,
): MainRuntimeServicesController {
  let updateManager: UpdateManager | null = null
  let deferredServicesInitialized = false
  let deferredServicesInitPromise: Promise<void> | null = null

  if (!options.isDev) {
    startupPerf.onFlush(reportStartupTiming)
  }

  const initializeUpdateManager = (mainWindow: BrowserWindow): void => {
    const disableDevUpdater = process.env.TABTIN_DISABLE_DEV_UPDATER === 'true'
    if (options.isDev && disableDevUpdater) {
      return
    }

    updateManager = new UpdateManager({
      checkOnStartup: true,
      autoDownload: false,
      autoInstallOnAppQuit: true,
    })
    setDeferredServicesUpdateManager(updateManager)
    updateManager.setMainWindow(mainWindow)
    updateManager.startHttpPolling(24)

    const updateGateway = new MainWsGatewayClient({
      role: 'electron',
      capabilities: ['update'],
      subscribeTopics: [],
      deviceId: getDeviceFingerprint(),
    })
    updateManager.setWsClient(updateGateway)

    options.log.info('UpdateManager 已初始化（含 WS 客户端）')
  }

  const initializeEventBridge = (): void => {
    const bridge = getEventBridge()
    if (process.env.EVENT_BRIDGE_ENABLED === 'true') {
      bridge.enable()
    }
  }

  return {
    getUpdateManager: () => updateManager,
    handleMainWindowRegistered: (mainWindow) => {
      updateManager?.setMainWindow(mainWindow)
    },
    handleMainWindowDidFinishLoad: async (mainWindow) => {
      startupPerf.sinceStart('did-finish-load')
      options.log.info('页面加载完成')
      reportCommunityDevReady()

      if (!deferredServicesInitialized) {
        if (!deferredServicesInitPromise) {
          startupPerf.mark('延迟初始化总耗时')
          deferredServicesInitPromise = (async () => {
            try {
              await initializeDeferredServices(mainWindow, options)
              deferredServicesInitialized = true
              startupPerf.measure('延迟初始化总耗时')
              startupPerf.sinceStart('全部延迟初始化完成')
              startupPerf.flush()
            } catch (error) {
              options.log.error('延迟初始化异常:', error)
            } finally {
              deferredServicesInitPromise = null
            }
          })()
        }
        await deferredServicesInitPromise
      }

      if (deferredServicesInitialized) {
        rebindMainWindowServices(mainWindow)
      }

      options.onMainWindowReady?.()
    },
    startBackgroundServices: (mainWindow) => {
      void ensureCLIServerReady().then((cliServerInfo) => {
        options.log.info('CLI Server 已启动:', cliServerInfo.socketPath)
      }).catch((error) => {
        options.log.error('CLI Server 启动失败:', error)
      })

      initializeUpdateManager(mainWindow)
      initializeEventBridge()
    },
    stop: async () => {
      options.log.info('停止 CLI Server...')
      await stopCLIServer()
      await disposeDeferredServices()

      if (updateManager) {
        updateManager.destroy()
        updateManager = null
      }
      setDeferredServicesUpdateManager(null)
    },
  }
}
