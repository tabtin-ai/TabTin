import http from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCreateSurfaceHttpHandler,
  mockConsumeHandBackNotice,
  mockEvaluateElectronBrowserCLIPolicy,
  mockGetSurfaceByHttpPath,
  mockHandleBrowserRoute,
  mockIsUserControllingSession,
  mockRunWithBrowserPolicyPreapproval,
  mockSurfaceHandler,
} = vi.hoisted(() => ({
  mockCreateSurfaceHttpHandler: vi.fn(),
  mockConsumeHandBackNotice: vi.fn(),
  mockEvaluateElectronBrowserCLIPolicy: vi.fn(),
  mockGetSurfaceByHttpPath: vi.fn(),
  mockHandleBrowserRoute: vi.fn(),
  mockIsUserControllingSession: vi.fn(),
  mockRunWithBrowserPolicyPreapproval: vi.fn(),
  mockSurfaceHandler: vi.fn(),
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

vi.mock('../../browser-tab-lock/browserTabInputLock', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../browser-tab-lock/browserTabInputLock')
  >()
  return {
    ...actual,
    consumeHandBackNotice: mockConsumeHandBackNotice,
    isUserControllingSession: mockIsUserControllingSession,
  }
})

vi.mock('../browser-policy-middleware', () => ({
  BROWSER_CLI_APPROVAL_TIMEOUT_MS: 1_000,
  evaluateElectronBrowserCLIPolicy: mockEvaluateElectronBrowserCLIPolicy,
  runWithBrowserPolicyPreapproval: mockRunWithBrowserPolicyPreapproval,
}))

vi.mock('../routes/browser', () => ({
  handleBrowserRoute: mockHandleBrowserRoute,
}))

vi.mock('@tabtin/cli-server-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/cli-server-core')>()
  return {
    ...actual,
    createSurfaceHttpHandler: mockCreateSurfaceHttpHandler,
    getSurfaceByHttpPath: mockGetSurfaceByHttpPath,
  }
})

import {
  BROWSER_CLI_REQUEST_TIMEOUT_MS,
  dispatchBrowserRequest,
  ensureCLIServerReady,
  runBrowserRequestWithDeadline,
  startCLIServer,
  stopCLIServer,
} from '../cli-server'

const res = {} as http.ServerResponse
let sendJSON = vi.fn()

function createMockResponse() {
  const chunks: Buffer[] = []
  const response = {} as http.ServerResponse & { bodyText: () => string }
  response.statusCode = 200
  Object.defineProperty(response, 'writableEnded', {
    value: false,
    configurable: true,
  })
  response.destroyed = false
  response.writeHead = vi.fn((status: number) => {
    response.statusCode = status
    return response
  }) as any
  response.setHeader = vi.fn()
  response.end = vi.fn((chunk?: unknown) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    Object.defineProperty(response, 'writableEnded', { value: true, configurable: true })
    return response
  }) as any
  response.bodyText = () => Buffer.concat(chunks).toString('utf8')
  return response
}

function requestBrowserObserve(socketPath: string, token: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: '/browser/observe',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tabtin-session-id': 'session-1',
        'x-tabtin-token': token,
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
    req.write('{}')
    req.end()
  })
}

function dispatch(body: Record<string, unknown>) {
  return dispatchBrowserRequest({
    url: '/browser/observe',
    method: 'POST',
    body,
    res,
    sendJSON,
  })
}

