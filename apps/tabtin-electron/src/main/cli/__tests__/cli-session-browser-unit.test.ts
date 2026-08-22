import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'

type SessionRecord = {
  sessionName: string
  crawlspaceId: string
  partition: string
}

const state = vi.hoisted(() => {
  const sessionsBySpace = new Map<string, SessionRecord[]>()
  let currentSpaceId: string | null = 'space-1'
  let currentExecutor: ((task: any) => Promise<any>) | null = null
  let currentBridge: ((action: string, payload: any) => Promise<any>) | null = null

  const bridge = vi.fn(async (action: string, payload: any) => {
    const spaceId = payload?.spaceId
    const sessions = sessionsBySpace.get(spaceId) ?? []

    if (action === 'list_sessions') {
      return { success: true, data: { sessions: [...sessions] } }
    }

    if (action === 'create_session_crawlspace') {
      // fixture 与生产对齐（BR-29 起）：实际 `tabsSlice.ensureNamedCrawlspace`
      // → `createWorkspace` 现在为命名 session 生成**独立隔离 partition**
      // （`tabtin:session:{crawlspaceId}` 前缀），不再落回 Space env partition，
      // 以隔离真实登录态 Cookie。这里用 `tabtin:session:cs-{name}` 复刻该形态。
      const created = {
        sessionName: payload.sessionName,
        crawlspaceId: `cs-${payload.sessionName}`,
        partition: `tabtin:session:cs-${payload.sessionName}`,
      }
      sessionsBySpace.set(spaceId, [...sessions, created])
      return { success: true, data: created }
    }

    if (action === 'purge_session') {
      const next = sessions.filter((item) => item.sessionName !== payload.sessionName)
      if (next.length === sessions.length) {
        return { success: false, error: `Session "${payload.sessionName}" 不存在` }
      }
      sessionsBySpace.set(spaceId, next)
      return { success: true }
    }

    throw new Error(`unexpected bridge action: ${action}`)
  })

  const executor = vi.fn(async (task: any) => {
    if (task.task_id.includes('save')) {
      return {
        data: {
          cookies: 'sid=1',
          localStorage: { theme: 'dark' },
          sessionStorage: { draft: '1' },
          url: 'https://example.com',
        },
      }
    }
    return { data: { loaded: true } }
  })

  return {
    sessionsBySpace,
    bridge,
    executor,
    getCurrentBridge: () => currentBridge,
    setCurrentBridge: (value: ((action: string, payload: any) => Promise<any>) | null) => {
      currentBridge = value
    },
    getCurrentSpaceId: () => currentSpaceId,
    setCurrentSpaceId: (value: string | null) => {
      currentSpaceId = value
    },
    getCurrentExecutor: () => currentExecutor,
    setCurrentExecutor: (value: ((task: any) => Promise<any>) | null) => {
      currentExecutor = value
    },
  }
})

