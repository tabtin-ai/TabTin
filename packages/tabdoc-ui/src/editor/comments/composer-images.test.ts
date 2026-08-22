import { describe, expect, it } from 'vitest'
import {
  MAX_COMMENT_IMAGES,
  canSubmitCommentComposer,
  clearCommentComposerImages,
  mergeCommentComposerImages,
  readyAttachmentIds,
  removeCommentComposerImage,
} from './composer-images'

function png(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

describe('comment composer images', () => {
  it('允许纯图片提交，正文与附件不能同时为空', () => {
    expect(canSubmitCommentComposer({ body: '', images: [] })).toBe(false)
    expect(canSubmitCommentComposer({
      body: '',
      images: [{
        localId: '1',
        file: png('a.png'),
        previewUrl: 'blob:a',
        status: 'ready',
        fileId: 'f1',
      }],
    })).toBe(true)
    expect(canSubmitCommentComposer({ body: 'hi', images: [] })).toBe(true)
    expect(canSubmitCommentComposer({
      body: 'hi',
      images: [{
        localId: '1',
        file: png('a.png'),
        previewUrl: 'blob:a',
        status: 'uploading',
      }],
    })).toBe(false)
  })

  it('最多 9 张，拒绝非图片', () => {
    const files = Array.from({ length: 10 }, (_, i) => png(`${i}.png`))
    files.push(new File(['x'], 'a.txt', { type: 'text/plain' }))
    const { next, rejected } = mergeCommentComposerImages([], files, () => 'blob:x')
    expect(next).toHaveLength(MAX_COMMENT_IMAGES)
    expect(rejected).toBe(2)
  })

  it('移除与 readyAttachmentIds', () => {
    const { next } = mergeCommentComposerImages([], [png('a.png'), png('b.png')], () => 'blob:x')
    const withReady = next.map((img, index) => (
      index === 0 ? { ...img, status: 'ready' as const, fileId: 'f1' } : img
    ))
    expect(readyAttachmentIds(withReady)).toEqual(['f1'])
    expect(removeCommentComposerImage(withReady, withReady[0]!.localId)).toHaveLength(1)
  })

  it('clearCommentComposerImages 清空全部草稿', () => {
    const { next } = mergeCommentComposerImages([], [png('a.png')], () => 'blob:x')
    expect(clearCommentComposerImages(next)).toEqual([])
  })
})
