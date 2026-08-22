/**
 * comment_threads_v1 API client。
 * 旧 `/comments` 接口仍在 api-client.ts，签名不变。
 */
import type { AppHostClient } from '@tabtin/app-host-sdk'
import type {
  AddCommentMessageInput,
  CommentAttachmentConfirmResult,
  CommentAttachmentUploadCredential,
  CommentMessage,
  CommentThread,
  CreateCommentThreadInput,
  ListCommentThreadsResult,
  ReanchorCommentThreadInput,
} from './types'
import { COMMENT_THREADS_CAPABILITY, threadSelectedText } from './types'

function normalizeAnchor(raw: unknown): CommentThread['anchor'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: 1 }
  }
  const obj = raw as Record<string, unknown>
  const version = obj.version === 1 || obj.version === undefined ? 1 : obj.version
  return { ...obj, version } as CommentThread['anchor']
}

function normalizeAttachment(raw: any): CommentThread['messages'][number]['attachments'][number] {
  return {
    id: String(raw?.id ?? ''),
    type: raw?.type === 'file' ? 'file' : 'image',
    file_id: String(raw?.file_id ?? ''),
    metadata: (raw?.metadata && typeof raw.metadata === 'object') ? raw.metadata : {},
    preview_url: String(raw?.preview_url ?? ''),
  }
}

function normalizeMessage(raw: any): CommentMessage {
  return {
    id: String(raw?.id ?? ''),
    thread_id: String(raw?.thread_id ?? ''),
    kind: raw?.kind === 'root' ? 'root' : 'reply',
    author_name: String(raw?.author_name ?? ''),
    author_user_id: raw?.author_user_id ?? null,
    author_avatar: raw?.author_avatar ?? null,
    author_account_name: raw?.author_account_name ?? null,
    body: String(raw?.body ?? ''),
    mention_user_ids: Array.isArray(raw?.mention_user_ids)
      ? raw.mention_user_ids.map(String)
      : [],
    client_request_id: raw?.client_request_id ?? null,
    is_deleted: Boolean(raw?.is_deleted),
    attachments: Array.isArray(raw?.attachments)
      ? raw.attachments.map(normalizeAttachment)
      : [],
    created_at: raw?.created_at ?? null,
    updated_at: raw?.updated_at ?? null,
  }
}

export function normalizeCommentThread(raw: any): CommentThread {
  const anchor = normalizeAnchor(raw?.anchor)
  const thread: CommentThread = {
    id: String(raw?.id ?? ''),
    document_id: String(raw?.document_id ?? ''),
    scope: raw?.scope === 'text_range' || raw?.scope === 'block' ? raw.scope : 'document',
    status: raw?.status === 'resolved' ? 'resolved' : 'open',
    anchor,
    anchor_status: (() => {
      const status = String(raw?.anchor_status ?? 'none')
      if (status === 'attached' || status === 'orphaned' || status === 'detached' || status === 'none') {
        return status
      }
      return 'none'
    })(),
    created_by_user_id: raw?.created_by_user_id ?? null,
    resolved_by_user_id: raw?.resolved_by_user_id ?? null,
    resolved_at: raw?.resolved_at ?? null,
    created_at: raw?.created_at ?? null,
    updated_at: raw?.updated_at ?? null,
    messages: Array.isArray(raw?.messages) ? raw.messages.map(normalizeMessage) : [],
  }
  thread.selected_text = threadSelectedText(thread)
  return thread
}

export async function listDocumentCommentThreads(
  client: AppHostClient,
  documentId: string,
): Promise<ListCommentThreadsResult> {
  const result = await client.request<{
    threads?: unknown[]
    capabilities?: string[]
  }>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${documentId}/comment-threads`,
  })
  return {
    threads: Array.isArray(result.threads)
      ? result.threads.map(normalizeCommentThread)
      : [],
    capabilities: Array.isArray(result.capabilities)
      ? result.capabilities.map(String)
      : [COMMENT_THREADS_CAPABILITY],
  }
}

export async function createDocumentCommentThread(
  client: AppHostClient,
  documentId: string,
  input: CreateCommentThreadInput,
): Promise<CommentThread> {
  const result = await client.request<{ thread: unknown }>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/comment-threads`,
    body: {
      body: input.body ?? '',
      attachment_ids: input.attachment_ids ?? [],
      scope: input.scope ?? 'document',
      anchor: input.anchor ?? {},
      selected_text: input.selected_text ?? '',
      mention_user_ids: input.mention_user_ids ?? [],
      client_request_id: input.client_request_id,
      author_name: input.author_name ?? '',
    },
  })
  return normalizeCommentThread(result.thread)
}

