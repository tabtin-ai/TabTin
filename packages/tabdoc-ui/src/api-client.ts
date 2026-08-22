/**
 * TabDoc API Client
 *
 * 所有 API 函数通过 AppHostClient.request() 调用后端，
 * URL 拼接、Token 注入、Envelope 解包由 SDK 统一处理。
 */
import type { AppHostClient } from '@tabtin/app-host-sdk'
import { recordProbeEvent } from '@tabtin/doc-editor'

export type FontStyle = 'default' | 'serif' | 'mono'

export interface TabdocDocument {
  id: string
  organization_id: string
  space_id: string
  parent_id: string | null
  title: string
  status: 'active' | 'archived'
  latest_version: number
  icon: string
  cover_image: string
  cover_position: number
  tags: string[]
  properties: Record<string, unknown>
  is_full_width: boolean
  font_style: FontStyle
  created_by: string | null
  updated_by: string | null
  created_at: string | null
  updated_at: string | null
  current_user_role?: 'owner' | 'admin' | 'editor' | 'viewer' | null
}

export interface TabdocContent {
  description_json: Record<string, unknown>
  description_markdown: string
  description_plaintext: string
}

export interface TabdocRevision {
  id: string
  document_id: string
  version: number
  content_pm_json: Record<string, unknown>
  content_markdown: string
  content_plaintext: string
  editor_id: string | null
  created_at: string | null
}

export interface TabdocVersion {
  id: string
  document_id: string
  version?: number | null
  description_markdown: string
  description_json: Record<string, unknown>
  description_plaintext: string
  last_saved_at: string | null
  created_by: string | null
  created_at: string | null
}

export interface TabdocHistoryItem {
  id: string
  document_id: string
  source: 'version' | 'revision'
  version: number
  version_id: string | null
  content_pm_json: Record<string, unknown>
  content_markdown: string
  content_plaintext: string
  editor_id: string | null
  created_by: string | null
  last_saved_at: string | null
  created_at: string | null
}

export interface TabdocRecoveryDraft {
  id: string
  document_id: string
  base_version: number | null
  status: 'active' | 'restored' | 'expired'
  created_at: string | null
  expires_at: string | null
  restored_at: string | null
  creator_id: string | null
}

export interface DocHistoryItem {
  id: string
  document_id: string
  is_snapshot: boolean
  editor_type: string
  editor_id: string
  expired_at: string | null
  created_at: string | null
  is_named: boolean
  name: string
  pinned: boolean
  extra?: Record<string, unknown>
  blob_size?: number
  editor_name?: string
  module?: string
}

export interface TabdocComment {
  id: string
  author_name: string
  author_user_id?: string | null
  author_avatar?: string | null
  author_account_name?: string | null
  selected_text?: string
  body: string
  mention_user_ids?: string[]
  created_at: string | null
}

export interface TabdocUserBrief {
  user_id: string
  nickname: string
  avatar?: string | null
  email: string
}

export interface TabdocCollaborator extends TabdocUserBrief {
  permission: 'viewer' | 'editor' | 'admin'
  created_at?: string | null
}

function toDocHistoryItem(input: any, documentId: string, fallbackName = ''): DocHistoryItem {
  return {
    id: input?.id || '',
    document_id: input?.document_id || documentId,
    is_snapshot: input?.is_snapshot ?? true,
    editor_type: input?.editor_type || '',
    editor_id: input?.editor_id || '',
    expired_at: input?.expired_at ?? null,
    created_at: input?.created_at ?? null,
    is_named: input?.is_named ?? false,
    name: input?.name || fallbackName,
    pinned: input?.pinned ?? false,
  }
}

interface ListDocumentsResponse {
  documents: TabdocDocument[]
  total: number
  page: number
  page_size: number
}

interface DocumentDetailResponse {
  document: TabdocDocument
  content: TabdocContent
  latest_revision: TabdocRevision | null
}

interface SaveContentResponse {
  document: TabdocDocument
  content: TabdocContent
  /**
   * NEW-002: force-close 失败时后端返回的协作同步警告。
   * "force_close_failed"：在线用户 Y.Doc 未被强制关闭，下次 onStore 可能覆盖恢复数据。
   */
  collab_sync_warning?: string
}

interface RecoveryDraftCreateResponse {
  recovery_draft: TabdocRecoveryDraft
}

interface RecoveryDraftListResponse {
  recovery_drafts: TabdocRecoveryDraft[]
}

interface RevisionsResponse {
  revisions: (TabdocVersion | TabdocRevision)[]
}

interface CommentsResponse {
  comments: TabdocComment[]
}

interface CreateCommentResponse {
  comment: TabdocComment
}

