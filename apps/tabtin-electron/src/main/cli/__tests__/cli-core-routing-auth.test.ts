import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PERMISSION_TIMEOUTS } from '@tabtin/agent-wire'

const mocks = vi.hoisted(() => {
  const makeRoute = (name: string) =>
    vi.fn(async (url: string, _method: string, _body: unknown, res: http.ServerResponse, sendJSON: (res: http.ServerResponse, status: number, data: any) => void) => {
      sendJSON(res, 200, { ok: true, data: { handler: name, url } })
    })

  return {
    table: makeRoute('table'),
    space: makeRoute('space'),
    browser: makeRoute('browser'),
    fetch: makeRoute('fetch'),
    slide: makeRoute('slide'),
    media: makeRoute('media'),
    video: makeRoute('video'),
    shutdownVideoTasks: vi.fn(),
    tabsite: makeRoute('tabsite'),
    extensions: makeRoute('extensions'),
    code: makeRoute('code'),
    oss: makeRoute('oss'),
    desktop: makeRoute('desktop'),
    terminal: makeRoute('terminal'),
    device: makeRoute('device'),
    capabilities: makeRoute('capabilities'),
    agent: makeRoute('agent'),
    skills: makeRoute('skills'),
    speech: makeRoute('speech'),
    search: makeRoute('search'),
    requestApproval: vi.fn(),
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/app'),
    isPackaged: false,
  },
}))

vi.mock('../../auth', () => ({
  TokenManager: {
    getAccessToken: vi.fn(async () => null),
    getUserInfo: vi.fn(async () => null),
    refreshAccessTokenShared: vi.fn(async () => null),
  },
}))

// 仍在 electron 本地实现的路由——`../routes/<name>` 路径有效。
vi.mock('../routes/browser', () => ({ handleBrowserRoute: mocks.browser }))
vi.mock('../routes/slide', () => ({ handleSlideRoute: mocks.slide }))
vi.mock('../routes/media', () => ({ handleMediaRoute: mocks.media }))
vi.mock('../routes/video', () => ({
  handleVideoRoute: mocks.video,
  shutdownVideoTasks: mocks.shutdownVideoTasks,
}))
vi.mock('../routes/tabsite', () => ({ handleTabsiteRoute: mocks.tabsite }))
vi.mock('../routes/desktop', () => ({ handleDesktopRoute: mocks.desktop }))
vi.mock('../routes/terminal', () => ({ handleTerminalRoute: mocks.terminal }))
vi.mock('../routes/device', () => ({ handleDeviceRoute: mocks.device }))
vi.mock('../routes/agent', () => ({ handleAgentRoute: mocks.agent }))
vi.mock('../routes/skills', () => ({ handleSkillsRoute: mocks.skills }))
vi.mock('../routes/speech', () => ({ handleSpeechRoute: mocks.speech }))
vi.mock('../../services/ApprovalManager', () => ({
  requestApproval: mocks.requestApproval,
}))

// PlatformSurface 重构（2026-05）后，table / space / fetch / extensions / code /
// oss / capabilities / search 路由已迁移到 @tabtin/cli-routes 共享包。原本散落
// 在 `../routes/<name>` 的 mock 路径已 stale，统一改成 mock cli-routes 入口。
vi.mock('@tabtin/cli-routes', () => ({
  // configureCLIRoutes 在 cli-server.ts 顶层调用注入 djangoRequest / getSpaceId
  // 等 bindings；测试用 noop 即可。
  configureCLIRoutes: vi.fn(),
  handleTableRoute: mocks.table,
  handleSpaceRoute: mocks.space,
  handleFetchRoute: mocks.fetch,
  handleExtensionsRoute: mocks.extensions,
  handleCodeRoute: mocks.code,
  handleOSSRoute: mocks.oss,
  handleCapabilitiesRoute: mocks.capabilities,
  handleSearchRoute: mocks.search,
}))

type ServerApi = typeof import('../cli-server')

let cliServer: ServerApi
const originalRuntimeRoot = process.env.TABTIN_RUNTIME_ROOT
const testRuntimeRoot = join(tmpdir(), `tabtin-cli-server-test-${process.pid}`)

type RequestOptions = {
  method?: string
  path: string
  token?: string | null
  body?: string
  headers?: Record<string, string>
}