export async function addDocumentCommentMessage(
  client: AppHostClient,
  documentId: string,
  threadId: string,
  input: AddCommentMessageInput,
): Promise<CommentMessage> {
  const result = await client.request<{ message: unknown }>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/comment-threads/${threadId}/messages`,
    body: {
      body: input.body ?? '',
      attachment_ids: input.attachment_ids ?? [],
      mention_user_ids: input.mention_user_ids ?? [],
      client_request_id: input.client_request_id,
      author_name: input.author_name ?? '',
    },
  })
  return normalizeMessage(result.message)
}

export async function updateDocumentCommentThreadStatus(
  client: AppHostClient,
  documentId: string,
  threadId: string,
  status: 'open' | 'resolved',
): Promise<CommentThread> {
  const result = await client.request<{ thread: unknown }>({
    method: 'PATCH',
    endpoint: `/tabdoc/documents/${documentId}/comment-threads/${threadId}/status`,
    body: { status },
  })
  return normalizeCommentThread(result.thread)
}

export async function reanchorDocumentCommentThread(
  client: AppHostClient,
  documentId: string,
  threadId: string,
  input: ReanchorCommentThreadInput,
): Promise<CommentThread> {
  const result = await client.request<{ thread: unknown }>({
    method: 'PATCH',
    endpoint: `/tabdoc/documents/${documentId}/comment-threads/${threadId}/anchor`,
    body: {
      scope: input.scope,
      anchor: input.anchor,
    },
  })
  return normalizeCommentThread(result.thread)
}

export async function deleteDocumentCommentMessage(
  client: AppHostClient,
  documentId: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  await client.request<{ deleted: boolean; message_id: string }>({
    method: 'DELETE',
    endpoint: `/tabdoc/documents/${documentId}/comment-threads/${threadId}/messages/${messageId}`,
  })
}

export async function deleteDocumentCommentThread(
  client: AppHostClient,
  documentId: string,
  threadId: string,
): Promise<void> {
  await client.request<{ deleted: boolean; thread_id: string }>({
    method: 'DELETE',
    endpoint: `/tabdoc/documents/${documentId}/comment-threads/${threadId}`,
  })
}

export async function presignCommentAttachmentUpload(
  client: AppHostClient,
  documentId: string,
  input: {
    file_name: string
    content_type: string
    file_size: number
  },
): Promise<CommentAttachmentUploadCredential> {
  const result = await client.request<CommentAttachmentUploadCredential>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/comment-attachments/presign-upload`,
    body: {
      file_name: input.file_name,
      content_type: input.content_type,
      file_size: input.file_size,
    },
  })
  return {
    upload_url: String(result.upload_url ?? ''),
    upload_token: String(result.upload_token ?? ''),
    method: String(result.method ?? 'PUT'),
    headers: (result.headers && typeof result.headers === 'object')
      ? result.headers as Record<string, string>
      : {},
    expires_in: Number(result.expires_in ?? 0),
  }
}

export async function confirmCommentAttachmentUpload(
  client: AppHostClient,
  documentId: string,
  uploadToken: string,
): Promise<CommentAttachmentConfirmResult> {
  const result = await client.request<{ attachment: CommentAttachmentConfirmResult }>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/comment-attachments/confirm-upload`,
    body: { upload_token: uploadToken },
  })
  const attachment = result.attachment
  return {
    file_id: String(attachment?.file_id ?? ''),
    type: attachment?.type === 'file' ? 'file' : 'image',
    metadata: (attachment?.metadata && typeof attachment.metadata === 'object')
      ? attachment.metadata
      : {},
    preview_url: String(attachment?.preview_url ?? ''),
  }
}

/** 预览走返回的鉴权路径；宿主需再调 resolve 拿到短时 OSS URL 才能给 <img>。 */
export function commentAttachmentPreviewEndpoint(
  documentId: string,
  fileId: string,
): string {
  return `/tabdoc/documents/${documentId}/comment-attachments/${fileId}/preview`
}

/** 文档侧 GET 预览，返回短时 OSS 签名 URL（需 JWT）。 */
export async function resolveDocumentCommentAttachmentPreview(
  client: AppHostClient,
  documentId: string,
  fileId: string,
): Promise<string> {
  const result = await client.request<{ preview_url?: string }>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${documentId}/comment-attachments/${fileId}/preview`,
  })
  return String(result.preview_url ?? '')
}