interface CollaboratorsResponse {
  owner: TabdocUserBrief
  collaborators: TabdocCollaborator[]
}

export interface TabdocSearchItem {
  document: TabdocDocument
  snippet: string
  relevance_score: number
  matched_on_title: boolean
}

interface SearchDocumentsResponse {
  items: TabdocSearchItem[]
  total: number
  page: number
  page_size: number
  total_pages: number
  query: string
}

function hasMeaningfulTabdocJson(descriptionJson: Record<string, unknown> | null | undefined): boolean {
  if (!descriptionJson || Object.keys(descriptionJson).length === 0) return false

  if (
    descriptionJson.type === 'doc'
    && (!Array.isArray(descriptionJson.content) || descriptionJson.content.length === 0)
    && Object.keys(descriptionJson).every((key) => key === 'type' || key === 'content')
  ) {
    return false
  }

  return true
}

function hasMeaningfulTabdocText(text: string | null | undefined): boolean {
  if (!text) return false
  const normalized = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, '')
  return normalized.length > 0
}

function classifyTabdocContentState(input: {
  descriptionJson: Record<string, unknown> | null | undefined
  descriptionMarkdown: string | null | undefined
  descriptionPlaintext: string | null | undefined
  currentVersion?: number | null
  latestRevisionVersion?: number | null
}): 'legacy_needs_fallback' | 'intentionally_empty' | 'has_primary_content' {
  if (
    hasMeaningfulTabdocJson(input.descriptionJson)
    || hasMeaningfulTabdocText(input.descriptionMarkdown)
    || Boolean(input.descriptionPlaintext?.trim())
  ) {
    return 'has_primary_content'
  }

  if (typeof input.latestRevisionVersion !== 'number') {
    return 'intentionally_empty'
  }

  const currentVersion = typeof input.currentVersion === 'number' ? input.currentVersion : 0
  // E2E-5: 使用 >= 而非 >，修复新建文档 (version=0, latestRevision=0) 被误判为 legacy_needs_fallback
  // currentVersion >= latestRevisionVersion 表示文档内容与最新修订版同步或更新，无需回退
  if (currentVersion >= input.latestRevisionVersion) {
    return 'intentionally_empty'
  }

  return 'legacy_needs_fallback'
}

/** 可选遗留上下文：仅在调用方显式提供时附带 space_id。 */
function optionalSpaceIdParam(spaceId?: string): Record<string, string> {
  const trimmed = typeof spaceId === 'string' ? spaceId.trim() : ''
  return trimmed ? { space_id: trimmed } : {}
}

export interface ListDocumentsResult {
  documents: TabdocDocument[]
  total: number
  page: number
  pageSize: number
}

export const listDocuments = async (
  client: AppHostClient,
  input: {
    organizationId: string
    /** 遗留可选上下文；不传则按 organization_id 列组织内文档 */
    spaceId?: string
    parentId?: string | null
    includeArchived?: boolean
    page?: number
    pageSize?: number
  },
): Promise<ListDocumentsResult> => {
  const params: Record<string, string> = {
    organization_id: input.organizationId,
    ...optionalSpaceIdParam(input.spaceId),
  }
  if (input.parentId) params.parent_id = input.parentId
  if (input.includeArchived) params.include_archived = 'true'
  if (input.page) params.page = String(input.page)
  if (input.pageSize) params.page_size = String(input.pageSize)

  const result = await client.request<ListDocumentsResponse>({
    method: 'GET',
    endpoint: '/tabdoc/documents',
    params,
  })
  return {
    documents: result.documents,
    total: result.total ?? result.documents.length,
    page: result.page ?? 1,
    pageSize: result.page_size ?? result.documents.length,
  }
}

