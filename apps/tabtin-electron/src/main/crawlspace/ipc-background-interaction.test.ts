import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => any>()
  return {
    handlers,
    createView: vi.fn(),
    resolveBrowserContainerMode: vi.fn(() => 'wcv'),
    registerView: vi.fn(),
  }
})

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
vi.mock('../utils/guarded-handle', () => ({
  guardedHandle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
    mocks.handlers.set(channel, handler)
  }),
  guardedOn: vi.fn(),
}))
vi.mock('../view-factory', () => ({ getViewFactory: () => ({ createView: mocks.createView }) }))
vi.mock('../view-factory/background-interaction', async () => {
  const actual = await vi.importActual<typeof import('../view-factory/background-interaction')>('../view-factory/background-interaction')
  return actual
})
vi.mock('../../shared/browser-container-mode', () => ({
  resolveBrowserContainerMode: mocks.resolveBrowserContainerMode,
}))
vi.mock('../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => ({ registerView: mocks.registerView }),
}))
vi.mock('../services/ResourceDetectionService', () => ({ getResourceDetectionService: vi.fn() }))
vi.mock('../services/ResourceHubService', () => ({ getResourceHubService: vi.fn() }))
vi.mock('../services/resourceRequestContext', () => ({ resolveResourceRequestSession: vi.fn() }))
vi.mock('../services/resource-actions', () => ({
  handleDownloadResource: vi.fn(),
  handleDownloadStream: vi.fn(),
  parseStreamCore: vi.fn(),
}))
vi.mock('../services/ResourceDownloadService', () => ({ getResourceDownloadService: vi.fn() }))
vi.mock('../services/MediaProbeService', () => ({ getMediaProbeService: vi.fn() }))
vi.mock('./renderer-view-meta-updates', () => ({ normalizeRendererViewMetaUpdates: vi.fn() }))
vi.mock('../blocked-preview-load', () => ({ guardDirectLoadURL: vi.fn() }))
vi.mock('../window-manager', () => ({ getMainWindow: vi.fn() }))
vi.mock('@tabtin/browser-core', () => ({
  AccessLevel: { L0: 'L0' },
  buildAntiDetectConfig: vi.fn(() => ({ kind: 'test' })),
}))
vi.mock('../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { registerCrawlspaceContextIpcHandlers } from './ipc'

const payloadWithRunId = {
  crawlspaceId: 'cs-1',
  viewId: 'view-1',
  url: 'https://example.com',
  title: 'Example',
  runId: 'run-1',
  kind: 'workspace-view' as const,
  profile: 'agent-workspace' as const,
  partition: 'persist:cs-1',
}

describe('crawlspace:createView background interaction', () => {
  beforeAll(() => {
    registerCrawlspaceContextIpcHandlers()
  })

  beforeEach(() => {
    mocks.createView.mockReset().mockResolvedValue(undefined)
    mocks.registerView.mockReset()
    mocks.resolveBrowserContainerMode.mockReturnValue('wcv')
  })

  it('WCV run view 将后台交互 bounds 和标记后的 metadata 传给真实 createView handler', async () => {
    const handler = mocks.handlers.get('crawlspace:createView')

    expect(handler).toBeTypeOf('function')
    await handler!({}, payloadWithRunId)

    expect(mocks.createView).toHaveBeenCalledWith(expect.objectContaining({
      bounds: { x: -10000, y: -10000, width: 1280, height: 720 },
      metadata: expect.objectContaining({
        crawlspaceId: 'cs-1',
        agentBackgroundInteractive: true,
      }),
    }))
  })

  it('WCV view 创建后登记到 crawlspace 上下文，供激活与 portal 显示使用', async () => {
    const handler = mocks.handlers.get('crawlspace:createView')

    await handler!({}, payloadWithRunId)

    expect(mocks.registerView).toHaveBeenCalledWith('cs-1', 'view-1', expect.objectContaining({
      title: 'Example',
      url: 'https://example.com',
      runId: 'run-1',
    }))
  })

  it('webview 模式不调用 ViewFactory createView', async () => {
    const handler = mocks.handlers.get('crawlspace:createView')
    mocks.resolveBrowserContainerMode.mockReturnValue('webview')

    await handler!({}, payloadWithRunId)

    expect(mocks.createView).not.toHaveBeenCalled()
  })
})
