import http from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCrawlspaceContextHub,
  mockEvaluateElectronBrowserCLIPolicy,
  mockExecutor,
  mockRunWithBrowserPolicyPreapproval,
  mockViewFactory,
} = vi.hoisted(() => ({
  mockCrawlspaceContextHub: {
    getAllSnapshots: vi.fn(() => []),
    getSnapshot: vi.fn(() => ({
      activeViewId: 'view-1',
      views: [{ viewId: 'view-1', isClosing: false }],
    })),
  },
  mockEvaluateElectronBrowserCLIPolicy: vi.fn(),
  mockExecutor: vi.fn(),
  mockRunWithBrowserPolicyPreapproval: vi.fn(),
  mockViewFactory: {
    getViewState: vi.fn(() => null),
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/app'),
    isPackaged: false,
  },
  Notification: {
    isSupported: vi.fn(() => false),
  },
}))

vi.mock('../browser-policy-middleware', () => ({
  BROWSER_CLI_APPROVAL_TIMEOUT_MS: 1_000,
  evaluateElectronBrowserCLIPolicy: mockEvaluateElectronBrowserCLIPolicy,
  extractBrowserApprovalThreadId: vi.fn(() => undefined),
  getBrowserApprovalThreadId: vi.fn(() => undefined),
  isBrowserPolicyPreapproved: vi.fn(() => true),
  runWithBrowserApprovalContext: vi.fn(
    async (_body: unknown, run: () => Promise<unknown>) => run(),
  ),
  runWithBrowserPolicyPreapproval: mockRunWithBrowserPolicyPreapproval,
}))

vi.mock('../../crawlspace/CrawlspaceContextHub', () => ({
  getCrawlspaceContextHub: () => mockCrawlspaceContextHub,
}))

vi.mock('../../view-factory/ViewFactory', () => ({
  getViewFactory: () => mockViewFactory,
}))

import {
  ensureCLIServerReady,
  setCLIActionExecutor,
  setCLIViewGetter,
  startCLIServer,
  stopCLIServer,
} from '../cli-server'
import {
  getBrowserTabControlSnapshot,
  handBackToAgent,
  lock,
  resetBrowserTabInputLockForTests,
  takeOverByUser,
} from '../../browser-tab-lock/browserTabInputLock'
import {
  clearBrowserNavigationEvidenceForTests,
  recordBrowserNavigationEvidenceFromHrefs,
} from '../routes/browser/navigation-evidence'
import { getEventPersistence } from '../../run-session/EventPersistence'
import {
  getSharedBrowserJobManager,
  resetSharedBrowserJobManager,
} from '@tabtin/browser-core'

type BrowserRequestCase = {
  name: string
  path: string
  body: Record<string, unknown>
}

const CONTROLLED_VIEW_REQUESTS: BrowserRequestCase[] = [
  {
    name: 'act',
    path: '/browser/act',
    body: {
      tabId: 'view-1',
      actions: [{ type: 'click', selector: '#submit' }],
      observe: false,
    },
  },
  {
    name: 'run',
    path: '/browser/run/start',
    body: { tabId: 'view-1', name: 'lease-regression' },
  },
  {
    name: 'tab nav',
    path: '/browser/nav',
    body: { tabId: 'view-1', direction: 'reload' },
  },
  {
    name: 'open explicit tab',
    path: '/browser/open',
    body: {
      tabId: 'view-1',
      url: 'https://example.com/next',
      observe: false,
      skipNavigationEvidenceCheck: true,
    },
  },
  {
    name: 'open live-anchor verification',
    path: '/browser/open',
    body: {
      tabId: 'view-1',
      url: 'https://example.com/verified-link',
      crawlspaceId: 'crawlspace-1',
      observe: false,
    },
  },
  {
    name: 'print',
    path: '/browser/print',
    body: {
      tabId: 'view-1',
      save: '/tmp/browser-view-lease-print.md',
    },
  },
]

