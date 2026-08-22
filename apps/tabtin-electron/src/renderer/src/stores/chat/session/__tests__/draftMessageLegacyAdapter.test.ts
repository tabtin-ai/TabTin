import { describe, expect, it } from 'vitest'
import {
  buildDraftMessageMetadataFromLegacy,
  buildDraftMessageSessionContext,
  legacyHiddenDraftSessionId,
  legacyIsUiDraft,
  resolveConversationDraftScopeKey,
} from '../draftMessageLegacyAdapter'

describe('draftMessageLegacyAdapter ', () => {
  it('元数据不得把 generic legacy host 冒充 executionWorkspaceId', () => {
    expect(buildDraftMessageMetadataFromLegacy({
      organizationId: 'org-1',
      // 旧 API 曾传 host；现必须显式 executionWorkspaceId
    })).toEqual({
      organizationId: 'org-1',
      executionWorkspaceId: undefined,
      projectId: undefined,
      agentId: undefined,
    })
    expect(buildDraftMessageMetadataFromLegacy({
      executionWorkspaceId: 'ws-real',
      projectId: 'proj-real',
      agentId: 'agent-1',
    })).toEqual({
      organizationId: undefined,
      executionWorkspaceId: 'ws-real',
      projectId: 'proj-real',
      agentId: 'agent-1',
    })
  })

  it('D. 优先 tabScopeKey；fallback 只在 adapter 层用 legacy host 生成', () => {
    expect(resolveConversationDraftScopeKey({
      tabScopeKey: 'conversation:draft:workspace-a',
      legacyExecutionHostId: 'other-host',
    })).toBe('conversation:draft:workspace-a')

    expect(resolveConversationDraftScopeKey({
      tabScopeKey: 'conversation:sess-real',
      legacyExecutionHostId: 'workspace-b',
    })).toBe('conversation:draft:workspace-b')

    expect(resolveConversationDraftScopeKey({
      legacyExecutionHostId: 'workspace-c',
    })).toBe('conversation:draft:workspace-c')
  })

  it('主链 stableDraftScopeKey 优先于 conversation:S，且禁止 fallback execution B', () => {
    expect(resolveConversationDraftScopeKey({
      stableDraftScopeKey: 'conversation:draft:project-a',
      tabScopeKey: 'conversation:sess-historical',
      legacyExecutionHostId: 'exec-ws-b',
    })).toBe('conversation:draft:project-a')

    // 显式给了非法 stable → fail-closed，不得猜 B
    expect(resolveConversationDraftScopeKey({
      stableDraftScopeKey: 'conversation:sess-not-draft',
      tabScopeKey: 'conversation:sess-historical',
      legacyExecutionHostId: 'exec-ws-b',
    })).toBeNull()
  })

  it('legacy 指针推导 isUiDraft / hiddenSessionId', () => {
    const pointers = {
      draftSessionBySpaceId: { 'ws-1': true },
      currentSessionIdBySpaceId: { 'ws-1': 'sess-hidden' as string | null },
    }
    expect(legacyIsUiDraft('ws-1', pointers)).toBe(true)
    expect(legacyHiddenDraftSessionId('ws-1', pointers)).toBe('sess-hidden')
    expect(buildDraftMessageSessionContext({
      draftScopeKey: 'conversation:draft:ws-1',
      legacyExecutionHostId: 'ws-1',
      pointers,
    })).toMatchObject({
      draftScopeKey: 'conversation:draft:ws-1',
      isUiDraft: true,
      hiddenSessionId: 'sess-hidden',
    })
  })
})
