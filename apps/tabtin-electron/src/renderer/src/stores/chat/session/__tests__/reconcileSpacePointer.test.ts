/**
 * ：reconcile 必须兑现 resolve 的 draft，不得因「旧会话本地有消息」否决。
 * ：外部已展开会话不得被 list 竞态打回草稿。
 * ：sync 不得用 React 快照回写 currentSessionId。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chatStoreState, externalOpenedIds } = vi.hoisted(() => ({
  chatStoreState: {
    currentSessionId: null as string | null,
    currentSessionIdBySpaceId: {} as Record<string, string | null>,
    draftSessionBySpaceId: {} as Record<string, boolean>,
    sessionsBySpaceId: {} as Record<string, Array<{ id: string }>>,
    trackerRunSessionsBySpaceId: {} as Record<string, Array<{ id: string }>>,
    messagesBySessionId: {} as Record<string, unknown[]>,
    startDraftSessionForSpace: vi.fn(),
    selectSession: vi.fn(),
    setSpaceSessions: vi.fn(),
    setCurrentSessionForSpace: vi.fn(),
    sessions: [] as Array<{ id: string }>,
  },
  externalOpenedIds: new Set<string>(),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: { getState: () => chatStoreState },
}))

vi.mock('@components/onboarding/external-import/externalOpenedSessionRegistry', () => ({
  getExternalOpenedSessionIds: () => externalOpenedIds,
}))

import {
  beginOpenChatSessionIntent,
  clearOpenChatSessionIntent,
  resetOpenChatSessionIntentForTests,
} from '../openChatSessionIntent'
import {
  alignChatPointerToWorkspace,
  reconcileSpacePointer,
  syncSpaceCanonicalPointers,
} from '../reconcileSpacePointer'

const SPACE_B = 'space-org-b-empty'
const SESSION_A = 'session-org-a-with-messages'

describe('reconcileSpacePointer ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    externalOpenedIds.clear()
    chatStoreState.currentSessionId = null
    chatStoreState.currentSessionIdBySpaceId = {}
    chatStoreState.draftSessionBySpaceId = {}
    chatStoreState.sessionsBySpaceId = {}
    chatStoreState.trackerRunSessionsBySpaceId = {}
    chatStoreState.messagesBySessionId = {}
    chatStoreState.sessions = []
    resetOpenChatSessionIntentForTests()
  })

  it('空 Space + 全局仍是他组织有消息会话：必须 draft，不能被本地消息挡住', () => {
    chatStoreState.currentSessionId = SESSION_A
    chatStoreState.sessionsBySpaceId[SPACE_B] = []
    chatStoreState.messagesBySessionId[SESSION_A] = [
      { id: 'm1', role: 'user', content: 'old org' },
    ]

    reconcileSpacePointer(SPACE_B, [])

    expect(chatStoreState.startDraftSessionForSpace).toHaveBeenCalledWith(SPACE_B)
    expect(chatStoreState.selectSession).not.toHaveBeenCalled()
  })

  it('新建空 Workspace：org 合并可见列表仍含他 Workspace 会话时也必须 draft', () => {
    chatStoreState.currentSessionId = SESSION_A
    chatStoreState.sessionsBySpaceId[SPACE_B] = []

    reconcileSpacePointer(SPACE_B, [{ id: SESSION_A }])

    expect(chatStoreState.startDraftSessionForSpace).toHaveBeenCalledWith(SPACE_B)
    expect(chatStoreState.selectSession).not.toHaveBeenCalled()
  })

  it('本 Space 记忆仍在列表：restore，不 draft', () => {
    chatStoreState.currentSessionId = 'other'
    chatStoreState.currentSessionIdBySpaceId[SPACE_B] = SESSION_A
    chatStoreState.sessionsBySpaceId[SPACE_B] = [{ id: SESSION_A }]

    reconcileSpacePointer(SPACE_B, [{ id: SESSION_A }])

    expect(chatStoreState.selectSession).toHaveBeenCalledWith(SPACE_B, SESSION_A)
    expect(chatStoreState.startDraftSessionForSpace).not.toHaveBeenCalled()
  })

  it('#6697 local-pending：resolve noop，不打回草稿', () => {
    chatStoreState.currentSessionId = 'local-pending-abc'
    chatStoreState.sessionsBySpaceId[SPACE_B] = []
    chatStoreState.messagesBySessionId['local-pending-abc'] = [
      { id: 'm1', role: 'user', content: 'pending' },
    ]

    reconcileSpacePointer(SPACE_B, [])

    expect(chatStoreState.startDraftSessionForSpace).not.toHaveBeenCalled()
    expect(chatStoreState.selectSession).not.toHaveBeenCalled()
  })

  it('记忆失效且全局已是外组织会话：draft 清全局', () => {
    chatStoreState.currentSessionId = SESSION_A
    chatStoreState.currentSessionIdBySpaceId[SPACE_B] = 'session-gone'
    chatStoreState.sessionsBySpaceId[SPACE_B] = [{ id: 'session-keep' }]
    chatStoreState.messagesBySessionId[SESSION_A] = [{ id: 'm1' }]
    chatStoreState.messagesBySessionId['session-gone'] = [{ id: 'm2' }]

    reconcileSpacePointer(SPACE_B, [{ id: 'session-keep' }])

    expect(chatStoreState.startDraftSessionForSpace).toHaveBeenCalledWith(SPACE_B)
  })

  it('#7903 外部已展开记忆不在桶内：restore，不 draft', () => {
    const EXT = 'ext-opened-session'
    externalOpenedIds.add(EXT)
    chatStoreState.currentSessionId = null
    chatStoreState.currentSessionIdBySpaceId[SPACE_B] = EXT
    chatStoreState.sessionsBySpaceId[SPACE_B] = [{ id: 'session-keep' }]

    reconcileSpacePointer(SPACE_B, [{ id: 'session-keep' }])

    expect(chatStoreState.selectSession).toHaveBeenCalledWith(SPACE_B, EXT)
    expect(chatStoreState.startDraftSessionForSpace).not.toHaveBeenCalled()
  })

  it('#8724 本 Space 有会话但全局仍是他 Workspace：按本 Space 桶 align → draft', () => {
    chatStoreState.currentSessionId = SESSION_A
    chatStoreState.sessionsBySpaceId[SPACE_B] = [{ id: 'session-b-local' }]

    alignChatPointerToWorkspace(SPACE_B)

    expect(chatStoreState.startDraftSessionForSpace).toHaveBeenCalledWith(SPACE_B)
    expect(chatStoreState.selectSession).not.toHaveBeenCalled()
  })

  it('#10951 显式打开 B：空桶 + 失效指针绝不 startDraftSessionForSpace', () => {
    chatStoreState.currentSessionId = SESSION_A
    chatStoreState.currentSessionIdBySpaceId[SPACE_B] = 'dead-pointer-repro'
    chatStoreState.sessionsBySpaceId[SPACE_B] = []

    const token = beginOpenChatSessionIntent(SPACE_B, 'session-b')
    try {
      alignChatPointerToWorkspace(SPACE_B)
      reconcileSpacePointer(SPACE_B, [])
    } finally {
      clearOpenChatSessionIntent(token)
    }

    expect(chatStoreState.startDraftSessionForSpace).not.toHaveBeenCalled()
    expect(chatStoreState.selectSession).not.toHaveBeenCalled()
  })

  it('#10951 显式打开 B 时，对齐其他 Workspace 仍可 draft 清串台', () => {
    chatStoreState.currentSessionId = SESSION_A
    chatStoreState.sessionsBySpaceId[SPACE_B] = []

    const token = beginOpenChatSessionIntent('space-other', 'session-b')
    try {
      reconcileSpacePointer(SPACE_B, [])
    } finally {
      clearOpenChatSessionIntent(token)
    }

    expect(chatStoreState.startDraftSessionForSpace).toHaveBeenCalledWith(SPACE_B)
  })
})

describe('syncSpaceCanonicalPointers ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatStoreState.currentSessionId = null
    chatStoreState.sessionsBySpaceId = {}
    chatStoreState.sessions = []
  })

  it('只对齐 sessions 规范引用，不回写 currentSessionId', () => {
    const canonical = [{ id: 's1' }]
    chatStoreState.currentSessionId = null
    chatStoreState.sessionsBySpaceId[SPACE_B] = canonical
    chatStoreState.sessions = [{ id: 'derived-merge' }]

    syncSpaceCanonicalPointers(SPACE_B)

    expect(chatStoreState.setSpaceSessions).toHaveBeenCalledWith(SPACE_B, canonical, true)
    expect(chatStoreState.setCurrentSessionForSpace).not.toHaveBeenCalled()
  })

  it('陈旧旧 id 快照路径已删除：即使 store 为 null 也不存在回写入口', () => {
    chatStoreState.currentSessionId = null
    chatStoreState.sessionsBySpaceId[SPACE_B] = []
    chatStoreState.sessions = chatStoreState.sessionsBySpaceId[SPACE_B]

    // 旧签名 sync(spaceId, staleOldId) 已移除；调用方不得再传入 React 快照
    syncSpaceCanonicalPointers(SPACE_B)

    expect(chatStoreState.setCurrentSessionForSpace).not.toHaveBeenCalled()
  })
})