const REPLAY_EFFECTIVE_TARGET_CASES = [
  {
    name: 'TAB_SWITCHED 缺失 event.viewId',
    type: 'TAB_SWITCHED',
    sourceViewId: undefined,
  },
  {
    name: 'TAB_SWITCHED source 安全但 data.tabId 受控',
    type: 'TAB_SWITCHED',
    sourceViewId: 'view-safe',
  },
  {
    name: 'TAB_CLOSED 缺失 event.viewId',
    type: 'TAB_CLOSED',
    sourceViewId: undefined,
  },
  {
    name: 'TAB_CLOSED source 安全但 data.tabId 受控',
    type: 'TAB_CLOSED',
    sourceViewId: 'view-safe',
  },
] as const

function replayEffectiveTargetEvent(
  type: 'TAB_SWITCHED' | 'TAB_CLOSED',
  sourceViewId: string | undefined,
  runId: string,
) {
  return {
    id: 1,
    runId,
    ...(sourceViewId ? { viewId: sourceViewId } : {}),
    type,
    timestamp: 1,
    data: { tabId: 'view-1' },
  }
}

let serverInfo: { socketPath: string; token: string }
let previousDevInstance: string | undefined

function requestBrowser(
  path: string,
  body: Record<string, unknown>,
  sessionId = 'session-2',
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: serverInfo.socketPath,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tabtin-session-id': sessionId,
        'x-tabtin-token': serverInfo.token,
        ...(typeof body.runId === 'string'
          ? { 'x-tabtin-agent-run-id': body.runId }
          : {}),
      },
    }, (response) => {
      let raw = ''
      response.on('data', chunk => { raw += chunk.toString() })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(raw),
        })
      })
    })
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

