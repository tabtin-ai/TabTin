import { describe, expect, it } from 'vitest'
import {
  buildConversationDraftScopeKey,
  buildConversationSessionScopeKey,
  buildDesktopScopeKey,
  buildImConversationScopeKey,
  buildOrganizationUserPrefsKey,
  conversationIdFromImScopeKey,
  isConversationScopeKey,
  isDesktopScopeKey,
  isImConversationScopeKey,
  isIsolatedScopeKey,
  resolveTabCodeSessionId,
  resolveWorkspaceContextState,
  resolveWorkspaceSessionId,
  sessionIdFromConversationScopeKey,
  shouldReadCanvasCollapsedPreference,
} from './workspaceContextState'
import { buildCloudDocsScopeKey } from './cloudDocsDomain'

describe('workspaceContextState', () => {
  it('maps cloud-docs mode to organization+user tab scope', () => {
    const state = resolveWorkspaceContextState({
      workbenchMode: 'cloud-docs',
      sidebarMode: 'desktop',
      organizationId: 'org-1',
      userId: 'user-1',
      executionSpaceId: 'space-1',
    })

    expect(state.kind).toBe('cloud-docs')
    expect(state.key).toBe(buildCloudDocsScopeKey({ organizationId: 'org-1', userId: 'user-1' }))
    expect(state.executionSpaceId).toBe('space-1')
  })

  it('builds a stable Organization+User desktop scope key', () => {
    expect(buildDesktopScopeKey({ organizationId: 'wt-1', userId: 'user-1' }))
      .toBe('desktop:organization:wt-1:user:user-1')
  })

  it('builds conversation session and draft scope keys', () => {
    expect(buildConversationSessionScopeKey('session-1')).toBe('conversation:session-1')
    expect(buildConversationDraftScopeKey('space-1')).toBe('conversation:draft:space-1')
    expect(buildConversationDraftScopeKey(null)).toBe('conversation:draft:unbound')
  })

  it('maps space desktop mode to the shared desktop context', () => {
    const state = resolveWorkspaceContextState({
      workbenchMode: 'space',
      sidebarMode: 'desktop',
      organizationId: 'wt-1',
      userId: 'user-1',
      executionSpaceId: 'space-1',
    })

    expect(state.kind).toBe('desktop')
    expect(state.key).toBe('desktop:organization:wt-1:user:user-1')
    expect(state.executionSpaceId).toBe('space-1')
    expect(state.legacyChatPosition).toBe('right')
  })

  it('maps space conversations mode to a per-session conversation context', () => {
    const state = resolveWorkspaceContextState({
      workbenchMode: 'space',
      sidebarMode: 'conversations',
      organizationId: 'wt-1',
      userId: 'user-1',
      executionSpaceId: 'space-1',
      sessionId: 'session-1',
    })

    expect(state.kind).toBe('conversation')
    expect(state.key).toBe('conversation:session-1')
    expect(state.desktopScopeKey).toBe('desktop:organization:wt-1:user:user-1')
    expect(state.sessionId).toBe('session-1')
    expect(state.executionSpaceId).toBe('space-1')
    expect(state.legacyChatPosition).toBe('middle')
  })

  it('uses a draft conversation key before a session exists', () => {
    const state = resolveWorkspaceContextState({
      workbenchMode: 'space',
      sidebarMode: 'conversations',
      executionSpaceId: 'space-1',
    })

    expect(state.kind).toBe('conversation')
    expect(state.key).toBe('conversation:draft:space-1')
    expect(state.sessionId).toBeNull()
  })

  it('keeps non-space workbench modes out of the desktop/conversation migration', () => {
    const state = resolveWorkspaceContextState({
      workbenchMode: 'im',
      sidebarMode: 'desktop',
      organizationId: 'wt-1',
      userId: 'user-1',
      executionSpaceId: 'space-1',
    })

    expect(state.kind).toBe('non-space')
    expect(state.key).toBe('non-space:im')
    expect(state.desktopScopeKey).toBeNull()
    expect(state.executionSpaceId).toBeNull()
    expect(state.legacyChatPosition).toBe('middle')
  })

  it('消息一级页与无工作空间的 im-chat 仍读取画布折叠偏好，避免与 rail 空态双开', () => {
    expect(shouldReadCanvasCollapsedPreference({ kind: 'non-space', key: 'non-space:im' })).toBe(true)
    expect(shouldReadCanvasCollapsedPreference({ kind: 'non-space', key: 'non-space:im-chat' })).toBe(true)
    expect(shouldReadCanvasCollapsedPreference({ kind: 'non-space', key: 'non-space:me' })).toBe(false)
    expect(shouldReadCanvasCollapsedPreference({ kind: 'non-space', key: 'non-space:welcome' })).toBe(false)
    expect(shouldReadCanvasCollapsedPreference({
      kind: 'im-conversation',
      key: 'im:conv-1',
    })).toBe(true)
    expect(shouldReadCanvasCollapsedPreference({
      kind: 'conversation',
      key: 'conversation:session-1',
    })).toBe(true)
  })

  it('maps im-chat with an execution workspace to a per-conversation im context', () => {
    const state = resolveWorkspaceContextState({
      workbenchMode: 'im-chat',
      sidebarMode: 'desktop',
      organizationId: 'wt-1',
      userId: 'user-1',
      executionSpaceId: 'workspace-1',
      imConversationId: 'conv-42',
    })

    expect(state.kind).toBe('im-conversation')
    expect(state.key).toBe('im:conv-42')
    expect(state.imConversationId).toBe('conv-42')
    expect(state.executionSpaceId).toBe('workspace-1')
    expect(state.desktopScopeKey).toBe('desktop:organization:wt-1:user:user-1')
    expect(state.legacyChatPosition).toBe('middle')
  })

  it('falls back to non-space im-chat when no execution workspace is available', () => {
    const state = resolveWorkspaceContextState({
      workbenchMode: 'im-chat',
      sidebarMode: 'desktop',
      imConversationId: 'conv-42',
    })

    expect(state.kind).toBe('non-space')
    expect(state.key).toBe('non-space:im-chat')
    expect(state.legacyChatPosition).toBe('middle')
  })

  it('falls back to non-space im-chat when no conversation id is available', () => {
    const state = resolveWorkspaceContextState({
      workbenchMode: 'im-chat',
      sidebarMode: 'desktop',
      executionSpaceId: 'workspace-1',
    })

    expect(state.kind).toBe('non-space')
    expect(state.key).toBe('non-space:im-chat')
  })

  it('builds a stable Organization+User prefs key', () => {
    expect(buildOrganizationUserPrefsKey({ organizationId: 'wt-1', userId: 'user-1' }))
      .toBe('organization-user:wt-1:user-1')
  })

  it('detects conversation and desktop scope keys', () => {
    expect(isConversationScopeKey('conversation:session-1')).toBe(true)
    expect(isConversationScopeKey('desktop:organization:wt-1:user:user-1')).toBe(false)
    expect(isDesktopScopeKey('desktop:organization:wt-1:user:user-1')).toBe(true)
  })

  it('builds and detects im conversation scope keys', () => {
    expect(buildImConversationScopeKey('conv-42')).toBe('im:conv-42')
    expect(isImConversationScopeKey('im:conv-42')).toBe(true)
    expect(isImConversationScopeKey('conversation:session-1')).toBe(false)
    expect(conversationIdFromImScopeKey('im:conv-42')).toBe('conv-42')
    expect(conversationIdFromImScopeKey('conversation:session-1')).toBeNull()
  })

  it('treats conversation and im scopes as isolated, desktop as shared', () => {
    expect(isIsolatedScopeKey('conversation:session-1')).toBe(true)
    expect(isIsolatedScopeKey('im:conv-42')).toBe(true)
    expect(isIsolatedScopeKey('desktop:organization:wt-1:user:user-1')).toBe(false)
  })

  it('extracts session id from conversation scope key', () => {
    expect(sessionIdFromConversationScopeKey('conversation:session-1')).toBe('session-1')
    expect(sessionIdFromConversationScopeKey('conversation:draft:space-1')).toBeNull()
  })

  it('resolves TabCode session from conversation scope before Space fallback', () => {
    expect(resolveTabCodeSessionId('conversation:session-2', 'session-1')).toBe('session-2')
    expect(resolveTabCodeSessionId('desktop:organization:o:user:u', 'session-1')).toBe('session-1')
    expect(resolveTabCodeSessionId('conversation:draft:space-1', 'session-1')).toBe('session-1')
    expect(resolveTabCodeSessionId(null, '  ')).toBeNull()
  })

  it('resolves desktop auxiliary session separately from conversation session', () => {
    const desktopCtx = resolveWorkspaceContextState({
      workbenchMode: 'space',
      sidebarMode: 'desktop',
      organizationId: 'wt-1',
      userId: 'user-1',
      executionSpaceId: 'space-1',
    })
    const conversationCtx = resolveWorkspaceContextState({
      workbenchMode: 'space',
      sidebarMode: 'conversations',
      organizationId: 'wt-1',
      userId: 'user-1',
      executionSpaceId: 'space-1',
      sessionId: 'session-a',
    })

    expect(resolveWorkspaceSessionId({
      workspaceContext: desktopCtx,
      currentSessionIdByWorkspaceKey: { [desktopCtx.key]: 'aux-session' },
      currentSessionIdBySpaceId: { 'space-1': 'session-a' },
    })).toBe('aux-session')

    expect(resolveWorkspaceSessionId({
      workspaceContext: conversationCtx,
      currentSessionIdByWorkspaceKey: { [desktopCtx.key]: 'aux-session' },
      currentSessionIdBySpaceId: { 'space-1': 'session-a' },
    })).toBe('session-a')
  })
})
