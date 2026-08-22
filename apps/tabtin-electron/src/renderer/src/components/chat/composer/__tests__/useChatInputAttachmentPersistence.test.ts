import { describe, expect, it } from 'vitest'
import {
  prepareAttachmentForStash,
  resolveComposerAttachmentScopeId,
} from '../useChatInputAttachmentPersistence'
import type { ChatAttachment } from '../../types'

function makeAttachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
  return {
    id: 'att-1',
    file: new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }),
    filename: 'image.png',
    mimeType: 'image/png',
    size: 3,
    type: 'image',
    status: 'pending',
    previewUrl: 'blob:mock://image',
    ...overrides,
  }
}

describe('useChatInputAttachmentPersistence helpers', () => {
  it('resolveComposerAttachmentScopeId prefers presetScopeId', () => {
    expect(resolveComposerAttachmentScopeId('__draft__:space-1', 'session-1')).toBe('__draft__:space-1')
    expect(resolveComposerAttachmentScopeId(null, 'session-1')).toBe('session-1')
    expect(resolveComposerAttachmentScopeId(undefined, undefined)).toBeNull()
  })

  it('prepareAttachmentForStash resets uploading to pending for resume', () => {
    const uploading = makeAttachment({
      status: 'uploading',
      uploadProgress: 0.4,
      error: 'transient',
    })
    expect(prepareAttachmentForStash(uploading)).toEqual({
      ...uploading,
      status: 'pending',
      uploadProgress: undefined,
      error: undefined,
    })
  })

  it('prepareAttachmentForStash promotes fileId attachments to ready', () => {
    const midUploadButHasFileId = makeAttachment({
      status: 'uploading',
      uploadProgress: 0,
      fileId: 'fid-1',
      remoteUrl: 'https://cdn/x',
    })
    expect(prepareAttachmentForStash(midUploadButHasFileId)).toMatchObject({
      status: 'ready',
      uploadProgress: 1,
      fileId: 'fid-1',
      error: undefined,
    })
  })

  it('prepareAttachmentForStash keeps ready / pending / error as-is', () => {
    const ready = makeAttachment({
      status: 'ready',
      fileId: 'fid-1',
      remoteUrl: 'https://cdn/x',
      uploadProgress: 1,
    })
    const pending = makeAttachment({ status: 'pending' })
    const errored = makeAttachment({ status: 'error', error: 'fail' })
    expect(prepareAttachmentForStash(ready)).toBe(ready)
    expect(prepareAttachmentForStash(pending)).toBe(pending)
    expect(prepareAttachmentForStash(errored)).toBe(errored)
  })
})
