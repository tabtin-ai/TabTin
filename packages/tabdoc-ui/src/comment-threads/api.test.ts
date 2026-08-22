import { describe, expect, it, vi } from 'vitest'
import type { AppHostClient } from '@tabtin/app-host-sdk'
import {
  confirmCommentAttachmentUpload,
  createDocumentCommentThread,
  createSharedCommentThread,
  deleteDocumentCommentThread,
  listDocumentCommentThreads,
  listSharedCommentThreads,
  normalizeCommentThread,
  presignCommentAttachmentUpload,
  presignSharedCommentAttachmentUpload,
  resolveDocumentCommentAttachmentPreview,
  resolveDocumentThreadAttachmentPreviews,
  resolveSharedCommentAttachmentPreview,
  isSignedCommentPreviewUrl,
} from './api'
import { COMMENT_THREADS_CAPABILITY, hasCommentThreadsCapability } from './types'

function mockClient(handler: (opts: any) => unknown): AppHostClient {
  return {
    request: vi.fn(async (opts: any) => handler(opts)),
  } as unknown as AppHostClient
}

describe('normalizeCommentThread', () => {
  it('从 anchor.selected_text 投影 selected_text', () => {
    const thread = normalizeCommentThread({
      id: 't1',
      document_id: 'd1',
      scope: 'text_range',
      status: 'open',
      anchor: { version: 1, selected_text: '引用' },
      anchor_status: 'attached',
      messages: [],
    })
    expect(thread.selected_text).toBe('引用')
  })
})

describe('comment thread API client', () => {
  it('list 返回 threads 与 capabilities', async () => {
    const client = mockClient(() => ({
      threads: [{
        id: 't1',
        document_id: 'd1',
        scope: 'document',
        status: 'open',
        anchor: {},
        anchor_status: 'none',
        messages: [],
      }],
      capabilities: [COMMENT_THREADS_CAPABILITY],
    }))
    const result = await listDocumentCommentThreads(client, 'd1')
    expect(result.threads).toHaveLength(1)
    expect(hasCommentThreadsCapability(result.capabilities)).toBe(true)
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      endpoint: '/tabdoc/documents/d1/comment-threads',
    }))
  })

  it('create 传递 body/attachment_ids/scope/anchor', async () => {
    const client = mockClient((opts) => {
      expect(opts.body).toMatchObject({
        body: 'hello',
        attachment_ids: ['f1'],
        scope: 'block',
        selected_text: '',
      })
      return {
        thread: {
          id: 't1',
          document_id: 'd1',
          scope: 'block',
          status: 'open',
          anchor: opts.body.anchor,
          anchor_status: 'attached',
          messages: [],
        },
      }
    })
    const thread = await createDocumentCommentThread(client, 'd1', {
      body: 'hello',
      attachment_ids: ['f1'],
      scope: 'block',
      anchor: { version: 1, block_ids: ['b1'] },
    })
    expect(thread.scope).toBe('block')
  })

  it('delete thread 删除整个评论线程', async () => {
    const client = mockClient(() => ({ deleted: true, thread_id: 't1' }))

    await deleteDocumentCommentThread(client, 'd1', 't1')

    expect(client.request).toHaveBeenCalledWith({
      method: 'DELETE',
      endpoint: '/tabdoc/documents/d1/comment-threads/t1',
    })
  })

  it('presign / confirm 附件上传', async () => {
    const client = mockClient((opts) => {
      if (String(opts.endpoint).includes('presign')) {
        return {
          upload_url: 'https://oss.example/put',
          upload_token: 'tok',
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          expires_in: 900,
        }
      }
      return {
        attachment: {
          file_id: 'file-1',
          type: 'image',
          metadata: { file_name: 'a.png', mime_type: 'image/png', file_size: 12 },
          preview_url: '/api/tabdoc/documents/d1/comment-attachments/file-1/preview',
        },
      }
    })
    const cred = await presignCommentAttachmentUpload(client, 'd1', {
      file_name: 'a.png',
      content_type: 'image/png',
      file_size: 12,
    })
    expect(cred.upload_token).toBe('tok')
    const confirmed = await confirmCommentAttachmentUpload(client, 'd1', 'tok')
    expect(confirmed.file_id).toBe('file-1')
    expect(confirmed.preview_url).toContain('/preview')
  })
})

