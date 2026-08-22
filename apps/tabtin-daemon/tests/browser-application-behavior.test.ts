import { describe, expect, it, vi } from 'vitest'
import { DaemonBrowserApplication } from '../src/platform/browser/DaemonBrowserApplication.js'
import { loadRuntimeUrlForTab } from '../src/platform/browser/DaemonBrowserService.js'

function createApplication(browser: any = null) {
  const recordAction = vi.fn()
  const application = new DaemonBrowserApplication({
    resolveBrowser: () => browser,
    getSpaceId: () => null,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    getRecordingStatus: vi.fn(),
    loadRecording: vi.fn(),
    listRecordings: vi.fn(async () => []),
    recordAction,
  })
  return { application, recordAction }
}

describe('DaemonBrowserApplication behavior', () => {
  it('stale tab 加载保持结构化失败契约', async () => {
    const result = await loadRuntimeUrlForTab(
      () => { throw new Error('Tab stale-tab not found') },
      'stale-tab',
      'https://example.com',
    )

    expect(result).toMatchObject({
      success: false,
      status: 'error',
      finalUrl: 'https://example.com',
      error: 'Tab stale-tab not found',
      timing: {
        start: expect.any(Number),
        end: expect.any(Number),
        duration: expect.any(Number),
      },
    })
  })

  it('无 Chrome 时仍可查询上下文，浏览器命令返回结构化 503', async () => {
    const { application } = createApplication()

    const context = await application.execute('context', {})
    const tabs = await application.executePageCommand('page.tabs', {})

    expect(context).toMatchObject({ ok: true, status: 200 })
    expect(tabs).toMatchObject({
      ok: false,
      status: 503,
      error: { code: 'INTERNAL_ERROR', retryable: true },
    })
  })

  it.each([
    ['record.start', { runId: 'recording-1' }],
    ['record.stop', { runId: 'recording-1' }],
    ['record.status', { runId: 'recording-1' }],
    ['replay.list', {}],
  ])('无 Chrome 时 %s 返回结构化 503', async (actionId, body) => {
    const { application } = createApplication()

    const result = await application.execute(actionId, body)

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      error: { code: 'INTERNAL_ERROR' },
    })
  })

  it('无 Chrome 时 batch 顶层返回结构化 503', async () => {
    const { application } = createApplication()

    const result = await application.executeBatchCommand({
      actions: [{ type: 'context' }],
    })

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      error: { code: 'INTERNAL_ERROR', retryable: true },
    })
  })

  it('下载批处理拒绝非正整数并发数', async () => {
    const browser = {
      getWorkspaceRoot: () => '/tmp',
      getResourceTracker: () => ({ isEnabled: true, download: vi.fn() }),
    }
    const { application } = createApplication(browser)

    const result = await application.executeDownloadCommand('download.batch', {
      resourceIds: ['resource-1'],
      concurrency: 0,
    })

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: { code: 'VALIDATION_ERROR', message: 'concurrency 必须是正整数' },
    })
  })

  it('成功的页面动作通过 application 写入录制记录', async () => {
    const browser = {
      getActiveTabId: () => 'tab-1',
      waitForSelector: vi.fn(async () => ({ matched: true })),
    }
    const { application, recordAction } = createApplication(browser)

    const result = await application.executePageCommand('page.wait', {
      runId: 'recording-1',
      selector: '#ready',
    })

    expect(result).toMatchObject({ ok: true, status: 200 })
    expect(recordAction).toHaveBeenCalledWith('recording-1', expect.objectContaining({
      type: 'wait',
      selector: '#ready',
    }))
  })
})
