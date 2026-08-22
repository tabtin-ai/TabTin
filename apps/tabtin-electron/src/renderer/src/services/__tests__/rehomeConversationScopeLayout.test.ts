import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getTaskViewMode: vi.fn(),
  setTaskViewModeForScope: vi.fn(),
  taskViewModeByScopeKey: {} as Record<string, string>,
  setAppFocusChatOverlayOpen: vi.fn(),
  overlayByKey: {} as Record<string, boolean>,
  getDraftMessageById: vi.fn(),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: {
    getState: () => ({
      getTaskViewMode: mocks.getTaskViewMode,
      setTaskViewModeForScope: mocks.setTaskViewModeForScope,
      taskViewModeByScopeKey: mocks.taskViewModeByScopeKey,
    }),
  },
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      appFocusChatOverlayOpenByScopeKey: mocks.overlayByKey,
      setAppFocusChatOverlayOpen: mocks.setAppFocusChatOverlayOpen,
    }),
  },
}))

vi.mock('@stores/chat/session/draftMessage', () => ({
  getDraftMessageById: (...args: unknown[]) => mocks.getDraftMessageById(...args),
}))

import {
  rehomeConversationScopeLayout,
  rehomeConversationScopeLayoutAfterProvision,
} from '../rehomeConversationScopeLayout'

describe('rehomeConversationScopeLayout', () => {
  beforeEach(() => {
    mocks.getTaskViewMode.mockReset()
    mocks.setTaskViewModeForScope.mockReset()
    mocks.setAppFocusChatOverlayOpen.mockReset()
    mocks.getDraftMessageById.mockReset()
    mocks.taskViewModeByScopeKey = {}
    mocks.overlayByKey = {}
  })

  it('把草稿 scope 的 app-focus 与展开态迁到正式 session', () => {
    mocks.getTaskViewMode.mockReturnValue('app-focus')
    mocks.overlayByKey['conversation:draft:space-1'] = true

    rehomeConversationScopeLayout(
      'conversation:draft:space-1',
      'conversation:sess-1',
    )

    expect(mocks.setTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:sess-1',
      'app-focus',
    )
    expect(mocks.setAppFocusChatOverlayOpen).toHaveBeenCalledWith(
      'conversation:sess-1',
      true,
    )
    expect(mocks.setAppFocusChatOverlayOpen).toHaveBeenCalledWith(
      'conversation:draft:space-1',
      false,
    )
  })

  it('目标 scope 已有历史 split 时仍强制覆盖为 draft 当前 app-focus', () => {
    mocks.taskViewModeByScopeKey['conversation:sess-1'] = 'split'
    mocks.getTaskViewMode.mockReturnValue('app-focus')

    rehomeConversationScopeLayout(
      'conversation:draft:space-1',
      'conversation:sess-1',
    )

    expect(mocks.setTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:sess-1',
      'app-focus',
    )
  })

  it('provision 优先用 episode 的 draftScopeKey', () => {
    mocks.getDraftMessageById.mockReturnValue({
      draftScopeKey: 'conversation:draft:project-a',
    })
    mocks.getTaskViewMode.mockReturnValue('app-focus')

    rehomeConversationScopeLayoutAfterProvision({
      spaceId: 'space-1',
      sessionId: 'sess-9',
      expectedDraftMessageId: 'ep-1',
    })

    expect(mocks.setTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:sess-9',
      'app-focus',
    )
    expect(mocks.getTaskViewMode).toHaveBeenCalledWith('conversation:draft:project-a')
  })

  it('#7205 两跳：commit 已把 overlay 迁到 local-pending scope 时，provision 从 pending 补迁到真 session', () => {
    // 首发 commit 回合后的状态：draft overlay 已熄灭，展开态在 pending scope
    mocks.getDraftMessageById.mockReturnValue({
      draftScopeKey: 'conversation:draft:space-1',
    })
    mocks.getTaskViewMode.mockReturnValue('app-focus')
    mocks.overlayByKey['conversation:draft:space-1'] = false
    mocks.overlayByKey['conversation:local-pending-abc'] = true

    rehomeConversationScopeLayoutAfterProvision({
      spaceId: 'space-1',
      sessionId: 'sess-real',
      expectedDraftMessageId: 'ep-1',
      pendingSessionId: 'local-pending-abc',
    })

    expect(mocks.setAppFocusChatOverlayOpen).toHaveBeenCalledWith(
      'conversation:sess-real',
      true,
    )
    expect(mocks.setAppFocusChatOverlayOpen).toHaveBeenCalledWith(
      'conversation:local-pending-abc',
      false,
    )
  })

  it('#7205 两跳：pending scope 显式 mode 后写胜出（in-flight 窗口内用户切过视图）', () => {
    mocks.getDraftMessageById.mockReturnValue({
      draftScopeKey: 'conversation:draft:space-1',
    })
    mocks.getTaskViewMode.mockReturnValue('app-focus')
    mocks.taskViewModeByScopeKey['conversation:local-pending-abc'] = 'split'

    rehomeConversationScopeLayoutAfterProvision({
      spaceId: 'space-1',
      sessionId: 'sess-real',
      expectedDraftMessageId: 'ep-1',
      pendingSessionId: 'local-pending-abc',
    })

    const modeCalls = mocks.setTaskViewModeForScope.mock.calls.filter(
      ([key]) => key === 'conversation:sess-real',
    )
    expect(modeCalls[modeCalls.length - 1]).toEqual(['conversation:sess-real', 'split'])
  })

  it('#7205 两跳：pending scope 无显式 mode 时不得把默认档刷掉第一跳迁来的 draft mode', () => {
    mocks.getDraftMessageById.mockReturnValue({
      draftScopeKey: 'conversation:draft:space-1',
    })
    mocks.getTaskViewMode.mockReturnValue('app-focus')

    rehomeConversationScopeLayoutAfterProvision({
      spaceId: 'space-1',
      sessionId: 'sess-real',
      expectedDraftMessageId: 'ep-1',
      pendingSessionId: 'local-pending-abc',
    })

    expect(mocks.setTaskViewModeForScope).toHaveBeenCalledTimes(1)
    expect(mocks.setTaskViewModeForScope).toHaveBeenCalledWith(
      'conversation:sess-real',
      'app-focus',
    )
  })

  it('无绑定 local-pending（显式 createSession 等）时只做 draft 一跳', () => {
    mocks.getDraftMessageById.mockReturnValue(undefined)
    mocks.getTaskViewMode.mockReturnValue('app-focus')
    mocks.overlayByKey['conversation:draft:space-1'] = true

    rehomeConversationScopeLayoutAfterProvision({
      spaceId: 'space-1',
      sessionId: 'sess-9',
      expectedDraftMessageId: undefined,
    })

    expect(mocks.setAppFocusChatOverlayOpen).toHaveBeenCalledWith(
      'conversation:sess-9',
      true,
    )
    expect(mocks.setAppFocusChatOverlayOpen).toHaveBeenCalledWith(
      'conversation:draft:space-1',
      false,
    )
  })
})