/** 已是可给 <img> 用的绝对地址时才算签名预览。 */
export function isSignedCommentPreviewUrl(url: string | null | undefined): boolean {
  return /^https?:\/\//i.test(String(url || '').trim())
}

/**
 * 把线程附件里的鉴权 preview path 解析成短时 OSS URL。
 * 绑定前（仅 confirm）的附件无法预览，会保留原值。
 */
export async function resolveDocumentThreadAttachmentPreviews(
  client: AppHostClient,
  documentId: string,
  threads: CommentThread[],
): Promise<CommentThread[]> {
  const cache = new Map<string, string>()

  const resolveOne = async (fileId: string, fallback: string): Promise<string> => {
    if (!fileId) return fallback
    if (isSignedCommentPreviewUrl(fallback)) return fallback
    const cached = cache.get(fileId)
    if (cached) return cached
    try {
      const signed = await resolveDocumentCommentAttachmentPreview(client, documentId, fileId)
      if (isSignedCommentPreviewUrl(signed)) {
        cache.set(fileId, signed)
        return signed
      }
    } catch {
      // 保持原 path，避免整批失败
    }
    return fallback
  }

  return Promise.all(threads.map(async (thread) => ({
    ...thread,
    messages: await Promise.all(thread.messages.map(async (message) => ({
      ...message,
      attachments: await Promise.all(message.attachments.map(async (attachment) => ({
        ...attachment,
        preview_url: await resolveOne(attachment.file_id, attachment.preview_url),
      }))),
    }))),
  })))
}

// ── 分享页对称 API（password 走 query / body，与 api_share 契约对齐）──

function withPasswordBody<T extends Record<string, unknown>>(
  body: T,
  password?: string,
): T & { password?: string } {
  if (!password) return body
  return { ...body, password }
}

export async function listSharedCommentThreads(
  client: AppHostClient,
  shareId: string,
  password?: string,
): Promise<ListCommentThreadsResult> {
  const result = await client.request<{
    threads?: unknown[]
    capabilities?: string[]
  }>({
    method: 'GET',
    endpoint: `/tabdoc/shared/${shareId}/comment-threads`,
    params: password ? { password } : undefined,
  })
  return {
    threads: Array.isArray(result.threads)
      ? result.threads.map(normalizeCommentThread)
      : [],
    capabilities: Array.isArray(result.capabilities)
      ? result.capabilities.map(String)
      : [COMMENT_THREADS_CAPABILITY],
  }
}

export async function createSharedCommentThread(
  client: AppHostClient,
  shareId: string,
  input: CreateCommentThreadInput & { password?: string },
): Promise<CommentThread> {
  const result = await client.request<{ thread: unknown }>({
    method: 'POST',
    endpoint: `/tabdoc/shared/${shareId}/comment-threads`,
    body: withPasswordBody({
      body: input.body ?? '',
      attachment_ids: input.attachment_ids ?? [],
      scope: input.scope ?? 'document',
      anchor: input.anchor ?? {},
      selected_text: input.selected_text ?? '',
      mention_user_ids: input.mention_user_ids ?? [],
      client_request_id: input.client_request_id,
      author_name: input.author_name ?? '',
    }, input.password),
  })
  return normalizeCommentThread(result.thread)
}

export async function addSharedCommentMessage(
  client: AppHostClient,
  shareId: string,
  threadId: string,
  input: AddCommentMessageInput & { password?: string },
): Promise<CommentMessage> {
  const result = await client.request<{ message: unknown }>({
    method: 'POST',
    endpoint: `/tabdoc/shared/${shareId}/comment-threads/${threadId}/messages`,
    body: withPasswordBody({
      body: input.body ?? '',
      attachment_ids: input.attachment_ids ?? [],
      mention_user_ids: input.mention_user_ids ?? [],
      client_request_id: input.client_request_id,
      author_name: input.author_name ?? '',
    }, input.password),
  })
  return normalizeMessage(result.message)
}

