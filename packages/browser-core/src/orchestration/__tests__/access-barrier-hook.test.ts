import { describe, expect, it, vi } from 'vitest'
import {
  handleBrowserAction,
  type BrowserExecHooks,
  type BrowserExecOutcome,
  type BrowserOrchestratorHostHooks,
} from '../BrowserOrchestrator'
import { resetSharedRefCache } from '../../runtime'
import {
  ACCESS_BARRIER_RESUME_CLEARED_HINT,
  ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT,
} from '../../access-barrier'

const ALLOW_POLICY = { resolveConfirmation: async () => true } as const

function makeObserveHooks(
  observeOutcome: BrowserExecOutcome | (() => BrowserExecOutcome | Promise<BrowserExecOutcome>),
  extra: Partial<BrowserOrchestratorHostHooks> = {},
): BrowserOrchestratorHostHooks {
  const exec: BrowserExecHooks = {
    observeLimitDefault: 50,
    async prepareTab() {
      return 't1'
    },
    async runAct() {
      return { success: true, raw: {} }
    },
    async runObserve() {
      return typeof observeOutcome === 'function' ? observeOutcome() : observeOutcome
    },
  }
  return { runtime: 'electron', exec, policy: ALLOW_POLICY, ...extra }
}

const AUTH_WALL_RAW: BrowserExecOutcome = {
  success: true,
  raw: {
    observed_elements: [],
    page_url: 'https://www.xiaohongshu.com/explore',
    page_title: '小红书',
    block: { blocked: true, type: 'auth_wall', loginRequired: true, reason: '需要登录', confidence: 0.9 },
  },
}

const CLEAR_PAGE_RAW: BrowserExecOutcome = {
  success: true,
  raw: {
    observed_elements: [{ ref: 'e1', role: 'link', text: '热榜', href: 'https://www.xiaohongshu.com/hot' }],
    page_url: 'https://www.xiaohongshu.com/hot',
    page_title: '热榜',
  },
}

describe('handleBrowserAction —— resolveAccessBarrier hook（access barrier HITL）', () => {
  it('命中登录墙时 await resolveAccessBarrier，并把决议写入 data', async () => {
    const resolveAccessBarrier = vi.fn(async () => ({ action: 'alternate_source' as const }))
    const hooks = makeObserveHooks(AUTH_WALL_RAW, { resolveAccessBarrier })

    const result = await handleBrowserAction('observe', { tabId: 't1' }, hooks)

    expect(resolveAccessBarrier).toHaveBeenCalledOnce()
    expect(resolveAccessBarrier).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'login', domain: 'xiaohongshu.com', tabId: 't1' }),
    )
    expect(result?.ok && (result.data as any).access_barrier_resolution).toEqual({ action: 'alternate_source' })
    expect(result?.ok && (result.data as any).login_required).toBeTruthy() // 过渡双写
  })

  it('未注入 resolveAccessBarrier 时写 host_unavailable，不抛错', async () => {
    resetSharedRefCache()
    const hooks = makeObserveHooks(AUTH_WALL_RAW)

    const result = await handleBrowserAction('observe', { tabId: 't1' }, hooks)

    expect(result?.ok).toBe(true)
    expect(result?.ok && (result.data as any).access_barrier_resolution).toEqual({ action: 'host_unavailable' })
    expect(result?.ok && (result.data as any).access_barrier?.kind).toBe('login')
  })

  it('无墙信号时不调用 hook、不加 access_barrier 键', async () => {
    const resolveAccessBarrier = vi.fn(async () => ({ action: 'abort_this_target' as const }))
    const hooks = makeObserveHooks(
      { success: true, raw: { observed_elements: [], page_url: 'https://example.com', page_title: 't' } },
      { resolveAccessBarrier },
    )

    const result = await handleBrowserAction('observe', {}, hooks)

    expect(resolveAccessBarrier).not.toHaveBeenCalled()
    expect(result?.ok && (result.data as any).access_barrier).toBeUndefined()
  })

  it('resume_same_tab 后强制复检：无墙时覆盖观察且不再双写 login_required', async () => {
    resetSharedRefCache()
    let observeCalls = 0
    const resolveAccessBarrier = vi.fn(async () => ({ action: 'resume_same_tab' as const, tabId: 't1' }))
    const hooks = makeObserveHooks(async () => {
      observeCalls += 1
      return observeCalls === 1 ? AUTH_WALL_RAW : CLEAR_PAGE_RAW
    }, { resolveAccessBarrier })

    const result = await handleBrowserAction('observe', { tabId: 't1' }, hooks)

    expect(resolveAccessBarrier).toHaveBeenCalledOnce()
    expect(observeCalls).toBe(2)
    expect(result?.ok).toBe(true)
    if (!result?.ok) return
    expect(result.data.access_barrier_resolution).toEqual({ action: 'resume_same_tab', tabId: 't1' })
    expect(result.data.login_required).toBeUndefined()
    expect(result.data.access_barrier_hint).toBe(ACCESS_BARRIER_RESUME_CLEARED_HINT)
    expect(result.data.page_url).toBe('https://www.xiaohongshu.com/hot')
    expect(result.data.observed_elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: 'e1' })]),
    )
  })

  it('resume_same_tab 后复检仍有墙：诚实 still_blocked，且不再二次弹卡', async () => {
    resetSharedRefCache()
    let observeCalls = 0
    const resolveAccessBarrier = vi.fn(async () => ({ action: 'resume_same_tab' as const, tabId: 't1' }))
    const hooks = makeObserveHooks(async () => {
      observeCalls += 1
      return AUTH_WALL_RAW
    }, { resolveAccessBarrier })

    const result = await handleBrowserAction('observe', { tabId: 't1' }, hooks)

    expect(resolveAccessBarrier).toHaveBeenCalledOnce()
    expect(observeCalls).toBe(2)
    expect(result?.ok && (result.data as any).access_barrier_resolution).toEqual({
      action: 'resume_same_tab',
      tabId: 't1',
    })
    expect(result?.ok && (result.data as any).login_required?.hint).toBe(
      ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT,
    )
  })

  it('act 撞验证码墙也会调用 resolveAccessBarrier；resume 后走复检 observe', async () => {
    const resolveAccessBarrier = vi.fn(async () => ({ action: 'resume_same_tab' as const, tabId: 't1' }))
    const runObserve = vi.fn(async () => CLEAR_PAGE_RAW)
    const exec: BrowserExecHooks = {
      observeLimitDefault: 50,
      async prepareTab() {
        return 't1'
      },
      async runAct() {
        return {
          success: true,
          raw: {
            executed_actions: [],
            page_url: 'https://example.com',
            captcha: { detected: true, type: 'geetest', confidence: 0.8, challenge_visible: true, suggested_action: 'manual' },
          },
        }
      },
      runObserve,
    }
    const hooks: BrowserOrchestratorHostHooks = { runtime: 'electron', exec, policy: ALLOW_POLICY, resolveAccessBarrier }

    const result = await handleBrowserAction('act', { actions: [{ type: 'click', selector: '#x' }] }, hooks)

    expect(resolveAccessBarrier).toHaveBeenCalledOnce()
    expect(runObserve).toHaveBeenCalledOnce()
    expect(result?.ok && (result.data as any).access_barrier_resolution).toEqual({ action: 'resume_same_tab', tabId: 't1' })
    expect(result?.ok && (result.data as any).login_required).toBeUndefined()
    expect(result?.ok && (result.data as any).captcha_required).toBeUndefined()
  })
})
