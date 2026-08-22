/**
 * 动作层单测（PRD §8.10 验收项「切 Space / 一键停」自动化保护，B4）
 *
 * 覆盖 `openTerminalSession`（切到目标 spaceId + openResourceTab）与
 * `stopTerminalSession`（killPtySession + 双 store 标 closed + toast，且成功 toast
 * 以「真 kill 到本机会话」为前提）。store / kill / nav / toast 全 mock，纯验编排。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TerminalSession } from './sources/terminal'

const h = vi.hoisted(() => ({
  killPtySession: vi.fn(),
  ensureSpaceSelectedWithFeedback: vi.fn(),
  openResourceTab: vi.fn(),
  addSpaceSession: vi.fn(),
  markSpaceSessionClosed: vi.fn(),
  markTranscriptClosed: vi.fn(),
  removeStatus: vi.fn(),
  toast: vi.fn(),
  sessionsBySpace: {} as Record<string, Array<{ id: string }>>,
}))

vi.mock('@components/context-space/sources/terminal', () => ({
  killPtySession: h.killPtySession,
  applyClosedRetention: (s: unknown) => s,
  useTerminalSessionStore: {
    getState: () => ({
      sessionsBySpace: h.sessionsBySpace,
      addSpaceSession: h.addSpaceSession,
      markSpaceSessionClosed: h.markSpaceSessionClosed,
    }),
  },
  useAgentTerminalTranscriptStore: {
    getState: () => ({ markTranscriptClosed: h.markTranscriptClosed }),
  },
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: h.ensureSpaceSelectedWithFeedback,
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab: h.openResourceTab }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(() => null, { getState: () => ({ spaces: [], selectedSpace: null }) }),
}))

vi.mock('@stores/useTerminalPaneStatusStore', () => ({
  useTerminalPaneStatusStore: {
    getState: () => ({ removeStatus: h.removeStatus }),
  },
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: h.toast }))

vi.mock('@/i18n', () => ({
  default: { t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k },
}))

import { openTerminalSession, stopTerminalSession } from './terminalOverviewModel'

function makeSession(over: Partial<TerminalSession> & { id: string; spaceId: string }): TerminalSession {
  return {
    title: 'My Term',
    createdAt: 123,
    source: 'user',
    status: 'active',
    cwd: '/tmp',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.sessionsBySpace = {}
})

describe('openTerminalSession', () => {
  it('切到目标 spaceId、materialize 未登记会话、并 openResourceTab', async () => {
    h.ensureSpaceSelectedWithFeedback.mockResolvedValue(true)
    const session = makeSession({ id: 'term-1', spaceId: 'space-x' })

    await openTerminalSession(session)

    expect(h.ensureSpaceSelectedWithFeedback).toHaveBeenCalledWith('space-x', expect.any(Object))
    expect(h.addSpaceSession).toHaveBeenCalledWith('space-x', 'term-1', 'My Term', 'user', '/tmp', undefined)
    expect(h.openResourceTab).toHaveBeenCalledWith(
      'space-x',
      expect.objectContaining({ type: 'terminal', id: 'term-1', title: 'My Term' }),
    )
  })

  it('已 materialize 的会话不重复 addSpaceSession，但仍 openResourceTab', async () => {
    h.ensureSpaceSelectedWithFeedback.mockResolvedValue(true)
    h.sessionsBySpace = { 'space-x': [{ id: 'term-1' }] }
    const session = makeSession({ id: 'term-1', spaceId: 'space-x' })

    await openTerminalSession(session)

    expect(h.addSpaceSession).not.toHaveBeenCalled()
    expect(h.openResourceTab).toHaveBeenCalledTimes(1)
  })

  it('conversation scope 终端点击时切到 executionSpaceId，并 materialize 到可见 Space 桶', async () => {
    h.ensureSpaceSelectedWithFeedback.mockResolvedValue(true)
    const session = makeSession({
      id: 'term-1',
      spaceId: 'conversation:session-1',
      executionSpaceId: 'space-x',
    })

    await openTerminalSession(session)

    expect(h.ensureSpaceSelectedWithFeedback).toHaveBeenCalledWith('space-x', expect.any(Object))
    expect(h.addSpaceSession).toHaveBeenCalledWith('space-x', 'term-1', 'My Term', 'user', '/tmp', 'space-x')
    expect(h.openResourceTab).toHaveBeenCalledWith(
      'space-x',
      expect.objectContaining({ type: 'terminal', id: 'term-1', title: 'My Term' }),
    )
  })

  it('切 Space 失败（返回 false）→ 不 openResourceTab', async () => {
    h.ensureSpaceSelectedWithFeedback.mockResolvedValue(false)
    const session = makeSession({ id: 'term-1', spaceId: 'space-x' })

    await openTerminalSession(session)

    expect(h.openResourceTab).not.toHaveBeenCalled()
    expect(h.addSpaceSession).not.toHaveBeenCalled()
  })

  it('切 Space 抛错（网络 load throw）→ 兜底 toast、不 openResourceTab', async () => {
    h.ensureSpaceSelectedWithFeedback.mockRejectedValue(new Error('network'))
    const session = makeSession({ id: 'term-1', spaceId: 'space-x' })

    await openTerminalSession(session)

    expect(h.toast).toHaveBeenCalledTimes(1)
    expect(h.openResourceTab).not.toHaveBeenCalled()
  })
})

describe('stopTerminalSession', () => {
  it('真 kill 到本机会话 → 双 store 标 closed + 成功 toast', async () => {
    h.killPtySession.mockResolvedValue(true)
    const session = makeSession({ id: 'term-1', spaceId: 'space-x' })

    await stopTerminalSession(session)

    expect(h.killPtySession).toHaveBeenCalledWith('term-1')
    expect(h.markSpaceSessionClosed).toHaveBeenCalledWith('space-x', 'term-1')
    expect(h.markTranscriptClosed).toHaveBeenCalledWith('space-x', 'term-1')
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '已停止终端' }))
  })

  it('R3 P1-3：真 kill 成功后清掉渲染端残留 paneStatus（防徽标卡「运行中」）', async () => {
    // 回归保护：kill 成功必须 removeStatus(id)，否则跨 Agent 总览作为全局订阅者
    // 收不到主进程 exited，paneStatus 残留 running 让徽标一直显示「运行中」。
    h.killPtySession.mockResolvedValue(true)
    const session = makeSession({ id: 'term-1', spaceId: 'space-x' })

    await stopTerminalSession(session)

    expect(h.removeStatus).toHaveBeenCalledWith('term-1')
  })

  it('本机 kill 不到（返回 false）→ 不标 closed、不清 paneStatus、改提示去对应设备停', async () => {
    h.killPtySession.mockResolvedValue(false)
    const session = makeSession({ id: 'term-1', spaceId: 'space-x' })

    await stopTerminalSession(session)

    expect(h.killPtySession).toHaveBeenCalledWith('term-1')
    expect(h.markSpaceSessionClosed).not.toHaveBeenCalled()
    expect(h.markTranscriptClosed).not.toHaveBeenCalled()
    expect(h.removeStatus).not.toHaveBeenCalled()
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: '未能在本机停止，请到对应设备停止', variant: 'destructive' }),
    )
  })
})
