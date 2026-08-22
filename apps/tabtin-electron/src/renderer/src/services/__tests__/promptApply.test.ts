import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  navigateToNewTask: vi.fn(),
  resolveDraftKey: vi.fn(() => 'conversation:draft:workspace-b'),
  setComposerDraftExternally: vi.fn(),
}))

vi.mock('@/utils/logger', () => {
  const stub = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  return {
    createLogger: () => stub,
    logger: stub,
  }
})

vi.mock('@/services/newTaskDraftNavigation', () => ({
  navigateToNewTask: mocks.navigateToNewTask,
}))

vi.mock('@components/chat/composer/chatInputDraft', () => ({
  resolveDraftKey: mocks.resolveDraftKey,
  setComposerDraftExternally: mocks.setComposerDraftExternally,
}))

vi.mock('@/i18n', () => ({
  default: {
    t: (key: string, fallback?: { defaultValue?: string }) => fallback?.defaultValue ?? key,
  },
}))

import { MAX_MESSAGE_CHARS } from '@components/chat/composer/chatInputConstants'
import { applyPromptToNewTask, preparePromptDraftText } from '../promptApply'

describe('preparePromptDraftText', () => {
  it('短文本原样返回且不标记截断', () => {
    const result = preparePromptDraftText('检查 release 分支的回归清单')
    expect(result.text).toBe('检查 release 分支的回归清单')
    expect(result.truncated).toBe(false)
  })

  it('恰好等于上限时不截断', () => {
    const input = 'a'.repeat(MAX_MESSAGE_CHARS)
    const result = preparePromptDraftText(input)
    expect(result.text).toBe(input)
    expect(result.truncated).toBe(false)
  })

  it('超过上限时截断到 MAX_MESSAGE_CHARS 并标记截断', () => {
    const input = 'b'.repeat(MAX_MESSAGE_CHARS + 100)
    const result = preparePromptDraftText(input)
    expect(result.text).toHaveLength(MAX_MESSAGE_CHARS)
    expect(result.text).toBe(input.slice(0, MAX_MESSAGE_CHARS))
    expect(result.truncated).toBe(true)
  })

  it('保留原文内容（含换行），不做 trim', () => {
    const input = '  第一行\n第二行  '
    const result = preparePromptDraftText(input)
    expect(result.text).toBe(input)
    expect(result.truncated).toBe(false)
  })
})

describe('applyPromptToNewTask', () => {
  it('只使用调用方明确选择的 Workspace 导航并写入对应草稿', () => {
    const result = applyPromptToNewTask('检查发布回归', 'workspace-b')

    expect(result).toEqual({ ok: true, spaceId: 'workspace-b' })
    expect(mocks.navigateToNewTask).toHaveBeenCalledWith('workspace-b', {
      executionWorkspaceId: 'workspace-b',
    })
    expect(mocks.resolveDraftKey).toHaveBeenCalledWith(null, 'workspace-b')
    expect(mocks.setComposerDraftExternally).toHaveBeenCalledWith(
      'conversation:draft:workspace-b',
      '检查发布回归',
    )
  })

  it('没有明确 Workspace 时不导航也不写草稿', () => {
    mocks.navigateToNewTask.mockClear()
    mocks.setComposerDraftExternally.mockClear()

    const result = applyPromptToNewTask('检查发布回归', '')

    expect(result.ok).toBe(false)
    expect(mocks.navigateToNewTask).not.toHaveBeenCalled()
    expect(mocks.setComposerDraftExternally).not.toHaveBeenCalled()
  })
})