export const getDocument = async (
  client: AppHostClient,
  documentId: string,
): Promise<DocumentDetailResponse> => {
  recordProbeEvent({
    component: 'http',
    event: 'http.request',
    docId: documentId,
    payload: { method: 'GET', endpoint: `/tabdoc/documents/${documentId}` },
  })
  const result = await client.request<DocumentDetailResponse>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${documentId}`,
  })
  recordProbeEvent({
    component: 'http',
    event: 'http.response',
    docId: documentId,
    payload: {
      endpoint: `/tabdoc/documents/${documentId}`,
      version: result.document?.latest_version,
    },
  })
  const contentState = classifyTabdocContentState({
    descriptionJson: result.content?.description_json,
    descriptionMarkdown: result.content?.description_markdown,
    descriptionPlaintext: result.content?.description_plaintext,
    currentVersion: result.document?.latest_version,
    latestRevisionVersion: typeof result.latest_revision?.version === 'number'
      ? result.latest_revision.version
      : null,
  })

  if (contentState === 'legacy_needs_fallback' && result.latest_revision) {
    result.content = {
      description_json: result.latest_revision.content_pm_json || {},
      description_markdown: result.latest_revision.content_markdown || '',
      description_plaintext: result.latest_revision.content_plaintext || '',
    }
  }
  return result
}

export const createDocument = async (
  client: AppHostClient,
  input: {
    organizationId: string
    parentId?: string | null
    collectionId?: string | null
    /**  ContextItem.parent；与 Document.parent / parentId 解耦 */
    parentItemId?: string | null
    title: string
    markdown?: string
    pmJson?: Record<string, unknown>
    plaintext?: string
    writeIntent?: 'replace'
  },
): Promise<DocumentDetailResponse> => {
  // ：创建 body 永不带 space_id
  return client.request<DocumentDetailResponse>({
    method: 'POST',
    endpoint: '/tabdoc/documents',
    body: {
      write_intent: input.writeIntent ?? 'replace',
      organization_id: input.organizationId,
      parent_id: input.parentId ?? null,
      collection_id: input.collectionId ?? null,
      parent_item_id: input.parentItemId ?? null,
      title: input.title,
      initial_content_pm_json: input.pmJson ?? {},
      initial_content_markdown: input.markdown ?? '',
      initial_content_plaintext: input.plaintext ?? '',
    },
  })
}

export const saveContent = async (
  client: AppHostClient,
  documentId: string,
  input: {
    baseVersion: number | null
    baseUpdatedAt?: string | null
    title?: string
    pmJson: Record<string, unknown>
    markdown: string
    plaintext?: string
  },
): Promise<SaveContentResponse> => {
  recordProbeEvent({
    component: 'http',
    event: 'http.request',
    docId: documentId,
    payload: {
      method: 'POST',
      endpoint: `/tabdoc/documents/${documentId}/content`,
      baseVersion: input.baseVersion,
      markdownLength: input.markdown.length,
    },
  })
  const result = await client.request<SaveContentResponse>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/content`,
    body: {
      base_version: input.baseVersion,
      base_updated_at: input.baseUpdatedAt ?? null,
      title: input.title,
      content_pm_json: input.pmJson,
      content_markdown: input.markdown,
      content_plaintext: input.plaintext ?? '',
    },
  })
  recordProbeEvent({
    component: 'http',
    event: 'http.response',
    docId: documentId,
    payload: {
      endpoint: `/tabdoc/documents/${documentId}/content`,
      version: result.document?.latest_version,
    },
  })
  return result
}

export const createRecoveryDraft = async (
  client: AppHostClient,
  documentId: string,
  input: {
    baseVersion: number | null
    pmJson: Record<string, unknown>
    markdown: string
    plaintext?: string
  },
): Promise<TabdocRecoveryDraft> => {
  const result = await client.request<RecoveryDraftCreateResponse>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/recovery-drafts`,
    body: {
      base_version: input.baseVersion,
      content_pm_json: input.pmJson,
      content_markdown: input.markdown,
      content_plaintext: input.plaintext ?? '',
    },
  })
  return result.recovery_draft
}

export const listRecoveryDrafts = async (
  client: AppHostClient,
  documentId: string,
): Promise<TabdocRecoveryDraft[]> => {
  const result = await client.request<RecoveryDraftListResponse>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${documentId}/recovery-drafts`,
  })
  return Array.isArray(result.recovery_drafts) ? result.recovery_drafts : []
}

export const restoreRecoveryDraft = async (
  client: AppHostClient,
  documentId: string,
  recoveryId: string,
  input: { baseVersion: number | null; baseUpdatedAt?: string | null },
): Promise<SaveContentResponse> => client.request<SaveContentResponse>({
  method: 'POST',
  endpoint: `/tabdoc/documents/${documentId}/recovery-drafts/${recoveryId}/restore`,
  body: {
    base_version: input.baseVersion,
    base_updated_at: input.baseUpdatedAt ?? null,
    confirm_replace: true,
  },
})

export const listDocumentComments = async (
  client: AppHostClient,
  documentId: string,
): Promise<TabdocComment[]> => {
  const result = await client.request<CommentsResponse>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${documentId}/comments`,
  })
  return Array.isArray(result.comments) ? result.comments : []
}

export const createDocumentComment = async (
  client: AppHostClient,
  documentId: string,
  body: string,
  mentionUserIds: string[] = [],
): Promise<TabdocComment> => {
  const result = await client.request<CreateCommentResponse>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/comments`,
    body: { body, mention_user_ids: mentionUserIds },
  })
  return result.comment
}