async function makeRequest(options: RequestOptions) {
  cliServer.startCLIServer()
  const info = await cliServer.ensureCLIServerReady()
  return await new Promise<{
    status: number
    headers: http.IncomingHttpHeaders
    rawBody: string
    json: any
  }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: info.socketPath,
        path: options.path,
        method: options.method ?? 'GET',
        agent: false,
        headers: {
          ...(options.token === null ? {} : { 'x-tabtin-token': options.token ?? info.token }),
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.body ? { 'content-length': String(Buffer.byteLength(options.body)) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        let rawBody = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          rawBody += chunk
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawBody,
            json: rawBody ? JSON.parse(rawBody) : null,
          })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe('CB-17: CLI 核心路由认证与错误处理', () => {
  beforeEach(async () => {
    process.env.TABTIN_RUNTIME_ROOT = testRuntimeRoot
    vi.resetModules()
    Object.values(mocks).forEach((mockFn) => mockFn.mockClear())
    mocks.requestApproval.mockResolvedValue({ approved: true })
    cliServer = await import('../cli-server')
  })

  afterEach(async () => {
    await cliServer.stopCLIServer()
  })

  afterAll(() => {
    if (originalRuntimeRoot === undefined) delete process.env.TABTIN_RUNTIME_ROOT
    else process.env.TABTIN_RUNTIME_ROOT = originalRuntimeRoot
  })

  it('/health 走免鉴权分支并返回标准 okResponse', async () => {
    const res = await makeRequest({ path: '/health', token: null })

    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      ok: true,
      data: { status: 'ok', version: '1.0.0-test' },
    })
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('/dev/token 走免鉴权分支并暴露调试 token', async () => {
    const res = await makeRequest({ path: '/dev/token', token: null })

    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.data.token).toEqual(expect.any(String))
  })

  it('缺少 x-tabtin-token 时返回结构化 401', async () => {
    const res = await makeRequest({ path: '/table/list', token: null })

    expect(res.status).toBe(401)
    expect(res.json).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('未授权'),
      },
    })
  })

  it('错误 token 被拒绝，正确 token 才会进入路由 handler', async () => {
    const wrong = await makeRequest({ path: '/table/list', token: 'wrong-token' })
    expect(wrong.status).toBe(401)
    expect(mocks.table).not.toHaveBeenCalled()

    const right = await makeRequest({ path: '/table/list' })
    expect(right.status).toBe(200)
    expect(right.json).toMatchObject({
      ok: true,
      data: { handler: 'table', url: '/table/list' },
    })
    expect(mocks.table).toHaveBeenCalledTimes(1)
  })

  it('未知路径返回 cli-server-core 的 UNKNOWN_ROUTE', async () => {
    const res = await makeRequest({ path: '/unknown/path' })

    expect(res.status).toBe(404)
    expect(res.json).toMatchObject({
      ok: false,
      error: {
        code: 'UNKNOWN_ROUTE',
        message: expect.stringContaining('/unknown/path'),
      },
    })
  })

  it('JSON 解析失败时返回 VALIDATION_ERROR', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/space/create',
      body: '{"broken":',
    })

    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('JSON'),
      },
    })
    expect(mocks.space).not.toHaveBeenCalled()
  })

  it('/browser/session/* 仍由 browser route 处理', async () => {
    const res = await makeRequest({ path: '/browser/session/list' })

    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      ok: true,
      data: { handler: 'browser', url: '/browser/session/list' },
    })
    expect(mocks.browser).toHaveBeenCalledTimes(1)
  })

  it('/browser/tabs 命中 browser route 而不是其他 route', async () => {
    const res = await makeRequest({ path: '/browser/tabs' })

    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      ok: true,
      data: { handler: 'browser', url: '/browser/tabs' },
    })
    expect(mocks.browser).toHaveBeenCalledTimes(1)
  })

  it('Electron browser CLI middleware 在 route 前阻断高危脚本', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/browser/eval',
      body: JSON.stringify({ expression: 'document.cookie' }),
    })

    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({
      ok: false,
      error: { code: 'POLICY_BLOCKED' },
    })
    expect(mocks.requestApproval).not.toHaveBeenCalled()
    expect(mocks.browser).not.toHaveBeenCalled()
  })

  it('Electron browser CLI middleware 确认通过后才进入 route', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/browser/cookies',
      headers: { 'x-tabtin-session-id': 'chat-session-cookie-test' },
      body: JSON.stringify({ action: 'set', cookies: [{ name: 'a', value: 'b', url: 'https://example.com' }] }),
    })

    expect(res.status).toBe(200)
    expect(mocks.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'browser.cookies.set',
    }))
    expect(mocks.browser).toHaveBeenCalledTimes(1)
  })

  it('POST /browser/act 审批通过后进入 browser route，且使用统一 HITL 超时', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/browser/act',
      headers: { 'x-tabtin-session-id': 'chat-session-act-test' },
      body: JSON.stringify({ actions: [{ type: 'click', selector: 'a' }] }),
    })

    expect(res.status).toBe(200)
    expect(mocks.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'browser.act',
      detail: 'act: click',
      timeoutMs: PERMISSION_TIMEOUTS.FINAL_MS,
    }))
    expect(mocks.browser).toHaveBeenCalledTimes(1)
  })

  it('browser 审批从 CLI Agent 上下文头补 threadId，移动端可收到镜像审批', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/browser/act',
      headers: { 'x-tabtin-session-id': 'chat-session-header-thread' },
      body: JSON.stringify({ actions: [{ type: 'click', selector: 'a' }] }),
    })

    expect(res.status).toBe(200)
    expect(mocks.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'browser.act',
    }))
    expect(mocks.requestApproval.mock.calls.at(-1)?.[0]).not.toHaveProperty('threadId')
    expect(mocks.browser).toHaveBeenCalledTimes(1)
    expect(mocks.browser).toHaveBeenCalledWith(
      '/browser/act',
      'POST',
      expect.objectContaining({ _thread_id: 'chat-session-header-thread' }),
      expect.anything(),
      expect.any(Function),
    )
  })

  it('browser 审批只信任 Agent 上下文头，忽略 body 中的 threadId', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/browser/act',
      headers: {
        'x-tabtin-session-id': 'chat-session-header-thread',
        'x-tabtin-agent-run-id': 'agent-run-header',
      },
      body: JSON.stringify({
        _thread_id: 'chat-session-body-thread',
        runId: 'agent-run-body',
        actions: [{ type: 'click', selector: 'a' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(mocks.requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'browser.act',
    }))
    expect(mocks.requestApproval.mock.calls.at(-1)?.[0]).not.toHaveProperty('threadId')
    expect(mocks.browser).toHaveBeenCalledWith(
      '/browser/act',
      'POST',
      expect.objectContaining({
        _thread_id: 'chat-session-header-thread',
        runId: 'agent-run-header',
      }),
      expect.anything(),
      expect.any(Function),
    )
  })

  it('POST /browser/act 审批拒绝时返回明确错误，不悬挂也不进入 route', async () => {
    mocks.requestApproval.mockResolvedValueOnce({ approved: false })

    const res = await makeRequest({
      method: 'POST',
      path: '/browser/act',
      headers: { 'x-tabtin-session-id': 'chat-session-act-deny' },
      body: JSON.stringify({ actions: [{ type: 'click', selector: 'a' }] }),
    })

    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({
      ok: false,
      error: {
        code: 'APPROVAL_DENIED',
        detail: { actionType: 'act' },
      },
    })
    expect(mocks.browser).not.toHaveBeenCalled()
  })

  it('Electron browser CLI middleware 确认拒绝时不进入 route', async () => {
    mocks.requestApproval.mockResolvedValueOnce({ approved: false })

    const res = await makeRequest({
      method: 'POST',
      path: '/browser/cookies',
      headers: { 'x-tabtin-session-id': 'chat-session-cookie-deny' },
      body: JSON.stringify({ action: 'clear' }),
    })

    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({
      ok: false,
      error: { code: 'APPROVAL_DENIED' },
    })
    expect(mocks.browser).not.toHaveBeenCalled()
  })

  it('Electron browser batch 子动作不能绕过 policy block', async () => {
    const res = await makeRequest({
      method: 'POST',
      path: '/browser/batch',
      body: JSON.stringify({
        actions: [
          { type: 'eval', expression: 'document.cookie' },
          { type: 'cookies', action: 'clear' },
        ],
      }),
    })

    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({
      ok: false,
      error: { code: 'POLICY_BLOCKED' },
    })
    expect(mocks.requestApproval).not.toHaveBeenCalled()
    expect(mocks.browser).not.toHaveBeenCalled()
  })

  it('stopCLIServer 会调用 video 清理钩子', async () => {
    await cliServer.startCLIServer()
    await cliServer.stopCLIServer()

    expect(mocks.shutdownVideoTasks).toHaveBeenCalledTimes(1)
  })

  it('旧 Server 异步关闭不能清理同进程新 Server 的 socket', async () => {
    await cliServer.startCLIServer()

    const stoppingOldServer = cliServer.stopCLIServer()
    const newServer = cliServer.startCLIServer()
    await stoppingOldServer

    const res = await makeRequest({ path: '/health', token: null })
    expect(res.status).toBe(200)
    expect(cliServer.getCLIServerInfo()?.socketPath).toBe(newServer.socketPath)
  })

  it.runIf(process.platform !== 'win32')('socket 文件丢失后会在下一次检查时重建 CLI Server', async () => {
    const socketPath = join(tmpdir(), `tabtin-cli-recovery-${process.pid}-${Date.now()}.sock`)
    cliServer.startCLIServer({ socketPath })
    expect((await makeRequest({ path: '/health', token: null })).status).toBe(200)

    unlinkSync(socketPath)

    expect(cliServer.getCLIServerInfo()).toBeNull()
    const [recovered, concurrentRecovery] = await Promise.all([
      cliServer.ensureCLIServerReady(),
      cliServer.ensureCLIServerReady(),
    ])
    expect(recovered.socketPath).toBe(socketPath)
    expect(concurrentRecovery).toEqual(recovered)
    expect((await makeRequest({ path: '/health', token: null })).status).toBe(200)
  })

  it.runIf(process.platform !== 'win32')('跨代 Server 使用不同路径时会清理旧 socket', async () => {
    const suffix = `${process.pid}-${Date.now()}`
    const oldSocketPath = join(tmpdir(), `tabtin-cli-old-${suffix}.sock`)
    const newSocketPath = join(tmpdir(), `tabtin-cli-new-${suffix}.sock`)
    cliServer.startCLIServer({ socketPath: oldSocketPath })
    await cliServer.ensureCLIServerReady()

    const stoppingOldServer = cliServer.stopCLIServer()
    cliServer.startCLIServer({ socketPath: newSocketPath })
    await Promise.all([stoppingOldServer, cliServer.ensureCLIServerReady()])

    expect(existsSync(oldSocketPath)).toBe(false)
    expect(existsSync(newSocketPath)).toBe(true)
  })
})