describe('Browser view 用户控制独占租约', () => {
  beforeAll(async () => {
    previousDevInstance = process.env.TABTIN_DEV_INSTANCE
    process.env.TABTIN_DEV_INSTANCE = 'browser-view-lease-test'
    setCLIActionExecutor(mockExecutor)
    setCLIViewGetter(() => ({
      webContents: { isDestroyed: () => false },
    }))
    serverInfo = startCLIServer({
      socketPath: `/tmp/test-browser-view-lease-${Date.now()}.sock`,
    })
    await ensureCLIServerReady()
  })

  afterAll(async () => {
    await stopCLIServer()
    resetBrowserTabInputLockForTests()
    if (previousDevInstance === undefined) {
      delete process.env.TABTIN_DEV_INSTANCE
    } else {
      process.env.TABTIN_DEV_INSTANCE = previousDevInstance
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetBrowserTabInputLockForTests()
    resetSharedBrowserJobManager()
    clearBrowserNavigationEvidenceForTests()
    recordBrowserNavigationEvidenceFromHrefs(
      'https://example.com/',
      ['https://example.com/known-link'],
    )
    mockEvaluateElectronBrowserCLIPolicy.mockResolvedValue({
      action: 'allow',
      preapprovedActionIds: [],
    })
    mockRunWithBrowserPolicyPreapproval.mockImplementation(
      async (_ids: string[], run: () => Promise<void>) => run(),
    )
    mockExecutor.mockResolvedValue({ success: true, data: { status: 'ok' } })
    lock('view-1', 'session-1')
    takeOverByUser('view-1')
  })

  it.each(CONTROLLED_VIEW_REQUESTS)(
    '后来 session 对用户控制 view 的 $name 返回稳定 409 且不执行页面动作',
    async ({ path, body }) => {
      const before = getBrowserTabControlSnapshot()

      const response = await requestBrowser(path, body)

      expect(response).toMatchObject({
        status: 409,
        body: {
          ok: false,
          error: {
            code: 'BROWSER_TAB_USER_IN_CONTROL',
            retryable: false,
            detail: { viewId: 'view-1' },
          },
        },
      })
      expect(mockExecutor).not.toHaveBeenCalled()
      expect(getBrowserTabControlSnapshot()).toEqual(before)
      expect(before).toEqual({
        lockedViewIds: [],
        userControlledViewIds: ['view-1'],
        sessionIdsByViewId: { 'view-1': ['session-1'] },
      })
    },
  )

  it('交还后后来 session 的后续页面请求自然继续', async () => {
    handBackToAgent('view-1')

    const response = await requestBrowser('/browser/nav', {
      tabId: 'view-1',
      direction: 'reload',
    })

    expect(response.status).toBe(200)
    expect(mockExecutor).toHaveBeenCalledTimes(1)
  })

  it('print 页面读取后进入 captcha 投影时仍透传 view 租约 409', async () => {
    resetBrowserTabInputLockForTests()
    lock('view-1', 'session-2')
    mockExecutor.mockImplementationOnce(async () => {
      takeOverByUser('view-1')
      return {
        success: true,
        data: {
          result: JSON.stringify({
            html: '<html><body>captured</body></html>',
            title: 'Captured',
            url: 'https://example.com/',
          }),
        },
      }
    })

    const response = await requestBrowser('/browser/print', {
      tabId: 'view-1',
      save: '/tmp/browser-view-lease-print-captcha.md',
    })

    expect(response).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'BROWSER_TAB_USER_IN_CONTROL',
          retryable: false,
          detail: { viewId: 'view-1' },
        },
      },
    })
    expect(mockExecutor).toHaveBeenCalledTimes(1)
  })

  it('batch 子动作命中用户控制时返回 409，并无条件停止后续动作', async () => {
    const before = getBrowserTabControlSnapshot()

    const response = await requestBrowser('/browser/batch', {
      tabId: 'view-1',
      stopOnError: false,
      actions: [
        {
          type: 'nav',
          direction: 'reload',
          _thread_id: 'spoofed-direct',
          params: { _thread_id: 'spoofed-params' },
        },
        { type: 'random-ua' },
      ],
    })

    expect(response).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'BROWSER_TAB_USER_IN_CONTROL',
          retryable: false,
          detail: { viewId: 'view-1' },
        },
      },
    })
    expect(mockExecutor).not.toHaveBeenCalled()
    expect(getBrowserTabControlSnapshot()).toEqual(before)
  })

  it('batch 以父请求可信 session scope 覆盖 nested action 自带值', async () => {
    resetBrowserTabInputLockForTests()

    const response = await requestBrowser('/browser/batch', {
      tabId: 'view-1',
      actions: [{
        type: 'act',
        actions: [{ type: 'click', selector: '#submit' }],
        observe: false,
        _thread_id: 'spoofed-direct',
        params: { _thread_id: 'spoofed-params' },
      }],
    })

    expect(response.status).toBe(200)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-2'] },
    })
  })

  it('普通 batch 子动作失败仍保持 200 聚合 envelope 与 stopOnError 语义', async () => {
    resetBrowserTabInputLockForTests()
    mockExecutor.mockResolvedValueOnce({
      success: false,
      error: 'first action failed',
    })

    const response = await requestBrowser('/browser/batch', {
      actions: [
        { type: 'random-ua' },
        { type: 'random-ua' },
      ],
    })

    expect(response).toMatchObject({
      status: 200,
      body: {
        ok: false,
        data: {
          executed: 1,
          total: 2,
          results: [{
            type: 'random-ua',
            ok: false,
          }],
        },
      },
    })
    expect(mockExecutor).toHaveBeenCalledTimes(1)
  })

  it('同步 replay 的 event 命中用户控制时由 Browser route 映射 409', async () => {
    const events = vi.spyOn(getEventPersistence(), 'getEvents').mockReturnValue([{
      id: 1,
      runId: 'run-controlled',
      viewId: 'view-1',
      type: 'execute_act',
      timestamp: 1,
      data: { actions: [{ type: 'click', selector: '#submit' }] },
    }])

    try {
      const response = await requestBrowser('/browser/replay/run', {
        runId: 'run-controlled',
        tabId: 'view-safe',
        stopOnError: false,
      })
      expect(response).toMatchObject({
        status: 409,
        body: {
          ok: false,
          error: {
            code: 'BROWSER_TAB_USER_IN_CONTROL',
            retryable: false,
            detail: { viewId: 'view-1' },
          },
        },
      })
      expect(mockExecutor).not.toHaveBeenCalled()
    } finally {
      events.mockRestore()
    }
  })

  it('异步 replay job 以结构化租约 code 失败且不继续 event', async () => {
    const events = vi.spyOn(getEventPersistence(), 'getEvents').mockReturnValue([
      {
        id: 1,
        runId: 'run-controlled-async',
        viewId: 'view-1',
        type: 'execute_act',
        timestamp: 1,
        data: { actions: [{ type: 'click', selector: '#submit' }] },
      },
      {
        id: 2,
        runId: 'run-controlled-async',
        viewId: 'view-safe',
        type: 'execute_act',
        timestamp: 2,
        data: { actions: [{ type: 'click', selector: '#later' }] },
      },
    ])

    try {
      const response = await requestBrowser('/browser/replay/run', {
        runId: 'run-controlled-async',
        tabId: 'view-safe',
        async: true,
      })
      expect(response.status).toBe(202)
      const jobId = response.body?.data?.jobId
      expect(jobId).toEqual(expect.any(String))

      await vi.waitFor(() => {
        expect(getSharedBrowserJobManager().get(jobId)).toMatchObject({
          status: 'failed',
          error: {
            code: 'BROWSER_TAB_USER_IN_CONTROL',
            retryable: false,
            detail: { viewId: 'view-1' },
          },
        })
      })
      expect(mockExecutor).not.toHaveBeenCalled()
    } finally {
      events.mockRestore()
    }
  })

  it.each(REPLAY_EFFECTIVE_TARGET_CASES)(
    '同步 replay：$name 时按实际 tabId 返回稳定 409',
    async ({ type, sourceViewId }) => {
      const runId = `run-${type}-${sourceViewId ?? 'missing'}-sync`
      const events = vi.spyOn(getEventPersistence(), 'getEvents').mockReturnValue([
        replayEffectiveTargetEvent(type, sourceViewId, runId),
      ])

      try {
        const response = await requestBrowser('/browser/replay/run', {
          runId,
          tabId: 'view-safe',
          stopOnError: false,
        })

        expect(response).toMatchObject({
          status: 409,
          body: {
            ok: false,
            error: {
              code: 'BROWSER_TAB_USER_IN_CONTROL',
              retryable: false,
              detail: { viewId: 'view-1' },
            },
          },
        })
        expect(mockExecutor).not.toHaveBeenCalled()
      } finally {
        events.mockRestore()
      }
    },
  )

  it.each(REPLAY_EFFECTIVE_TARGET_CASES)(
    '异步 replay：$name 时 job 以结构化租约 code 失败',
    async ({ type, sourceViewId }) => {
      const runId = `run-${type}-${sourceViewId ?? 'missing'}-async`
      const events = vi.spyOn(getEventPersistence(), 'getEvents').mockReturnValue([
        replayEffectiveTargetEvent(type, sourceViewId, runId),
      ])

      try {
        const response = await requestBrowser('/browser/replay/run', {
          runId,
          tabId: 'view-safe',
          async: true,
        })
        expect(response.status).toBe(202)
        const jobId = response.body?.data?.jobId
        expect(jobId).toEqual(expect.any(String))

        await vi.waitFor(() => {
          expect(getSharedBrowserJobManager().get(jobId)).toMatchObject({
            status: 'failed',
            error: {
              code: 'BROWSER_TAB_USER_IN_CONTROL',
              retryable: false,
              detail: { viewId: 'view-1' },
            },
          })
        })
        expect(mockExecutor).not.toHaveBeenCalled()
      } finally {
        events.mockRestore()
      }
    },
  )
})