export const deleteDocumentComment = async (
  client: AppHostClient,
  documentId: string,
  commentId: string,
): Promise<void> => {
  await client.request<{ deleted: boolean, comment_id: string }>({
    method: 'DELETE',
    endpoint: `/tabdoc/documents/${documentId}/comments/${commentId}`,
  })
}

export const listDocumentCollaborators = async (
  client: AppHostClient,
  documentId: string,
): Promise<CollaboratorsResponse> => {
  return client.request<CollaboratorsResponse>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${documentId}/collaborators`,
  })
}

export const listRevisions = async (
  client: AppHostClient,
  documentId: string,
  limit = 20,
  latestVersionHint?: number,
): Promise<TabdocHistoryItem[]> => {
  const result = await client.request<RevisionsResponse>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${documentId}/revisions`,
    params: { limit: Math.max(1, limit) },
  })

  const items = Array.isArray(result.revisions) ? result.revisions : []
  return normalizeHistoryItems(items, latestVersionHint)
}

export const restoreRevision = async (
  client: AppHostClient,
  documentId: string,
  params: {
    version?: number
    versionId?: string
    baseVersion?: number | null
    baseUpdatedAt?: string | null
  },
): Promise<SaveContentResponse> => {
  return client.request<SaveContentResponse>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/restore`,
    body: {
      version: params.version,
      version_id: params.versionId,
      base_version: params.baseVersion,
      base_updated_at: params.baseUpdatedAt,
    },
  })
}

const isDocumentVersion = (item: TabdocVersion | TabdocRevision): item is TabdocVersion => {
  return Object.prototype.hasOwnProperty.call(item, 'description_json')
}

const normalizeHistoryItems = (
  items: (TabdocVersion | TabdocRevision)[],
  latestVersionHint?: number,
): TabdocHistoryItem[] => {
  const safeLatestVersion = Number.isFinite(latestVersionHint) && (latestVersionHint ?? 0) > 0
    ? Number(latestVersionHint)
    : null

  return items.map((item, index) => {
    if (isDocumentVersion(item)) {
      const backendVersion = typeof item.version === 'number' ? item.version : null
      const inferredVersion = safeLatestVersion !== null
        ? Math.max(1, safeLatestVersion - index)
        : Math.max(1, items.length - index)

      return {
        id: item.id,
        document_id: item.document_id,
        source: 'version',
        version: backendVersion ?? inferredVersion,
        version_id: item.id,
        content_pm_json: item.description_json || {},
        content_markdown: item.description_markdown || '',
        content_plaintext: item.description_plaintext || '',
        editor_id: null,
        created_by: item.created_by,
        last_saved_at: item.last_saved_at,
        created_at: item.created_at || item.last_saved_at,
      }
    }

    return {
      id: item.id,
      document_id: item.document_id,
      source: 'revision',
      version: item.version,
      version_id: null,
      content_pm_json: item.content_pm_json || {},
      content_markdown: item.content_markdown || '',
      content_plaintext: item.content_plaintext || '',
      editor_id: item.editor_id,
      created_by: null,
      last_saved_at: item.created_at,
      created_at: item.created_at,
    }
  })
}

export const searchDocuments = async (
  client: AppHostClient,
  input: {
    organizationId: string
    /** 遗留可选上下文；不传则按 organization_id 检索 */
    spaceId?: string
    q: string
    page?: number
    pageSize?: number
  },
): Promise<SearchDocumentsResponse> => {
  return client.request<SearchDocumentsResponse>({
    method: 'GET',
    endpoint: '/tabdoc/search',
    params: {
      organization_id: input.organizationId,
      ...optionalSpaceIdParam(input.spaceId),
      q: input.q,
      page: Math.max(1, input.page ?? 1),
      page_size: Math.max(1, input.pageSize ?? 10),
    },
  })
}

export type ExportFormat = 'markdown' | 'html' | 'txt' | 'docx' | 'pdf'

export interface ExportTextResult {
  content: string
  format: string
  filename: string
  mime_type: string
}

/**
 * 从 Content-Disposition 解析文件名。
 * 优先 RFC 5987 的 filename*（携带完整 UTF-8 文件名，如中文标题），回退普通
 * filename。解析不出时返回 null，由调用方决定默认值。
 */
export const parseContentDispositionFilename = (disposition: string): string | null => {
  const starMatch = disposition.match(/filename\*=(?:UTF-8'')?([^"';\n]+)/i)
  const plainMatch = disposition.match(/filename="([^"]*)"/i)
    ?? disposition.match(/filename=([^;\n]+)/i)
  const raw = starMatch?.[1] ?? plainMatch?.[1]
  if (!raw) return null
  const trimmed = raw.trim()
  try {
    return decodeURIComponent(trimmed)
  } catch {
    return trimmed
  }
}

export const exportDocument = async (
  client: AppHostClient,
  documentId: string,
  format: Exclude<ExportFormat, 'docx' | 'pdf'> = 'markdown',
): Promise<ExportTextResult> => {
  // BIZ-049: 统一使用 encodeURIComponent，与 exportDocumentBlob 一致
  return client.request<ExportTextResult>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${encodeURIComponent(documentId)}/export`,
    params: { format },
  })
}

