/**
 * 队列/草稿恢复回归：busy queue 重新编辑、失败消息恢复、撤回编辑等路径都汇入
 * applyPrefillData，其中 `prefillData.contextBlocks.map(blockToContextRef)` 恢复
 * context chip。本文件验证 mcp_server 块在这些恢复路径里不会丢失。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const chatStoreState = vi.hoisted(() => ({
  composerClearNonceBySessionId: {} as Record<string, number>,
  composerDraftKeysPendingClearBySessionId: {} as Record<string, string[]>,
  clearComposerDraftKeysPendingClear: vi.fn(),
  setReplyTarget: vi.fn(),
}))

const draftMocks = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  clearDrafts: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}))

vi.mock('@/stores/chat/useChatStore', () => {
  const useChatStore = (selector: (state: typeof chatStoreState) => unknown) => (
    selector(chatStoreState)
  )
  useChatStore.getState = () => chatStoreState
  return { useChatStore }
})

vi.mock('@/stores/useChatRuntimeStore', () => {
  const state = {
    pendingPrefillBySessionId: {},
    pendingInterruptedMessageBySessionId: {},
    consumePrefillForSession: vi.fn(() => null),
    consumeInterruptedMessageRecovery: vi.fn(() => null),
    discardInterruptedMessageRecovery: vi.fn(),
  }
  const useChatRuntimeStore = (selector: (s: typeof state) => unknown) => selector(state)
  useChatRuntimeStore.getState = () => state
  return { useChatRuntimeStore }
})

vi.mock('../chatInputDraft', () => ({
  saveDraft: draftMocks.saveDraft,
  clearDrafts: draftMocks.clearDrafts,
}))

import { useChatInputPrefillRecovery } from '../useChatInputPrefillRecovery'

const MCP_BLOCK = {
  type: 'mcp_server',
  connection_id: 'conn-1',
  server_name: 'github',
  source_label: 'Manual',
  preview: 'github',
}

function setup() {
  const onAddContextRef = vi.fn()
  const setInput = vi.fn()
  const setAttachments = vi.fn()
  const clearInputState = vi.fn()
  const textareaRef = { current: null }
  const { result, rerender } = renderHook(() =>
    useChatInputPrefillRecovery({
      sessionId: 's1',
      input: '',
      onAddContextRef,
      setInput,
      setAttachments,
      textareaRef,
      clearInputState,
      hasCurrentComposerDraft: false,
    }),
  )
  return { result, rerender, onAddContextRef, setInput, clearInputState }
}

describe('useChatInputPrefillRecovery — applyPrefillData 恢复 mcp_server context chip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatStoreState.composerClearNonceBySessionId = {}
    chatStoreState.composerDraftKeysPendingClearBySessionId = {}
  })

  it('只在 ACK nonce 递增后清空输入和发送时登记的原草稿键', () => {
    const { rerender, clearInputState } = setup()
    expect(clearInputState).not.toHaveBeenCalled()

    chatStoreState.composerDraftKeysPendingClearBySessionId = {
      s1: ['space:workspace-1'],
    }
    rerender()
    expect(clearInputState).not.toHaveBeenCalled()
    expect(draftMocks.clearDrafts).not.toHaveBeenCalled()

    chatStoreState.composerClearNonceBySessionId = { s1: 1 }
    rerender()

    expect(clearInputState).toHaveBeenCalledTimes(1)
    expect(draftMocks.clearDrafts).toHaveBeenCalledWith(['space:workspace-1'])
    expect(chatStoreState.clearComposerDraftKeysPendingClear).toHaveBeenCalledWith('s1')
  })

  it('contextBlocks 含 mcp_server 时：onAddContextRef 以 mcp_server / connection_id / server_name 调用，extra 含 meta', () => {
    const { result, onAddContextRef, setInput } = setup()

    act(() => {
      result.current.applyPrefillData({
        message: '帮我看下 issue',
        contextBlocks: [{ ...MCP_BLOCK }],
      })
    })

    expect(setInput).toHaveBeenCalledWith('帮我看下 issue')
    expect(onAddContextRef).toHaveBeenCalledTimes(1)
    const [type, resourceId, label, extra] = onAddContextRef.mock.calls[0]
    expect(type).toBe('mcp_server')
    expect(resourceId).toBe('conn-1')
    expect(label).toBe('github')
    expect(extra).toMatchObject({
      meta: { serverName: 'github', sourceLabel: 'Manual' },
    })
  })

  it('contextBlocks 同时含普通资源块与 mcp_server 块时两者都恢复，顺序保持', () => {
    const { result, onAddContextRef } = setup()

    act(() => {
      result.current.applyPrefillData({
        message: '结合这个网页和 MCP',
        contextBlocks: [
          { type: 'webpage', url: 'https://example.com', preview: 'Example', page_title: 'Example' },
          { ...MCP_BLOCK },
        ],
      })
    })

    expect(onAddContextRef).toHaveBeenCalledTimes(2)
    expect(onAddContextRef.mock.calls[0][0]).toBe('webpage')
    expect(onAddContextRef.mock.calls[0][1]).toBe('https://example.com')
    expect(onAddContextRef.mock.calls[1][0]).toBe('mcp_server')
    expect(onAddContextRef.mock.calls[1][1]).toBe('conn-1')
    expect(onAddContextRef.mock.calls[1][2]).toBe('github')
  })

  it.each([
    { name: 'contextBlocks 为空数组', contextBlocks: [] as Array<Record<string, unknown>> },
    { name: 'contextBlocks 为 undefined', contextBlocks: undefined },
  ])('$name 时不调用 onAddContextRef', ({ contextBlocks }) => {
    const { result, onAddContextRef } = setup()

    act(() => {
      result.current.applyPrefillData({ message: 'hello', contextBlocks })
    })

    expect(onAddContextRef).not.toHaveBeenCalled()
  })
})