export async function updateSharedCommentThreadStatus(
  client: AppHostClient,
  shareId: string,
  threadId: string,
  status: 'open' | 'resolved',
  password?: string,
): Promise<CommentThread> {
  const result = await client.request<{ thread: unknown }>({
    method: 'PATCH',
    endpoint: `/tabdoc/shared/${shareId}/comment-threads/${threadId}/status`,
    body: withPasswordBody({ status }, password),
  })
  return normalizeCommentThread(result.thread)
}

export async function reanchorSharedCommentThread(
  client: AppHostClient,
  shareId: string,
  threadId: string,
  input: ReanchorCommentThreadInput & { password?: string },
): Promise<CommentThread> {
  const result = await client.request<{ thread: unknown }>({
    method: 'PATCH',
    endpoint: `/tabdoc/shared/${shareId}/comment-threads/${threadId}/anchor`,
    body: withPasswordBody({
      scope: input.scope,
      anchor: input.anchor,
    }, input.password),
  })
  return normalizeCommentThread(result.thread)
}

export async function deleteSharedCommentMessage(
  client: AppHostClient,
  shareId: string,
  threadId: string,
  messageId: string,
  password?: string,
): Promise<void> {
  await client.request<{ deleted: boolean; message_id: string }>({
    method: 'DELETE',
    endpoint: `/tabdoc/shared/${shareId}/comment-threads/${threadId}/messages/${messageId}`,
    // 密码只走 body，避免进 query / Referer
    body: withPasswordBody({}, password),
  })
}

export async function presignSharedCommentAttachmentUpload(
  client: AppHostClient,
  shareId: string,
  input: {
    file_name: string
    content_type: string
    file_size: number
    password?: string
  },
): Promise<CommentAttachmentUploadCredential> {
  const result = await client.request<CommentAttachmentUploadCredential>({
    method: 'POST',
    endpoint: `/tabdoc/shared/${shareId}/comment-attachments/presign-upload`,
    body: withPasswordBody({
      file_name: input.file_name,
      content_type: input.content_type,
      file_size: input.file_size,
    }, input.password),
  })
  return {
    upload_url: String(result.upload_url ?? ''),
    upload_token: String(result.upload_token ?? ''),
    method: String(result.method ?? 'PUT'),
    headers: (result.headers && typeof result.headers === 'object')
      ? result.headers as Record<string, string>
      : {},
    expires_in: Number(result.expires_in ?? 0),
  }
}

export async function confirmSharedCommentAttachmentUpload(
  client: AppHostClient,
  shareId: string,
  uploadToken: string,
  password?: string,
): Promise<CommentAttachmentConfirmResult> {
  const result = await client.request<{ attachment: CommentAttachmentConfirmResult }>({
    method: 'POST',
    endpoint: `/tabdoc/shared/${shareId}/comment-attachments/confirm-upload`,
    body: withPasswordBody({ upload_token: uploadToken }, password),
  })
  const attachment = result.attachment
  return {
    file_id: String(attachment?.file_id ?? ''),
    type: attachment?.type === 'file' ? 'file' : 'image',
    metadata: (attachment?.metadata && typeof attachment.metadata === 'object')
      ? attachment.metadata
      : {},
    preview_url: String(attachment?.preview_url ?? ''),
  }
}

/** 分享预览为 POST（可带 password），返回短时 OSS URL。 */
export async function resolveSharedCommentAttachmentPreview(
  client: AppHostClient,
  shareId: string,
  fileId: string,
  password?: string,
): Promise<string> {
  const result = await client.request<{ preview_url?: string }>({
    method: 'POST',
    endpoint: `/tabdoc/shared/${shareId}/comment-attachments/${fileId}/preview`,
    body: withPasswordBody({}, password),
  })
  return String(result.preview_url ?? '')
}

export function sharedCommentAttachmentPreviewEndpoint(
  shareId: string,
  fileId: string,
): string {
  return `/tabdoc/shared/${shareId}/comment-attachments/${fileId}/preview`
}