describe('shared comment thread API client', () => {
  it('list 带 password query，并返回 capabilities', async () => {
    const client = mockClient(() => ({
      threads: [{
        id: 't1',
        document_id: 'd1',
        scope: 'document',
        status: 'open',
        anchor: {},
        anchor_status: 'none',
        messages: [],
      }],
      capabilities: [COMMENT_THREADS_CAPABILITY],
    }))
    const result = await listSharedCommentThreads(client, 'share-1', 'pw')
    expect(result.threads).toHaveLength(1)
    expect(hasCommentThreadsCapability(result.capabilities)).toBe(true)
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      endpoint: '/tabdoc/shared/share-1/comment-threads',
      params: { password: 'pw' },
    }))
  })

  it('create / presign 在 body 携带 password', async () => {
    const client = mockClient((opts) => {
      if (String(opts.endpoint).includes('presign')) {
        expect(opts.body).toMatchObject({ password: 'pw', file_name: 'a.png' })
        return {
          upload_url: 'https://oss.example/put',
          upload_token: 'tok',
          method: 'PUT',
          headers: {},
          expires_in: 60,
        }
      }
      expect(opts.body).toMatchObject({
        password: 'pw',
        body: 'hi',
        scope: 'text_range',
      })
      return {
        thread: {
          id: 't1',
          document_id: 'd1',
          scope: 'text_range',
          status: 'open',
          anchor: { version: 1 },
          anchor_status: 'attached',
          messages: [],
        },
      }
    })
    await createSharedCommentThread(client, 'share-1', {
      body: 'hi',
      scope: 'text_range',
      password: 'pw',
    })
    const cred = await presignSharedCommentAttachmentUpload(client, 'share-1', {
      file_name: 'a.png',
      content_type: 'image/png',
      file_size: 10,
      password: 'pw',
    })
    expect(cred.upload_token).toBe('tok')
  })

  it('resolve preview 走分享 POST 端点', async () => {
    const client = mockClient(() => ({
      preview_url: 'https://oss.example/signed',
      expires_in: 300,
    }))
    const url = await resolveSharedCommentAttachmentPreview(client, 'share-1', 'f1', 'pw')
    expect(url).toBe('https://oss.example/signed')
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      endpoint: '/tabdoc/shared/share-1/comment-attachments/f1/preview',
      body: { password: 'pw' },
    }))
  })

  it('resolve document preview 走 GET 并水合线程附件', async () => {
    expect(isSignedCommentPreviewUrl('/tabdoc/documents/d1/comment-attachments/f1/preview')).toBe(false)
    expect(isSignedCommentPreviewUrl('https://oss.example/signed')).toBe(true)

    const client = mockClient(() => ({
      preview_url: 'https://oss.example/signed',
      expires_in: 300,
    }))
    const url = await resolveDocumentCommentAttachmentPreview(client, 'd1', 'f1')
    expect(url).toBe('https://oss.example/signed')
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      endpoint: '/tabdoc/documents/d1/comment-attachments/f1/preview',
    }))

    const hydrated = await resolveDocumentThreadAttachmentPreviews(client, 'd1', [{
      id: 't1',
      document_id: 'd1',
      scope: 'document',
      status: 'open',
      anchor: { version: 1 },
      anchor_status: 'none',
      created_by_user_id: null,
      resolved_by_user_id: null,
      resolved_at: null,
      created_at: null,
      updated_at: null,
      messages: [{
        id: 'm1',
        thread_id: 't1',
        kind: 'root',
        author_name: 'u',
        author_user_id: null,
        author_avatar: null,
        author_account_name: null,
        body: '',
        mention_user_ids: [],
        client_request_id: null,
        is_deleted: false,
        attachments: [{
          id: 'a1',
          type: 'image',
          file_id: 'f1',
          metadata: {},
          preview_url: '/tabdoc/documents/d1/comment-attachments/f1/preview',
        }],
        created_at: null,
        updated_at: null,
      }],
    }])
    expect(hydrated[0]?.messages[0]?.attachments[0]?.preview_url).toBe('https://oss.example/signed')
  })
})