const readExportErrorMessage = async (resp: Response): Promise<string> => {
  const text = await resp.text().catch(() => '')
  if (!text) return `Export failed: HTTP ${resp.status}`

  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>
      const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : null
      const candidates = [data?.detail, body.detail, body.message]
      const message = candidates.find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0,
      )
      if (message) return message
    }
  } catch {
    // Non-JSON error bodies are still useful diagnostic text.
  }

  return text
}

/**
 * UI-13: 导出文档为 Blob（如 DOCX/PDF）。
 * 因 AppHostClient.request() 不支持 blob 响应类型，此处使用原生 fetch，
 * 但添加了 401 Token 刷新重试逻辑，确保 Token 过期时不会直接失败。
 * documentId 使用 encodeURIComponent 防止特殊字符注入 URL。
 */
export const exportDocumentBlob = async (
  client: AppHostClient,
  documentId: string,
  format: 'docx' | 'pdf',
): Promise<{ blob: Blob; filename: string }> => {
  const baseUrl = client.getBaseApiUrl().replace(/\/$/, '')
  const url = `${baseUrl}/tabdoc/documents/${encodeURIComponent(documentId)}/export?format=${format}`

  const doFetch = async (token: string | null): Promise<Response> => {
    return fetch(url, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(60_000),
    })
  }

  // BIZ-050: 检查 token 是否为 null，null 时跳过 Authorization header
  let token = await client.getAccessToken()
  if (!token) {
    throw new Error('Unable to obtain access token for export')
  }
  let resp = await doFetch(token)

  // Token 过期时刷新并重试一次（区分 token 过期 vs 无权限）
  if (resp.status === 401) {
    token = await client.getAccessToken()
    if (!token) {
      throw new Error('Token refresh failed, unable to export')
    }
    resp = await doFetch(token)
  }

  if (!resp.ok) {
    throw new Error(await readExportErrorMessage(resp))
  }

  const disposition = resp.headers.get('Content-Disposition') || ''
  const filename = parseContentDispositionFilename(disposition) ?? `document.${format}`

  const blob = await resp.blob()
  return { blob, filename }
}

export const listHistories = async (
  client: AppHostClient,
  documentId: string,
  limit = 50,
): Promise<DocHistoryItem[]> => {
  const result = await client.request<{ histories: any[] }>({
    method: 'GET',
    endpoint: `/tabdoc/documents/${documentId}/histories`,
    params: { limit: Math.max(1, limit) },
  })
  const items = Array.isArray(result.histories) ? result.histories : []
  return items.map((item: any) => toDocHistoryItem(item, documentId))
}

export class HistoryPreviewUnavailableError extends Error {
  readonly hint: string
  readonly documentId: string
  readonly historyId: string

  constructor(input: {
    hint: string
    documentId: string
    historyId: string
    cause?: unknown
  }) {
    super('history preview upstream unavailable')
    this.name = 'HistoryPreviewUnavailableError'
    this.hint = input.hint
    this.documentId = input.documentId
    this.historyId = input.historyId
    if (input.cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = input.cause
    }
  }
}

function isHistoryPreviewUpstreamUnavailableError(err: unknown): err is Error & {
  status?: number
  statusCode?: number
  code?: string
  data?: {
    hint?: unknown
    document_id?: unknown
    history_id?: unknown
  }
} {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    status?: unknown
    statusCode?: unknown
    code?: unknown
  }
  return (
    (e.status === 503 || e.statusCode === 503) &&
    e.code === 'UPSTREAM_UNAVAILABLE'
  )
}

export const getHistoryPreviewMarkdown = async (
  client: AppHostClient,
  documentId: string,
  historyId: string,
): Promise<string | null> => {
  try {
    const result = await client.request<{ markdown?: string | null }>({
      method: 'GET',
      endpoint: `/tabdoc/documents/${documentId}/histories/${historyId}/preview`,
    })
    return result.markdown ?? null
  } catch (err) {
    if (isHistoryPreviewUpstreamUnavailableError(err)) {
      throw new HistoryPreviewUnavailableError({
        hint: typeof err.data?.hint === 'string' && err.data.hint
          ? err.data.hint
          : '该版本预览暂不可用，请稍后重试',
        documentId: typeof err.data?.document_id === 'string' && err.data.document_id
          ? err.data.document_id
          : documentId,
        historyId: typeof err.data?.history_id === 'string' && err.data.history_id
          ? err.data.history_id
          : historyId,
        cause: err,
      })
    }
    throw err
  }
}

