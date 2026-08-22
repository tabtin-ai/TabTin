import { beforeEach, describe, expect, it } from 'vitest'
import { openSubagentTab, resolveBrowserOpenTabScopeKey } from '../openSubagentTab'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSpaceViewPrefsStore } from '@/stores/useSpaceViewPrefsStore'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'

describe('resolveBrowserOpenTabScopeKey', () => {
  const spaceId = '221793c6-83a4-4579-bc55-44a073dedb73'
  const desktopKey = 'desktop:organization:org-1:user:user-1'

  beforeEach(() => {
    useSpaceStore.setState({
      spaces: [{ id: spaceId, organization_id: 'org-1' } as never],
      selectedSpace: { id: spaceId, organization_id: 'org-1' } as never,
    })
    useAuthStore.setState({ user: { id: 'user-1' } as never })
    useChatStore.setState({ currentSessionId: null })
    useSpaceViewPrefsStore.setState({
      canvasCollapsedByScopeKey: {},
      taskViewModeByScopeKey: {},
    })
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      itemsBySpace: {},
      tabOrderBySpace: {},
    })
  })

  it('空 tabScopeKey 升到前台 desktop 桶', () => {
    expect(resolveBrowserOpenTabScopeKey(spaceId, null)).toBe(desktopKey)
  })

  it('裸 spaceId 升到前台 desktop 桶', () => {
    const key = resolveBrowserOpenTabScopeKey(spaceId, spaceId)
    expect(key).toBe(desktopKey)
    expect(key).not.toBe(spaceId)
  })

  it('已是 desktop: 显式 scope 原样保留', () => {
    expect(resolveBrowserOpenTabScopeKey(spaceId, desktopKey)).toBe(desktopKey)
  })

  it('conversation: scope 原样保留', () => {
    const conversation = 'conversation:sess-1'
    expect(resolveBrowserOpenTabScopeKey(spaceId, conversation)).toBe(conversation)
  })

  it('前台打开子 Agent 标签时同步展开同一 scope 的工作台', async () => {
    useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope(desktopKey, true)

    await openSubagentTab({
      parentSessionId: 'session-1',
      subagentRunId: 'run-1',
      spaceId,
      displayName: '验证助手',
    })

    expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed(desktopKey)).toBe(false)
  })

  it('silent 预创建不改变工作台折叠状态', async () => {
    useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope(desktopKey, true)

    await openSubagentTab({
      parentSessionId: 'session-1',
      subagentRunId: 'run-silent',
      spaceId,
      silent: true,
    })

    expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed(desktopKey)).toBe(true)
  })

  it('侧边栏所属会话与全局会话不一致时仍打开父会话工作台', async () => {
    const parentSessionId = 'session-parent'
    const parentScopeKey = `conversation:${parentSessionId}`
    const globalScopeKey = 'conversation:session-other'
    useSpaceViewPrefsStore.getState().setSidebarModeForOrganizationUser('org-1', 'user-1', 'conversations')
    useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope(parentScopeKey, true)
    useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope(globalScopeKey, true)
    useChatStore.setState({ currentSessionId: 'session-other' })

    await openSubagentTab({
      parentSessionId,
      subagentRunId: 'run-parent',
      spaceId,
    })

    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[parentScopeKey]).toBe('subagent_session:run-parent')
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[globalScopeKey]).toBeUndefined()
    expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed(parentScopeKey)).toBe(false)
    expect(useSpaceViewPrefsStore.getState().getCanvasCollapsed(globalScopeKey)).toBe(true)
  })
})
