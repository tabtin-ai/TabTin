import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePendingComposerAttachmentsStore } from '../usePendingComposerAttachmentsStore'
import type { ChatAttachment } from '@/components/chat/types'

function makeAttachment(id: string, previewUrl?: string): ChatAttachment {
  return {
    id,
    file: new File([], `${id}.png`),
    filename: `${id}.png`,
    mimeType: 'image/png',
    size: 3,
    type: 'image',
    status: 'pending',
    previewUrl,
  }
}

describe('usePendingComposerAttachmentsStore', () => {
  // revokeAttachmentPreview 内部走 URL.revokeObjectURL
  const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

  beforeEach(() => {
    usePendingComposerAttachmentsStore.setState({ pendingByScopeId: {} })
    revokeSpy.mockClear()
  })

  it('enqueue 后 claim 取走并清空该 scope', () => {
    const store = usePendingComposerAttachmentsStore.getState()
    store.enqueue('session-1', makeAttachment('att-1'))
    store.enqueue('session-1', makeAttachment('att-2'))

    const claimed = usePendingComposerAttachmentsStore.getState().claim('session-1')
    expect(claimed.map(att => att.id)).toEqual(['att-1', 'att-2'])
    expect(usePendingComposerAttachmentsStore.getState().pendingByScopeId['session-1']).toBeUndefined()
    // 再 claim 为空
    expect(usePendingComposerAttachmentsStore.getState().claim('session-1')).toEqual([])
  })

  it('同 id 重复 enqueue 覆盖旧附件并回收旧预览 URL', () => {
    const store = usePendingComposerAttachmentsStore.getState()
    store.enqueue('session-1', makeAttachment('att-1', 'blob:old'))
    store.enqueue('session-1', makeAttachment('att-1', 'blob:new'))

    const claimed = usePendingComposerAttachmentsStore.getState().claim('session-1')
    expect(claimed).toHaveLength(1)
    expect(claimed[0].previewUrl).toBe('blob:new')
    expect(revokeSpy).toHaveBeenCalledWith('blob:old')
  })

  it('clearScope 清空并回收全部预览 URL', () => {
    const store = usePendingComposerAttachmentsStore.getState()
    store.enqueue('session-1', makeAttachment('att-1', 'blob:a'))
    store.enqueue('session-1', makeAttachment('att-2', 'blob:b'))
    store.clearScope('session-1')

    expect(usePendingComposerAttachmentsStore.getState().pendingByScopeId['session-1']).toBeUndefined()
    expect(revokeSpy).toHaveBeenCalledWith('blob:a')
    expect(revokeSpy).toHaveBeenCalledWith('blob:b')
  })
})