export const restoreHistory = async (
  client: AppHostClient,
  documentId: string,
  historyId: string,
  input?: {
    baseVersion?: number | null
    baseUpdatedAt?: string | null
  },
): Promise<SaveContentResponse> => {
  const result = await client.request<SaveContentResponse>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/restore-history`,
    body: {
      history_id: historyId,
      base_version: input?.baseVersion,
      base_updated_at: input?.baseUpdatedAt,
    },
  })
  return result
}

export const createNamedVersion = async (
  client: AppHostClient,
  documentId: string,
  name = '',
  input?: {
    baseVersion?: number | null
    baseUpdatedAt?: string | null
  },
): Promise<DocHistoryItem> => {
  const result = await client.request<{ version: any }>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/versions`,
    body: {
      name,
      base_version: input?.baseVersion,
      base_updated_at: input?.baseUpdatedAt,
    },
  })
  return toDocHistoryItem(result.version, documentId, name)
}

export const renameVersion = async (
  client: AppHostClient,
  documentId: string,
  versionId: string,
  name: string,
): Promise<DocHistoryItem> => {
  const result = await client.request<{ version: any }>({
    method: 'PATCH',
    endpoint: `/tabdoc/documents/${documentId}/versions/${versionId}`,
    body: { name },
  })
  return toDocHistoryItem(result.version, documentId, name)
}

export const deleteNamedVersion = async (
  client: AppHostClient,
  documentId: string,
  versionId: string,
): Promise<void> => {
  await client.request<{ deleted: boolean }>({
    method: 'DELETE',
    endpoint: `/tabdoc/documents/${documentId}/versions/${versionId}`,
  })
}

export const archiveDocument = async (
  client: AppHostClient,
  documentId: string,
): Promise<void> => {
  await client.request<{ archived: boolean }>({
    method: 'DELETE',
    endpoint: `/tabdoc/documents/${documentId}`,
  })
}