vi.mock('../../logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}))

vi.mock('../../auth', () => ({
  TokenManager: {
    getAccessToken: vi.fn(async () => null),
    getUserInfo: vi.fn(async () => null),
    refreshAccessTokenShared: vi.fn(async () => null),
  },
}))

vi.mock('../cli-context', () => ({
  getCLIContextSpaceBridge: vi.fn(() => state.getCurrentBridge()),
  getCLISpaceId: vi.fn(() => state.getCurrentSpaceId()),
  getCLIActionExecutor: vi.fn(() => state.getCurrentExecutor()),
}))

function createResponseCapture() {
  const calls: Array<{ status: number; data: any }> = []
  const sendJSON = (_res: ServerResponse, status: number, data: any) => {
    calls.push({ status, data })
  }
  return { res: {} as ServerResponse, sendJSON, calls }
}

describe('CB-17: Session 路由全路径', () => {
  beforeEach(() => {
    vi.resetModules()
    state.sessionsBySpace.clear()
    state.bridge.mockClear()
    state.executor.mockClear()
    state.setCurrentBridge(state.bridge)
    state.setCurrentSpaceId('space-1')
    state.setCurrentExecutor(state.executor)
  })

  it('/list 返回空 sessions 列表', async () => {
    const mod = await import('../routes/session')
    const ctx = createResponseCapture()
    await mod.handleSessionRoute('/browser/session/list', 'GET', undefined, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toEqual({
      status: 200,
      data: { ok: true, data: { sessions: [], active: null } },
    })
  })

  it('/create 首个 session 自动成为 active，后续 create 不会抢占', async () => {
    const mod = await import('../routes/session')
    const ctx = createResponseCapture()

    await mod.handleSessionRoute('/browser/session/create', 'POST', { name: 'alpha' }, ctx.res, ctx.sendJSON)
    await mod.handleSessionRoute('/browser/session/create', 'POST', { name: 'beta' }, ctx.res, ctx.sendJSON)
    await mod.handleSessionRoute('/browser/session/list', 'GET', undefined, ctx.res, ctx.sendJSON)

    expect(ctx.calls.at(-3)).toMatchObject({
      status: 200,
      data: { ok: true, data: { name: 'alpha', active: true } },
    })
    expect(ctx.calls.at(-2)).toMatchObject({
      status: 200,
      data: { ok: true, data: { name: 'beta', active: false } },
    })
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 200,
      data: {
        ok: true,
        data: {
          active: 'alpha',
          sessions: [
            expect.objectContaining({ sessionName: 'alpha', active: true }),
            expect.objectContaining({ sessionName: 'beta', active: false }),
          ],
        },
      },
    })
  })

  it('/switch 不存在时返回 404，存在时切换 active', async () => {
    const mod = await import('../routes/session')
    const ctx = createResponseCapture()

    await mod.handleSessionRoute('/browser/session/switch', 'POST', { name: 'missing' }, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 404,
      data: { ok: false, error: { code: 'NOT_FOUND' } },
    })

    await mod.handleSessionRoute('/browser/session/create', 'POST', { name: 'alpha' }, ctx.res, ctx.sendJSON)
    await mod.handleSessionRoute('/browser/session/create', 'POST', { name: 'beta' }, ctx.res, ctx.sendJSON)
    await mod.handleSessionRoute('/browser/session/switch', 'POST', { name: 'beta' }, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 200,
      data: { ok: true, data: { active: 'beta', crawlspaceId: 'cs-beta' } },
    })
  })

  it('/close 与 /close-all 会清理 session', async () => {
    const mod = await import('../routes/session')
    const ctx = createResponseCapture()

    await mod.handleSessionRoute('/browser/session/create', 'POST', { name: 'alpha' }, ctx.res, ctx.sendJSON)
    await mod.handleSessionRoute('/browser/session/close', 'POST', { name: 'alpha' }, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 200,
      data: { ok: true, data: { closed: 'alpha', active: null } },
    })

    await mod.handleSessionRoute('/browser/session/create', 'POST', { name: 'beta' }, ctx.res, ctx.sendJSON)
    await mod.handleSessionRoute('/browser/session/create', 'POST', { name: 'gamma' }, ctx.res, ctx.sendJSON)
    await mod.handleSessionRoute('/browser/session/close-all', 'POST', undefined, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toEqual({
      status: 200,
      data: { ok: true, data: { closed: 2 } },
    })
  })

  it('bridge 未就绪返回 503，spaceId 缺失返回 400', async () => {
    let mod = await import('../routes/session')
    let ctx = createResponseCapture()

    state.setCurrentBridge(null)
    await mod.handleSessionRoute('/browser/session/list', 'GET', undefined, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 503,
      data: { ok: false, error: { code: 'INTERNAL_ERROR', retryable: true } },
    })

    vi.resetModules()
    state.setCurrentBridge(state.bridge)
    state.setCurrentSpaceId(null)
    mod = await import('../routes/session')
    ctx = createResponseCapture()
    await mod.handleSessionRoute('/browser/session/list', 'GET', undefined, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 400,
      data: { ok: false, error: { code: 'VALIDATION_ERROR' } },
    })
  })

  it('/save 缺少 crawlTabId 返回 400，executor 未就绪返回 503，成功时回传 state', async () => {
    const mod = await import('../routes/session')
    let ctx = createResponseCapture()

    await mod.handleSessionRoute('/browser/session/save', 'POST', { name: 'alpha' }, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 400,
      data: { ok: false, error: { code: 'VALIDATION_ERROR' } },
    })

    state.setCurrentExecutor(null)
    ctx = createResponseCapture()
    await mod.handleSessionRoute('/browser/session/save', 'POST', { name: 'alpha', crawlTabId: 'tab-1' }, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 503,
      data: { ok: false, error: { code: 'INTERNAL_ERROR' } },
    })

    state.setCurrentExecutor(state.executor)
    ctx = createResponseCapture()
    await mod.handleSessionRoute('/browser/session/save', 'POST', { name: 'alpha', crawlTabId: 'tab-1' }, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 200,
      data: {
        ok: true,
        data: {
          name: 'alpha',
          state: expect.objectContaining({ cookies: 'sid=1', url: 'https://example.com' }),
        },
      },
    })
  })

  it('/load 拒绝非法输入，合法 state 会调用 executor 并设为 active', async () => {
    const mod = await import('../routes/session')
    let ctx = createResponseCapture()

    await mod.handleSessionRoute('/browser/session/load', 'POST', {
      name: 'alpha',
      crawlTabId: 'tab-1',
      state: { cookies: 'a=1\r\nb=2' },
    }, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 400,
      data: { ok: false, error: { code: 'VALIDATION_ERROR' } },
    })

    ctx = createResponseCapture()
    await mod.handleSessionRoute('/browser/session/load', 'POST', {
      name: 'alpha',
      crawlTabId: 'tab-1',
      state: { localStorage: [] },
    }, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 400,
      data: { ok: false, error: { code: 'VALIDATION_ERROR' } },
    })

    ctx = createResponseCapture()
    await mod.handleSessionRoute('/browser/session/load', 'POST', {
      name: 'alpha',
      crawlTabId: 'tab-1',
      state: {
        cookies: 'sid=1',
        localStorage: { theme: 'dark' },
        sessionStorage: { draft: '1' },
      },
    }, ctx.res, ctx.sendJSON)
    expect(state.executor).toHaveBeenCalled()
    expect(state.executor.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'eval',
      params: { crawlTabId: 'tab-1' },
    })
    expect(ctx.calls.at(-1)).toEqual({
      status: 200,
      data: { ok: true, data: { name: 'alpha', active: true, loaded: true } },
    })
  })

  it('未知子路由返回 UNKNOWN_ROUTE', async () => {
    const mod = await import('../routes/session')
    const ctx = createResponseCapture()
    await mod.handleSessionRoute('/browser/session/unknown', 'GET', undefined, ctx.res, ctx.sendJSON)
    expect(ctx.calls.at(-1)).toMatchObject({
      status: 404,
      data: { ok: false, error: { code: 'UNKNOWN_ROUTE' } },
    })
  })
})
