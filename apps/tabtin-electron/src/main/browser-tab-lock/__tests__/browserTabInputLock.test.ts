import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  captureBrowserTabControlViewState,
  clearUserControlBySession,
  collectHandBackGroup,
  collectTakeOverGroup,
  consumeHandBackNotice,
  discardViewControl,
  inheritViewControl,
  getBrowserTabControlSnapshot,
  lock,
  handBackToAgent,
  isUserControllingSession,
  isUserControllingView,
  takeOverByUser,
  restoreBrowserTabControlViewState,
  unlock,
  unlockBySession,
  isLocked,
  getLockedViewIds,
  setBrowserTabLockListener,
  setOnViewsUnlocked,
  resetBrowserTabInputLockForTests,
  BrowserTabUserInControlError,
  type BrowserTabControlSnapshot,
} from '../browserTabInputLock'
import { payloadHasUserInterventionWall } from '../wallSignal'

describe('browserTabInputLock', () => {
  let listener = vi.fn<(snapshot: BrowserTabControlSnapshot) => void>()

  beforeEach(() => {
    resetBrowserTabInputLockForTests()
    listener = vi.fn<(snapshot: BrowserTabControlSnapshot) => void>()
    setBrowserTabLockListener(listener)
  })

  it('locks on any use and stays locked until wall unlock', () => {
    lock('view-a')
    expect(isLocked('view-a')).toBe(true)
    expect(getLockedViewIds()).toEqual(['view-a'])
    expect(listener).toHaveBeenLastCalledWith({
      lockedViewIds: ['view-a'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-a': [] },
    })
    lock('view-a')
    expect(listener).toHaveBeenCalledTimes(1)
    unlock('view-a')
    expect(isLocked('view-a')).toBe(false)
    expect(listener).toHaveBeenLastCalledWith({
      lockedViewIds: [],
      userControlledViewIds: [],
      sessionIdsByViewId: {},
    })
  })

  it('does not unlock other tabs', () => {
    lock('a')
    lock('b')
    unlock('a')
    expect(isLocked('b')).toBe(true)
    expect(getLockedViewIds()).toEqual(['b'])
  })

  it('unlockBySession only releases tabs held by that session', () => {
    lock('tab-a', 'chat-session-one')
    lock('tab-b', 'two')

    unlockBySession('one')

    expect(isLocked('tab-a')).toBe(false)
    expect(isLocked('tab-b')).toBe(true)
  })

  it('keeps a tab locked while another session still holds it', () => {
    lock('shared', 'one')
    lock('shared', 'two')

    unlockBySession('one')
    expect(isLocked('shared')).toBe(true)

    unlockBySession('two')
    expect(isLocked('shared')).toBe(false)
  })

  it('已锁 view 的 holder 新增与部分移除都会广播 snapshot，但不触发 unlock', () => {
    const unlocked = vi.fn<(ids: string[]) => void>()
    setOnViewsUnlocked(unlocked)
    lock('shared', 'session-1')
    listener.mockClear()

    lock('shared', 'session-2')
    expect(listener).toHaveBeenLastCalledWith({
      lockedViewIds: ['shared'],
      userControlledViewIds: [],
      sessionIdsByViewId: {
        shared: ['session-1', 'session-2'],
      },
    })
    expect(unlocked).not.toHaveBeenCalled()

    unlockBySession('session-1')
    expect(listener).toHaveBeenLastCalledWith({
      lockedViewIds: ['shared'],
      userControlledViewIds: [],
      sessionIdsByViewId: {
        shared: ['session-2'],
      },
    })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(unlocked).not.toHaveBeenCalled()
  })

  it('wall unlock clears the tab even if a session still holds it', () => {
    lock('tab-a', 'one')

    unlock('tab-a')

    expect(isLocked('tab-a')).toBe(false)
  })

  it('lock without sessionId stays locked after unlockBySession', () => {
    lock('orphan')

    unlockBySession('one')

    expect(isLocked('orphan')).toBe(true)
  })

  it('unlock notifies onViewsUnlocked with the released view', () => {
    const unlocked = vi.fn<(ids: string[]) => void>()
    setOnViewsUnlocked(unlocked)
    lock('view-a')
    unlock('view-a')
    expect(unlocked).toHaveBeenCalledWith(['view-a'])
  })

  it('unlockBySession notifies only fully released views', () => {
    const unlocked = vi.fn<(ids: string[]) => void>()
    setOnViewsUnlocked(unlocked)
    lock('tab-a', 'one')
    lock('shared', 'one')
    lock('shared', 'two')

    unlockBySession('one')

    expect(unlocked).toHaveBeenCalledWith(['tab-a'])
    unlockBySession('two')
    expect(unlocked).toHaveBeenLastCalledWith(['shared'])
  })

  it('接管后揭膜并收起 cursor，同会话重复 lock 被抑制，交还提示只消费一次', () => {
    const unlocked = vi.fn<(ids: string[]) => void>()
    setOnViewsUnlocked(unlocked)
    lock('view-1', 'session-1')

    expect(takeOverByUser('view-1')).toEqual(['session-1'])
    expect(unlocked).toHaveBeenCalledWith(['view-1'])
    expect(isUserControllingSession('session-1')).toBe(true)
    expect(isUserControllingView('view-1')).toBe(true)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })

    expect(() => lock('view-1', 'session-1')).toThrow(BrowserTabUserInControlError)
    expect(() => lock('view-1', 'session-2')).toThrow(BrowserTabUserInControlError)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })

    expect(handBackToAgent('view-1')).toEqual({
      affectedSessionIds: ['session-1'],
      releaseSessionIds: ['session-1'],
    })
    expect(isUserControllingSession('session-1')).toBe(false)
    expect(isUserControllingView('view-1')).toBe(false)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
    expect(consumeHandBackNotice('session-1')).toBe(true)
    expect(consumeHandBackNotice('session-1')).toBe(false)
  })

  it('同 tab 多 holder 接管时保留全部 session，并可逐 session 终态清理', () => {
    lock('view-1', 'session-2')
    lock('view-1', 'session-1')

    expect(takeOverByUser('view-1')).toEqual(['session-1', 'session-2'])
    expect(clearUserControlBySession('session-1')).toBe(true)
    expect(isUserControllingSession('session-1')).toBe(false)
    expect(isUserControllingSession('session-2')).toBe(true)
    expect(getBrowserTabControlSnapshot().sessionIdsByViewId['view-1']).toEqual(['session-2'])
  })

  it('session 终态会清理尚未消费的交还提示', () => {
    lock('view-1', 'session-1')
    takeOverByUser('view-1')
    handBackToAgent('view-1')

    expect(clearUserControlBySession('session-1')).toBe(true)
    expect(consumeHandBackNotice('session-1')).toBe(false)
  })

  it('接管 park 失败可按 token 精确恢复接管前 Agent 控制态，且不产生 notice', () => {
    lock('view-1', 'session-1')
    lock('view-1', 'session-2')
    const state = captureBrowserTabControlViewState('view-1')
    expect(state).toMatchObject({
      locked: true,
      holderSessionIds: ['session-1', 'session-2'],
      userControlledSessionIds: [],
    })

    expect(takeOverByUser('view-1')).toEqual(['session-1', 'session-2'])
    restoreBrowserTabControlViewState(state)

    expect(isUserControllingSession('session-1')).toBe(false)
    expect(isUserControllingSession('session-2')).toBe(false)
    expect(isUserControllingView('view-1')).toBe(false)
    expect(isLocked('view-1')).toBe(true)
    expect(consumeHandBackNotice('session-1')).toBe(false)
    expect(consumeHandBackNotice('session-2')).toBe(false)
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: ['view-1'],
      userControlledViewIds: [],
      sessionIdsByViewId: { 'view-1': ['session-1', 'session-2'] },
    })
  })

  it('同一 session 控制多个 view 时一次 handback 整组恢复并只产生一次 notice', () => {
    lock('view-1', 'session-1')
    lock('view-2', 'session-1')
    takeOverByUser('view-1')

    expect(isUserControllingView('view-1')).toBe(true)
    expect(isUserControllingView('view-2')).toBe(true)

    expect(handBackToAgent('view-1')).toEqual({
      affectedSessionIds: ['session-1'],
      releaseSessionIds: ['session-1'],
    })
    expect(isUserControllingSession('session-1')).toBe(false)
    expect(isLocked('view-1')).toBe(true)
    expect(isLocked('view-2')).toBe(true)
    expect(consumeHandBackNotice('session-1')).toBe(true)
    expect(consumeHandBackNotice('session-1')).toBe(false)
  })

  it('接管扩展到 session 的全部 view，组内全部揭膜', () => {
    lock('view-1', 'session-1')
    lock('view-2', 'session-1')
    lock('view-other', 'session-other')

    expect(collectTakeOverGroup('view-1')).toEqual({
      viewIds: ['view-1', 'view-2'],
      sessionIds: ['session-1'],
    })

    const sessions = takeOverByUser('view-1')
    expect(sessions).toEqual(['session-1'])
    expect(isUserControllingView('view-1')).toBe(true)
    expect(isUserControllingView('view-2')).toBe(true)
    expect(isLocked('view-1')).toBe(false)
    expect(isLocked('view-2')).toBe(false)
    // 无关 session 的 tab 不受影响
    expect(isUserControllingView('view-other')).toBe(false)
    expect(isLocked('view-other')).toBe(true)
  })

  it('共享 view 的第二个 session 也计入接管组（一跳闭包，不递归）', () => {
    lock('view-1', 'session-1')
    lock('view-2', 'session-1')
    lock('view-2', 'session-2')   // session-2 共持 view-2
    lock('view-3', 'session-2')   // 但 view-3 不进组（不递归展开）

    const group = collectTakeOverGroup('view-1')
    expect(group.viewIds).toEqual(['view-1', 'view-2'])
    expect(group.sessionIds).toEqual(['session-1', 'session-2'])

    takeOverByUser('view-1')
    expect(isUserControllingView('view-3')).toBe(false)
    expect(isLocked('view-3')).toBe(true)
  })

  it('交还把该 session 的全部 view 一次性恢复锁态，通知只发一次', () => {
    lock('view-1', 'session-1')
    lock('view-2', 'session-1')
    takeOverByUser('view-1')

    expect(collectHandBackGroup('view-2')).toEqual({
      viewIds: ['view-1', 'view-2'],
      sessionIds: ['session-1'],
    })

    const result = handBackToAgent('view-2')
    expect(result.affectedSessionIds).toEqual(['session-1'])
    expect(result.releaseSessionIds).toEqual(['session-1'])
    expect(isLocked('view-1')).toBe(true)
    expect(isLocked('view-2')).toBe(true)
    expect(isUserControllingView('view-1')).toBe(false)
    expect(isUserControllingView('view-2')).toBe(false)
    // holders 保留 → 胶囊 session 展示恢复
    expect(getBrowserTabControlSnapshot().sessionIdsByViewId['view-1']).toEqual(['session-1'])
    expect(consumeHandBackNotice('session-1')).toBe(true)
    expect(consumeHandBackNotice('session-1')).toBe(false)
  })

  it('collect 函数对无控制态 view 返回空组', () => {
    expect(collectTakeOverGroup('ghost')).toEqual({ viewIds: [], sessionIds: [] })
    expect(collectHandBackGroup('ghost')).toEqual({ viewIds: [], sessionIds: [] })
  })

  it('inheritViewControl: 锁态源 view 派生的新 view 立即入锁并复制 holder', () => {
    lock('view-src', 'session-1')
    inheritViewControl('view-src', 'view-new')

    expect(isLocked('view-new')).toBe(true)
    expect(getBrowserTabControlSnapshot().sessionIdsByViewId['view-new']).toEqual(['session-1'])
    // 新 view 已进入 session 组：后续接管组包含它
    expect(collectTakeOverGroup('view-src').viewIds).toEqual(['view-new', 'view-src'])
  })

  it('inheritViewControl: unscoped 锁态源 view 派生的新 view 立即入锁且无 session holder', () => {
    lock('view-src')
    inheritViewControl('view-src', 'view-new')

    expect(isLocked('view-new')).toBe(true)
    expect(getBrowserTabControlSnapshot().sessionIdsByViewId['view-new']).toEqual([])
  })

  it('inheritViewControl: 用户接管态源 view 派生的新 view 标记用户控制而非盖膜', () => {
    lock('view-src', 'session-1')
    takeOverByUser('view-src')
    inheritViewControl('view-src', 'view-new')

    expect(isLocked('view-new')).toBe(false)
    expect(isUserControllingView('view-new')).toBe(true)
    expect(getBrowserTabControlSnapshot().sessionIdsByViewId['view-new']).toEqual(['session-1'])
    expect(collectHandBackGroup('view-new')).toEqual({
      viewIds: ['view-new', 'view-src'],
      sessionIds: ['session-1'],
    })

    handBackToAgent('view-new')
    expect(isLocked('view-new')).toBe(true)
    expect(isLocked('view-src')).toBe(true)
    expect(isUserControllingView('view-new')).toBe(false)
    expect(isUserControllingView('view-src')).toBe(false)
    expect(getBrowserTabControlSnapshot().sessionIdsByViewId['view-new']).toEqual(['session-1'])
  })

  it('inheritViewControl: 无控制态源 view 为 no-op', () => {
    const before = getBrowserTabControlSnapshot()
    inheritViewControl('view-plain', 'view-new')
    expect(getBrowserTabControlSnapshot()).toEqual(before)
    expect(isLocked('view-new')).toBe(false)
  })

  it('discardViewControl 清除派生 view 的 holder、session 映射与用户接管态', () => {
    lock('view-src', 'session-1')
    takeOverByUser('view-src')
    inheritViewControl('view-src', 'view-new')

    expect(isUserControllingView('view-new')).toBe(true)
    discardViewControl('view-new')

    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: ['view-src'],
      sessionIdsByViewId: {
        'view-src': ['session-1'],
      },
    })
    expect(collectHandBackGroup('view-src').viewIds).toEqual(['view-src'])
  })

  it('discardViewControl 清除派生 view 的锁态和 sessionViews 反向映射', () => {
    lock('view-src', 'session-1')
    inheritViewControl('view-src', 'view-new')

    discardViewControl('view-new')

    expect(isLocked('view-new')).toBe(false)
    expect(getBrowserTabControlSnapshot().sessionIdsByViewId).toEqual({
      'view-src': ['session-1'],
    })
    expect(collectTakeOverGroup('view-src').viewIds).toEqual(['view-src'])
  })

  it('handback 失败可恢复 view state 并撤销本次 notice', () => {
    lock('view-1', 'session-1')
    takeOverByUser('view-1')
    const state = captureBrowserTabControlViewState('view-1')

    handBackToAgent('view-1')
    restoreBrowserTabControlViewState(state)

    expect(isUserControllingSession('session-1')).toBe(true)
    expect(consumeHandBackNotice('session-1')).toBe(false)
  })

  it('受控 rollback fixture 即使含冲突标记，snapshot 也只暴露用户控制态', () => {
    restoreBrowserTabControlViewState({
      viewId: 'view-1',
      locked: true,
      unscopedLocked: false,
      holderSessionIds: ['session-1'],
      userControlledSessionIds: ['session-1'],
      pendingHandBackNoticeSessionIds: [],
    })

    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: ['view-1'],
      sessionIdsByViewId: { 'view-1': ['session-1'] },
    })
  })

  it('snapshot 对 view 和 session 使用稳定排序', () => {
    lock('view-z', 'session-z')
    lock('view-a', 'session-2')
    lock('view-a', 'session-1')
    takeOverByUser('view-z')
    takeOverByUser('view-a')

    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: [],
      userControlledViewIds: ['view-a', 'view-z'],
      sessionIdsByViewId: {
        'view-a': ['session-1', 'session-2'],
        'view-z': ['session-z'],
      },
    })
  })

  it('snapshot 只暴露当前控制态 view，并在 Agent→用户→交还→重锁间保留规范化多 holder', () => {
    lock('view-z', 'session-z')
    lock('view-a', 'chat-session-session-2')
    lock('view-a', 'session-1')

    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: ['view-a', 'view-z'],
      userControlledViewIds: [],
      sessionIdsByViewId: {
        'view-a': ['session-1', 'session-2'],
        'view-z': ['session-z'],
      },
    })

    takeOverByUser('view-a')
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: ['view-z'],
      userControlledViewIds: ['view-a'],
      sessionIdsByViewId: {
        'view-a': ['session-1', 'session-2'],
        'view-z': ['session-z'],
      },
    })

    handBackToAgent('view-a')
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: ['view-a', 'view-z'],
      userControlledViewIds: [],
      sessionIdsByViewId: {
        'view-a': ['session-1', 'session-2'],
        'view-z': ['session-z'],
      },
    })

    lock('view-a', 'chat-session-session-1')
    expect(getBrowserTabControlSnapshot()).toEqual({
      lockedViewIds: ['view-a', 'view-z'],
      userControlledViewIds: [],
      sessionIdsByViewId: {
        'view-a': ['session-1', 'session-2'],
        'view-z': ['session-z'],
      },
    })
  })
})

describe('payloadHasUserInterventionWall', () => {
  it('detects login_required and captcha_required on data and error.detail', () => {
    expect(payloadHasUserInterventionWall({ login_required: { reason: 'login' } })).toBe(true)
    expect(payloadHasUserInterventionWall({ captcha_required: { type: 'recaptcha-v2' } })).toBe(true)
    expect(payloadHasUserInterventionWall({
      ok: false,
      error: { detail: { captcha_required: { type: 'turnstile' } } },
    })).toBe(true)
    expect(payloadHasUserInterventionWall({ ok: true, data: { title: 'ok' } })).toBe(false)
  })
})