export const trashDocument = async (
  client: AppHostClient,
  documentId: string,
): Promise<void> => {
  await client.request<{ document: unknown }>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/trash`,
  })
}

export const restoreDocumentFromTrash = async (
  client: AppHostClient,
  documentId: string,
): Promise<void> => {
  await client.request<{ document: unknown }>({
    method: 'POST',
    endpoint: `/tabdoc/documents/${documentId}/restore-from-trash`,
  })
}

export const importMarkdown = async (
  client: AppHostClient,
  input: {
    organizationId: string
    /** 遗留可选上下文 */
    spaceId?: string
    markdown: string
  },
): Promise<ImportDocumentFileDraftResult> => {
  const result = await client.request<{ pm_json: Record<string, unknown>; markdown: string; plaintext: string }>({
    method: 'POST',
    endpoint: '/tabdoc/import/markdown',
    body: {
      organization_id: input.organizationId,
      ...optionalSpaceIdParam(input.spaceId),
      markdown: input.markdown,
    },
  })
  return {
    pmJson: result.pm_json ?? {},
    markdown: result.markdown ?? '',
    plaintext: result.plaintext ?? '',
    title: '',
    totalPages: 0,
    skippedImages: 0,
    uploadedImages: 0,
  }
}

export interface ImportDocumentFileDraftResult {
  pmJson: Record<string, unknown>
  markdown: string
  plaintext: string
  title: string
  totalPages: number
  skippedImages: number
  uploadedImages: number
}

export type ImportDocumentJobStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'ready'
  | 'partial_ready'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

export interface ImportDocumentJob {
  id: string
  file_record_id: string
  parsed_document_id: string | null
  status: ImportDocumentJobStatus
  stage: string
  total_pages: number
  processed_pages: number
  failed_pages: number
  retry_count: number
  error_code: string
  error_message: string
  result_available: boolean
}

const IMPORT_JOB_TERMINAL_STATUSES = new Set<ImportDocumentJobStatus>([
  'ready',
  'partial_ready',
  'failed',
  'interrupted',
  'cancelled',
])
const DEFAULT_IMPORT_JOB_TIMEOUT_MS = 10 * 60 * 1000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function importJobStorageKey(input: {
  organizationId: string
  spaceId?: string
  fileRecordId: string
}): string {
  const spacePart = input.spaceId?.trim() || '_'
  return `tabdoc:import-job:${input.organizationId}:${spacePart}:${input.fileRecordId}`
}

function rememberImportJob(key: string, jobId: string): void {
  try {
    window.localStorage?.setItem(key, jobId)
  } catch {
    // localStorage is best-effort; polling still works in the current session.
  }
}

function loadRememberedImportJob(key: string): string {
  try {
    return window.localStorage?.getItem(key) || ''
  } catch {
    return ''
  }
}

function forgetImportJob(key: string): void {
  try {
    window.localStorage?.removeItem(key)
  } catch {
    // best-effort cleanup
  }
}

export const createImportDocumentFileJob = async (
  client: AppHostClient,
  input: {
    organizationId: string
    /** 遗留可选上下文 */
    spaceId?: string
    fileRecordId: string
  },
): Promise<{ job: ImportDocumentJob; created: boolean }> => {
  return client.request<{ job: ImportDocumentJob; created: boolean }>({
    method: 'POST',
    endpoint: '/tabdoc/import/jobs',
    expectedStatus: [200, 202],
    body: {
      organization_id: input.organizationId,
      ...optionalSpaceIdParam(input.spaceId),
      file_record_id: input.fileRecordId,
    },
  })
}

export const getImportDocumentFileJob = async (
  client: AppHostClient,
  jobId: string,
): Promise<ImportDocumentJob> => {
  const result = await client.request<{ job: ImportDocumentJob }>({
    method: 'GET',
    endpoint: `/tabdoc/import/jobs/${jobId}`,
  })
  return result.job
}

export const getImportDocumentFileJobResult = async (
  client: AppHostClient,
  jobId: string,
): Promise<ImportDocumentFileDraftResult> => {
  const result = await client.request<{
    job: ImportDocumentJob & {
      result_payload?: {
      pm_json?: Record<string, unknown>
      markdown?: string
      plaintext?: string
      title?: string
      total_pages?: number
      skipped_images?: number
      uploaded_images?: number
      omitted?: boolean
      reason?: string
    }
    }
  }>({
    method: 'GET',
    endpoint: `/tabdoc/import/jobs/${jobId}/result`,
  })
  const payload = result.job.result_payload ?? {}
  if (payload.omitted) {
    throw new Error(payload.reason || 'import result is too large')
  }
  return {
    pmJson: payload.pm_json ?? {},
    markdown: payload.markdown ?? '',
    plaintext: payload.plaintext ?? '',
    title: payload.title ?? '',
    totalPages: payload.total_pages ?? result.job.total_pages ?? 0,
    skippedImages: payload.skipped_images ?? 0,
    uploadedImages: payload.uploaded_images ?? 0,
  }
}

export const waitForImportDocumentFileJob = async (
  client: AppHostClient,
  jobId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ImportDocumentJob> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMPORT_JOB_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? 1_000
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const job = await getImportDocumentFileJob(client, jobId)
    if (IMPORT_JOB_TERMINAL_STATUSES.has(job.status)) {
      return job
    }
    await sleep(intervalMs)
  }
  throw new Error('import job polling timed out')
}

export const importDocumentFileDraft = async (
  client: AppHostClient,
  input: {
    organizationId: string
    /** 遗留可选上下文 */
    spaceId?: string
    fileRecordId: string
  },
): Promise<ImportDocumentFileDraftResult> => {
  const storageKey = importJobStorageKey({
    organizationId: input.organizationId,
    spaceId: input.spaceId,
    fileRecordId: input.fileRecordId,
  })
  const rememberedJobId = loadRememberedImportJob(storageKey)
  if (rememberedJobId) {
    try {
      const remembered = await waitForImportDocumentFileJob(client, rememberedJobId)
      if (remembered.status === 'ready' || remembered.status === 'partial_ready') {
        const result = await getImportDocumentFileJobResult(client, rememberedJobId)
        forgetImportJob(storageKey)
        return result
      }
      if (remembered.status === 'failed' || remembered.status === 'interrupted' || remembered.status === 'cancelled') {
        forgetImportJob(storageKey)
      }
    } catch {
      forgetImportJob(storageKey)
    }
  }
  const { job } = await createImportDocumentFileJob(client, input)
  rememberImportJob(storageKey, job.id)
  const completed = await waitForImportDocumentFileJob(client, job.id)
  if (completed.status === 'ready' || completed.status === 'partial_ready') {
    const result = await getImportDocumentFileJobResult(client, job.id)
    forgetImportJob(storageKey)
    return result
  }
  forgetImportJob(storageKey)
  throw new Error(completed.error_message || `import job ${completed.status}`)
}

export const updateDocument = async (
  client: AppHostClient,
  documentId: string,
  input: {
    baseVersion?: number | null
    baseUpdatedAt?: string | null
    title?: string
    parentId?: string | null
    status?: 'active' | 'archived'
    icon?: string
    cover_image?: string
    cover_position?: number
    tags?: string[]
    properties?: Record<string, unknown>
    is_full_width?: boolean
    font_style?: 'default' | 'serif' | 'mono'
  },
): Promise<TabdocDocument> => {
  const result = await client.request<{ document: TabdocDocument }>({
    method: 'PATCH',
    endpoint: `/tabdoc/documents/${documentId}`,
    body: {
      base_version: input.baseVersion,
      base_updated_at: input.baseUpdatedAt,
      title: input.title,
      parent_id: input.parentId,
      status: input.status,
      icon: input.icon,
      cover_image: input.cover_image,
      cover_position: input.cover_position,
      tags: input.tags,
      properties: input.properties,
      is_full_width: input.is_full_width,
      font_style: input.font_style,
    },
  })
  return result.document
}

/**  HTML 块「在浏览器打开」链接上下文：继承文档权限，无独立分享 */
export interface HtmlBlockBrowserLink {
  document_id: string
  block_id: string
  /** 当前文档有效 DocumentShare id；未分享时为 null */
  share_id: string | null
  /**
   * 协作未落库时服务端回传的 fileId 短期 hint（与请求传入的 fileId 一致）；
   * 已落库时可空。
   */
  file_id_hint?: string | null
}

// ── comment_threads_v1（旁路模块再 export，旧 comments API 签名不变）──
export {
  COMMENT_THREADS_CAPABILITY,
  hasCommentThreadsCapability,
  isAnchorDetached,
  threadSelectedText,
  addDocumentCommentMessage,
  addSharedCommentMessage,
  commentAttachmentPreviewEndpoint,
  confirmCommentAttachmentUpload,
  confirmSharedCommentAttachmentUpload,
  createDocumentCommentThread,
  createSharedCommentThread,
  deleteDocumentCommentThread,
  deleteDocumentCommentMessage,
  deleteSharedCommentMessage,
  listDocumentCommentThreads,
  listSharedCommentThreads,
  normalizeCommentThread,
  presignCommentAttachmentUpload,
  presignSharedCommentAttachmentUpload,
  reanchorDocumentCommentThread,
  reanchorSharedCommentThread,
  isSignedCommentPreviewUrl,
  resolveDocumentCommentAttachmentPreview,
  resolveDocumentThreadAttachmentPreviews,
  resolveSharedCommentAttachmentPreview,
  sharedCommentAttachmentPreviewEndpoint,
  updateDocumentCommentThreadStatus,
  updateSharedCommentThreadStatus,
  filterAnchoredCommentThreads,
  filterCommentThreads,
  filterDocumentScopeCommentThreads,
  partitionDetachedThreads,
  COMMENT_RAIL_BREAKPOINT_PX,
  COMMENT_RAIL_WIDTH_PX,
  resolveCommentRailLayout,
  shouldCollapseOutlineForComments,
} from './comment-threads'
export type {
  AddCommentMessageInput,
  CommentAnchorStatus,
  CommentAnchorV1,
  CommentAttachment,
  CommentAttachmentConfirmResult,
  CommentAttachmentType,
  CommentAttachmentUploadCredential,
  CommentMessage,
  CommentMessageKind,
  CommentRailLayoutMode,
  CommentThread,
  CommentThreadScope,
  CommentThreadStatus,
  CommentThreadStatusFilter,
  CreateCommentThreadInput,
  ListCommentThreadsResult,
  ReanchorCommentThreadInput,
} from './comment-threads'

export const getHtmlBlockBrowserLink = async (
  client: AppHostClient,
  documentId: string,
  blockId: string,
  fileId?: string | null,
): Promise<HtmlBlockBrowserLink> => {
  const params = new URLSearchParams()
  const trimmedFileId = typeof fileId === 'string' ? fileId.trim() : ''
  if (trimmedFileId) params.set('file_id', trimmedFileId)
  const query = params.toString()
  const result = await client.request<HtmlBlockBrowserLink>({
    method: 'GET',
    endpoint:
      `/tabdoc/documents/${documentId}/html-blocks/${encodeURIComponent(blockId)}/browser-link` +
      (query ? `?${query}` : ''),
  })
  if (!result?.document_id || !result?.block_id) {
    throw new Error('html block browser-link response missing document_id/block_id')
  }
  return {
    document_id: result.document_id,
    block_id: result.block_id,
    share_id: result.share_id ?? null,
    file_id_hint: result.file_id_hint ?? (trimmedFileId || null),
  }
}
