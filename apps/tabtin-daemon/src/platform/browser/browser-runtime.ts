import {
  cleanHtml,
  generateSkeletonHtml,
  setCrawlToolRunnerFactory,
} from '@tabtin/action-tools/headless'

import type { Logger } from '../observability/logging/logger.js'
import { DaemonBrowserService } from './DaemonBrowserService.js'
import { RecordingManager } from './RecordingSession.js'

let publishedBrowserRuntime: BrowserRuntime | null = null

function claimBrowserAdapters(owner: BrowserRuntime): void {
  if (publishedBrowserRuntime && publishedBrowserRuntime !== owner) {
    throw new Error('A BrowserRuntime is already published')
  }
  publishedBrowserRuntime = owner
}

function releaseBrowserAdapters(owner: BrowserRuntime): boolean {
  if (publishedBrowserRuntime !== owner) return false
  publishedBrowserRuntime = null
  setCrawlToolRunnerFactory(null)
  return true
}

export interface BrowserRuntimePorts {
  setMemoryProvider(provider: () => Promise<{
    jsHeapUsedSize: number
    jsHeapTotalSize: number
    pageCount: number
  } | null>): void
  sendEvent(eventType: string, payload: Record<string, unknown>): Promise<void>
}

/** Owns browser, tab/session, recording and compatibility-adapter lifecycles. */
export class BrowserRuntime {
  private service: DaemonBrowserService | null = null
  private recordingManager: RecordingManager | null = null

  constructor(
    private readonly logger: Logger,
    private readonly workspaceRoot: string,
    private readonly ports: BrowserRuntimePorts,
    private readonly createService: () => DaemonBrowserService = () => new DaemonBrowserService(logger),
    private readonly createRecordingManager: () => RecordingManager = () => new RecordingManager(),
  ) {}

  async start(): Promise<boolean> {
    if (this.service) return true
    const service = this.createService()
    if (!service.isAvailable()) {
      this.logger.warn('[BrowserRuntime] Chrome/Chromium is unavailable')
      return false
    }

    let recordingManager: RecordingManager | null = null
    try {
      service.setWorkspaceRoot(this.workspaceRoot)
      await service.injectRuntimeAPIs()
      await service.initBrowserCore()

      recordingManager = this.createRecordingManager()
      this.service = service
      this.recordingManager = recordingManager
      claimBrowserAdapters(this)
      this.installCrawlAdapter(service)
      this.installObservability(service)
      this.logger.info(`[BrowserRuntime] ready (chrome: ${service.getChromePath()})`)
      return true
    } catch (error) {
      this.service = null
      this.recordingManager = null
      releaseBrowserAdapters(this)
      await recordingManager?.dispose().catch((disposeError) => {
        this.logger.warn(`[BrowserRuntime] recording rollback failed: ${disposeError}`)
      })
      await service.dispose().catch((disposeError) => {
        this.logger.warn(`[BrowserRuntime] browser rollback failed: ${disposeError}`)
      })
      throw error
    }
  }

  isAvailable(): boolean {
    return this.service !== null
  }

  getService(): DaemonBrowserService | null {
    return this.service
  }

  useBrowser<T>(operation: (browser: DaemonBrowserService) => T): T {
    if (!this.service) throw new Error('BrowserRuntime 尚未初始化')
    return operation(this.service)
  }

  useBrowserIfReady<T>(operation: (browser: DaemonBrowserService) => T): T | undefined {
    return this.service ? operation(this.service) : undefined
  }

  async startRecording(runId: string, tabId?: string) {
    if (!this.recordingManager) throw new Error('BrowserRuntime 尚未初始化')
    return this.recordingManager.start(runId, { tabId })
  }

  async stopRecording(runId?: string) {
    if (!this.recordingManager) return null
    return runId ? this.recordingManager.stop(runId) : this.recordingManager.stopCurrent()
  }

  getRecordingStatus(runId?: string) {
    if (!this.recordingManager) return null
    return runId ? this.recordingManager.getStatus(runId) : null
  }

  async loadRecording(runId: string) {
    if (!this.recordingManager) return null
    return this.recordingManager.load(runId)
  }

  async listRecordings() {
    if (!this.recordingManager) throw new Error('BrowserRuntime 尚未初始化')
    return this.recordingManager.list()
  }

  recordAction(runId: string, action: import('./RecordingSession.js').RecordedAction): void {
    this.recordingManager?.record(runId, action)
  }

  async dispose(): Promise<void> {
    const service = this.service
    const recordingManager = this.recordingManager
    this.service = null
    this.recordingManager = null
    releaseBrowserAdapters(this)
    await recordingManager?.dispose().catch((error) => {
      this.logger.warn(`[BrowserRuntime] active recording flush failed: ${error}`)
    })
    await service?.dispose()
  }

  private installCrawlAdapter(service: DaemonBrowserService): void {
    setCrawlToolRunnerFactory(() => ({
      crawlCleanHtml: async ({ url }) => {
        try {
          const tabId = await service.openTab({ url })
          try {
            const content = await service.getPageContent(tabId)
            const cleaned = cleanHtml(content.html)
            return {
              success: true,
              clean_html: cleaned,
              skeleton_html: generateSkeletonHtml(cleaned),
              title: content.title,
              url: content.url,
              content_length: cleaned.length,
            }
          } finally {
            await service.closeTab(tabId).catch(() => {})
          }
        } catch (err) {
          this.logger.warn(`[BrowserRuntime] crawl failed: ${err instanceof Error ? err.message : String(err)}`)
          return {
            success: false,
            clean_html: '',
            title: '',
            url,
            content_length: 0,
          }
        }
      },
    }))
  }

  private installObservability(service: DaemonBrowserService): void {
    this.ports.setMemoryProvider(() => service.getBrowserMemoryUsage())
    service.on('browser:unavailable', (payload: Record<string, unknown>) => {
      this.logger.error('[BrowserRuntime] browser unavailable', payload)
      this.ports.sendEvent('device.browser_status', { available: false, ...payload }).catch(() => {})
    })
    service.on('page:crashed', (payload: Record<string, unknown>) => {
      this.logger.error('[BrowserRuntime] page crashed', payload)
      this.ports.sendEvent('device.page_crashed', payload).catch(() => {})
    })
  }
}