describe('Browser CLI 用户控制 gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendJSON = vi.fn()
    mockIsUserControllingSession.mockReturnValue(false)
    mockConsumeHandBackNotice.mockReturnValue(false)
    mockGetSurfaceByHttpPath.mockReturnValue(null)
    mockCreateSurfaceHttpHandler.mockReturnValue(mockSurfaceHandler)
    mockEvaluateElectronBrowserCLIPolicy.mockResolvedValue({
      action: 'allow',
      preapprovedActionIds: [],
    })
    mockRunWithBrowserPolicyPreapproval.mockImplementation(
      async (_ids: string[], run: () => Promise<void>) => run(),
    )
    mockHandleBrowserRoute.mockImplementation(
      async (
        _url: string,
        _method: string,
        _body: unknown,
        targetRes: http.ServerResponse,
        routeSendJSON: typeof sendJSON,
      ) => {
        routeSendJSON(targetRes, 200, { ok: true, data: { title: 'current page' } })
      },
    )
  })

  it('/browser/* 顶层分发不会被 PlatformSurface 提前截获', async () => {
    mockIsUserControllingSession.mockReturnValue(true)
    mockGetSurfaceByHttpPath.mockReturnValue({ id: 'future-browser-surface' })
    mockSurfaceHandler.mockImplementation((_req: unknown, response: http.ServerResponse) => {
      response.statusCode = 418
      response.end(JSON.stringify({ ok: false, source: 'surface' }))
    })
    const socketPath = `/tmp/test-browser-control-surface-${Date.now()}.sock`
    const previousDevInstance = process.env.TABTIN_DEV_INSTANCE
    process.env.TABTIN_DEV_INSTANCE = 'task-3-surface-test'

    try {
      const info = startCLIServer({ socketPath })
      await ensureCLIServerReady()
      const result = await requestBrowserObserve(info.socketPath, info.token)

      expect(result).toMatchObject({
        status: 409,
        body: {
          ok: false,
          error: { code: 'BROWSER_TAB_USER_IN_CONTROL' },
        },
      })
      expect(mockSurfaceHandler).not.toHaveBeenCalled()
      expect(mockGetSurfaceByHttpPath).not.toHaveBeenCalled()
      expect(mockEvaluateElectronBrowserCLIPolicy).not.toHaveBeenCalled()
      expect(mockHandleBrowserRoute).not.toHaveBeenCalled()
    } finally {
      await stopCLIServer()
      if (previousDevInstance === undefined) {
        delete process.env.TABTIN_DEV_INSTANCE
      } else {
        process.env.TABTIN_DEV_INSTANCE = previousDevInstance
      }
    }
  })

  it('用户接管时在 policy 和 route 前返回不可重试的 409', async () => {
    mockIsUserControllingSession.mockReturnValue(true)

    await dispatch({ _thread_id: 'session-1' })

    expect(sendJSON).toHaveBeenCalledWith(
      res,
      409,
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'BROWSER_TAB_USER_IN_CONTROL',
          retryable: false,
          detail: { sessionId: 'session-1' },
        }),
      }),
    )
    expect(mockEvaluateElectronBrowserCLIPolicy).not.toHaveBeenCalled()
    expect(mockHandleBrowserRoute).not.toHaveBeenCalled()
  })

  it('交还后首个对象型成功响应携带一次 notice', async () => {
    mockConsumeHandBackNotice.mockReturnValueOnce(true).mockReturnValue(false)

    await dispatch({ _thread_id: 'session-1' })
    await dispatch({ _thread_id: 'session-1' })

    expect(sendJSON.mock.calls[0]?.[2]).toMatchObject({
      ok: true,
      data: {
        title: 'current page',
        _browser_control_notice: {
          code: 'BROWSER_CONTROL_RETURNED',
          message: '用户接管期间可能改变了页面状态；继续操作前先重新 observe 当前页面。',
        },
      },
    })
    expect(sendJSON.mock.calls[1]?.[2]?.data._browser_control_notice).toBeUndefined()
    expect(mockConsumeHandBackNotice).toHaveBeenCalledTimes(2)
  })

  it('数组 data 与错误响应不消费 notice，后续对象型成功响应仍可携带', async () => {
    mockConsumeHandBackNotice.mockReturnValue(true)
    mockHandleBrowserRoute
      .mockImplementationOnce(async (
        _url: string,
        _method: string,
        _body: unknown,
        targetRes: http.ServerResponse,
        routeSendJSON: typeof sendJSON,
      ) => {
        routeSendJSON(targetRes, 200, { ok: true, data: [] })
      })
      .mockImplementationOnce(async (
        _url: string,
        _method: string,
        _body: unknown,
        targetRes: http.ServerResponse,
        routeSendJSON: typeof sendJSON,
      ) => {
        routeSendJSON(targetRes, 409, {
          ok: false,
          error: { code: 'CONFLICT', message: 'conflict', retryable: false },
        })
      })

    await dispatch({ _thread_id: 'session-1' })
    await dispatch({ _thread_id: 'session-1' })
    expect(mockConsumeHandBackNotice).not.toHaveBeenCalled()

    await dispatch({ _thread_id: 'session-1' })
    expect(mockConsumeHandBackNotice).toHaveBeenCalledTimes(1)
    expect(sendJSON.mock.calls[2]?.[2]?.data._browser_control_notice.code).toBe(
      'BROWSER_CONTROL_RETURNED',
    )
  })

  it('/browser/act 超时后的迟到成功不消费 notice，下一次正常成功仍消费一次', async () => {
    vi.useFakeTimers()
    try {
      mockConsumeHandBackNotice.mockReturnValue(true)
      const deadlineRes = createMockResponse()
      let sendLateSuccess!: () => void
      let resolveRouteFinished!: () => void
      const routeFinished = new Promise<void>((resolve) => {
        resolveRouteFinished = resolve
      })
      mockHandleBrowserRoute.mockImplementationOnce(async (
        _url: string,
        _method: string,
        _body: unknown,
        targetRes: http.ServerResponse,
        routeSendJSON: typeof sendJSON,
      ) => {
        await new Promise<void>((resolve) => {
          sendLateSuccess = () => {
            routeSendJSON(targetRes, 200, { ok: true, data: { title: 'late page' } })
            resolve()
            resolveRouteFinished()
          }
        })
      })

      const deadlineRequest = runBrowserRequestWithDeadline(
        '/browser/act',
        deadlineRes,
        guardedSendJSON => dispatchBrowserRequest({
          url: '/browser/act',
          method: 'POST',
          body: { _thread_id: 'session-1' },
          res: deadlineRes,
          sendJSON: guardedSendJSON,
        }),
      )
      await vi.advanceTimersByTimeAsync(BROWSER_CLI_REQUEST_TIMEOUT_MS)
      await deadlineRequest
      expect(deadlineRes.statusCode).toBe(504)

      sendLateSuccess()
      await routeFinished
      expect(mockConsumeHandBackNotice).not.toHaveBeenCalled()

      mockHandleBrowserRoute.mockImplementationOnce(async (
        _url: string,
        _method: string,
        _body: unknown,
        targetRes: http.ServerResponse,
        routeSendJSON: typeof sendJSON,
      ) => {
        routeSendJSON(targetRes, 200, { ok: true, data: { title: 'fresh page' } })
      })
      sendJSON = vi.fn()
      await dispatch({ _thread_id: 'session-1' })

      expect(mockConsumeHandBackNotice).toHaveBeenCalledTimes(1)
      expect(sendJSON.mock.calls[0]?.[2]?.data._browser_control_notice.code).toBe(
        'BROWSER_CONTROL_RETURNED',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
