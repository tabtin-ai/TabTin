import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment, ContextRef } from '@components/chat/types'

const mockResolveSpaceId = vi.fn()
const mockNavigateToNewTask = vi.fn()
const mockOpenWebTab = vi.fn()

vi.mock('@/services/newTaskDraftNavigation', () => ({
  resolvePersonalNewTaskSpaceId: (...args: unknown[]) => mockResolveSpaceId(...args),
  navigateToNewTask: (...args: unknown[]) => mockNavigateToNewTask(...args),
}))

vi.mock('@/services/openWebTabInSpace', () => ({
  openWebTabInSpace: (...args: unknown[]) => mockOpenWebTab(...args),
}))

import { fallbackBrowserAnnotationToDraft } from '../browserAnnotationDraftFallback'
import { useContextInjectionStore } from '@stores/useContextInjectionStore'
import { usePendingComposerAttachmentsStore } from '@stores/usePendingComposerAttachmentsStore'
import { createContextRef } from '@components/chat/types'

function makeRef(): ContextRef {
  return createContextRef('web_annotation', 'https://example.com/', 'Example', {
    tabType: 'tabweb',
    meta: { preview: 'Selected text', url: 'https://example.com/' },
  })
}

function makeAttachment(id: string): ChatAttachment {
  return {
    id,
    file: new File([], `${id}.png`),
    filename: `${id}.png`,
    mimeType: 'image/png',
    size: 3,
    type: 'image',
    status: 'pending',
  }
}

describe('fallbackBrowserAnnotationToDraft', () => {
  beforeEach(() => {
    mockResolveSpaceId.mockReset().mockReturnValue('space-1')
    mockNavigateToNewTask.mockReset()
    mockOpenWebTab.mockReset().mockResolvedValue({ ok: true, viewId: 'v-1', crawlspaceId: 'cs-1' })
    useContextInjectionStore.setState({ activeScopeId: null, contextRefsByScopeId: {} })
    usePendingComposerAttachmentsStore.setState({ pendingByScopeId: {} })
  })

  it('进入新任务草稿并把引用写进草稿 composer scope', () => {
    const ref = makeRef()
    const ok = fallbackBrowserAnnotationToDraft({
      contextRef: ref,
      sourceUrl: 'https://example.com/',
      sourceTitle: 'Example',
    })

    expect(ok).toBe(true)
    expect(mockNavigateToNewTask).toHaveBeenCalledWith('space-1')

    const state = useContextInjectionStore.getState()
    expect(state.activeScopeId).toBe('__draft__:space-1')
    expect(state.contextRefsByScopeId['__draft__:space-1']).toHaveLength(1)
    expect(state.contextRefsByScopeId['__draft__:space-1'][0]).toMatchObject({
      type: 'web_annotation',
      resourceId: 'https://example.com/',
    })
  })

  it('在草稿对话 scope 按同 URL 重开页面（分屏）', () => {
    fallbackBrowserAnnotationToDraft({
      contextRef: makeRef(),
      sourceUrl: 'https://example.com/page',
      sourceTitle: 'Example Page',
    })

    expect(mockOpenWebTab).toHaveBeenCalledWith('space-1', 'https://example.com/page', {
      title: 'Example Page',
      tabScopeKey: 'conversation:draft:space-1',
    })
  })

  it('截图附件立即入队草稿 scope，由草稿 composer 领取（ live 回归）', () => {
    // 欢迎态 composer 的 scope 按全局 currentSessionId 解析（发首条消息前为
    // __draft__:{spaceId}）；prefetch 落 session 时**不得**迁走，否则 chip/附件消失。
    const attachment = makeAttachment('att-1')
    fallbackBrowserAnnotationToDraft({
      contextRef: makeRef(),
      attachment,
      sourceUrl: 'https://example.com/',
    })

    expect(
      usePendingComposerAttachmentsStore.getState().pendingByScopeId['__draft__:space-1']?.map(att => att.id),
    ).toEqual(['att-1'])
  })

  it('无附件时不入队', () => {
    fallbackBrowserAnnotationToDraft({
      contextRef: makeRef(),
      sourceUrl: 'https://example.com/',
    })

    expect(usePendingComposerAttachmentsStore.getState().pendingByScopeId['__draft__:space-1']).toBeUndefined()
  })

  it('找不到可用工作空间时不导航并返回 false', () => {
    mockResolveSpaceId.mockReturnValue(null)

    const ok = fallbackBrowserAnnotationToDraft({
      contextRef: makeRef(),
      sourceUrl: 'https://example.com/',
    })

    expect(ok).toBe(false)
    expect(mockNavigateToNewTask).not.toHaveBeenCalled()
    expect(mockOpenWebTab).not.toHaveBeenCalled()
  })

  it('分屏打开失败不影响引用注入结果', async () => {
    mockOpenWebTab.mockResolvedValue({ ok: false, error: 'createView 失败' })

    const ok = fallbackBrowserAnnotationToDraft({
      contextRef: makeRef(),
      sourceUrl: 'https://example.com/',
    })

    expect(ok).toBe(true)
    await Promise.resolve()
    expect(useContextInjectionStore.getState().contextRefsByScopeId['__draft__:space-1']).toHaveLength(1)
  })
})
