import { getApiClient } from './tabtin-client'

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
  font_style: 'default' | 'serif' | 'mono'
  created_by: string | null
  updated_by: string | null
  created_at: string | null
  updated_at: string | null
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
  source?: 'version' | 'revision'
  version_id?: string | null
}

interface TabdocVersionEntry {
  id: string
  document_id: string
  version: number | null
  description_markdown: string
  description_json: Record<string, unknown>
  description_plaintext: string
  last_saved_at: string | null
  created_by: string | null
  created_at: string | null
}

export interface TabdocPermissionEntry {
  id: string
  document_id: string
  subject_type: 'user' | 'role' | string
  subject_id: string
  permission: 'viewer' | 'editor' | 'admin' | string
  is_active: boolean
  created_by: string | null
  created_at: string | null
  updated_at: string | null
}

export interface TabdocPermissionInput {
  subject_type: 'user' | 'role'
  subject_id: string
  permission: 'viewer' | 'editor' | 'admin'
  is_active?: boolean
}

export interface TabdocMetricsSummary {
  save: {
    attempts: number
    successes: number
    conflicts: number
    failures: number
    success_rate: number
  }
  search: {
    requests: number
    avg_latency_ms: number
    p95_latency_ms: number
  }
  import: {
    attempts: number
    successes: number
    failures: number
    failure_rate: number
  }
}

export interface TabdocSearchItem {
  document: TabdocDocument
  snippet: string
  relevance_score: number
  matched_on_title: boolean
}

interface ListDocumentsResponse {
  documents: TabdocDocument[]
}

interface BackendDocumentDetailResponse {
  document: TabdocDocument
  content?: TabdocContent
  latest_revision?: TabdocRevision | null
}

export interface DocumentDetailResponse {
  document: TabdocDocument
  content: TabdocContent
  latest_revision: TabdocRevision | null
}

interface BackendSaveContentResponse {
  document: TabdocDocument
  content?: TabdocContent
}

export interface SaveContentResponse {
  document: TabdocDocument
  revision: TabdocRevision
}

interface RevisionsResponse {
  revisions: Array<TabdocRevision | TabdocVersionEntry>
}

interface SearchDocumentsResponse {
  items: TabdocSearchItem[]
  total: number
  page: number
  page_size: number
  total_pages: number
  query: string
}

interface ImportMarkdownResponse {
  pm_json: Record<string, unknown>
  markdown: string
  plaintext: string
}

interface ExportDocumentResponse {
  format: 'markdown' | 'html'
  content: string
  mime_type: string
  filename: string
}

interface PermissionsResponse {
  entries: TabdocPermissionEntry[]
}

const normalizeContent = (content?: TabdocContent | null): TabdocContent => ({
  description_json: content?.description_json ?? {},
  description_markdown: content?.description_markdown ?? '',
  description_plaintext: content?.description_plaintext ?? '',
})

const buildSyntheticRevisionId = (documentId: string, version: number): string =>
  `${documentId}:v${Math.max(1, version)}`

const toDocumentRevision = (
  document: TabdocDocument,
  content: TabdocContent,
  revision?: TabdocRevision | null
): TabdocRevision => {
  if (revision) {
    return {
      ...revision,
      source: revision.source ?? 'revision',
      version_id: revision.version_id ?? null,
    }
  }

  return {
    id: buildSyntheticRevisionId(document.id, document.latest_version),
    document_id: document.id,
    version: Math.max(1, document.latest_version || 1),
    content_pm_json: content.description_json,
    content_markdown: content.description_markdown,
    content_plaintext: content.description_plaintext,
    editor_id: document.updated_by,
    created_at: document.updated_at,
    source: 'version',
    version_id: null,
  }
}

const isVersionEntry = (item: TabdocRevision | TabdocVersionEntry): item is TabdocVersionEntry =>
  Object.prototype.hasOwnProperty.call(item, 'description_json')

const normalizeRevisionEntry = (
  item: TabdocRevision | TabdocVersionEntry,
  index: number,
  total: number
): TabdocRevision => {
  if (isVersionEntry(item)) {
    const inferredVersion = Math.max(1, total - index)
    const resolvedVersion =
      typeof item.version === 'number' ? Math.max(1, item.version) : inferredVersion

    return {
      id: item.id,
      document_id: item.document_id,
      version: resolvedVersion,
      content_pm_json: item.description_json ?? {},
      content_markdown: item.description_markdown ?? '',
      content_plaintext: item.description_plaintext ?? '',
      editor_id: null,
      created_at: item.created_at ?? item.last_saved_at,
      source: 'version',
      version_id: item.id,
    }
  }

  return {
    ...item,
    version: Math.max(1, item.version || 1),
    content_pm_json: item.content_pm_json ?? {},
    content_markdown: item.content_markdown ?? '',
    content_plaintext: item.content_plaintext ?? '',
    source: 'revision',
    version_id: item.version_id ?? null,
  }
}

const buildListDocumentsParams = (input: {
  organizationId: string
  spaceId: string
  parentId?: string | null
  includeArchived?: boolean
}): Record<string, string> => {
  const params: Record<string, string> = {
    organization_id: input.organizationId,
    space_id: input.spaceId,
  }
  if (input.parentId) {
    params.parent_id = input.parentId
  }
  if (input.includeArchived) {
    params.include_archived = 'true'
  }
  return params
}

export const listTabdocDocuments = async (input: {
  organizationId: string
  spaceId: string
  parentId?: string | null
  includeArchived?: boolean
}): Promise<TabdocDocument[]> => {
  const payload = await getApiClient().raw<ListDocumentsResponse>('GET', '/tabdoc/documents', {
    params: buildListDocumentsParams(input),
  })
  return payload.documents
}

export const searchTabdocDocuments = async (input: {
  organizationId: string
  spaceId: string
  q: string
  page?: number
  pageSize?: number
}): Promise<SearchDocumentsResponse> => {
  return getApiClient().raw<SearchDocumentsResponse>('GET', '/tabdoc/search', {
    params: {
      organization_id: input.organizationId,
      space_id: input.spaceId,
      q: input.q,
      page: String(Math.max(1, input.page ?? 1)),
      page_size: String(Math.max(1, input.pageSize ?? 10)),
    },
  })
}

export const importTabdocMarkdown = async (input: {
  organizationId: string
  spaceId: string
  markdown: string
}): Promise<ImportMarkdownResponse> => {
  return getApiClient().raw<ImportMarkdownResponse>('POST', '/tabdoc/import/markdown', {
    body: {
      organization_id: input.organizationId,
      space_id: input.spaceId,
      markdown: input.markdown,
    },
  })
}

export const exportTabdocDocument = async (
  documentId: string,
  format: 'markdown' | 'html'
): Promise<ExportDocumentResponse> => {
  return getApiClient().raw<ExportDocumentResponse>(
    'GET',
    `/tabdoc/documents/${documentId}/export`,
    { params: { format } }
  )
}

export const createTabdocDocument = async (input: {
  organizationId: string
  spaceId: string
  parentId?: string | null
  title: string
  markdown?: string
  pmJson?: Record<string, unknown>
  plaintext?: string
}): Promise<DocumentDetailResponse> => {
  const response = await getApiClient().raw<BackendDocumentDetailResponse>(
    'POST',
    '/tabdoc/documents',
    {
      body: {
        organization_id: input.organizationId,
        space_id: input.spaceId,
        parent_id: input.parentId ?? null,
        title: input.title,
        initial_content_pm_json: input.pmJson ?? {},
        initial_content_markdown: input.markdown ?? '',
        initial_content_plaintext: input.plaintext ?? '',
      },
    }
  )

  const content = normalizeContent(response.content)

  return {
    document: response.document,
    content,
    latest_revision: toDocumentRevision(response.document, content, response.latest_revision),
  }
}

export const getTabdocDocument = async (documentId: string): Promise<DocumentDetailResponse> => {
  const response = await getApiClient().raw<BackendDocumentDetailResponse>(
    'GET',
    `/tabdoc/documents/${documentId}`
  )
  const content = normalizeContent(response.content)

  return {
    document: response.document,
    content,
    latest_revision: toDocumentRevision(response.document, content, response.latest_revision),
  }
}

export const updateTabdocDocument = async (
  documentId: string,
  input: {
    baseVersion?: number | null
    baseUpdatedAt?: string | null
    title?: string
    parentId?: string | null
    status?: 'active' | 'archived'
    icon?: string
    coverImage?: string
    coverPosition?: number
    tags?: string[]
    properties?: Record<string, unknown>
    isFullWidth?: boolean
    fontStyle?: 'default' | 'serif' | 'mono'
  }
): Promise<TabdocDocument> => {
  const payload = await getApiClient().raw<{ document: TabdocDocument }>(
    'PATCH',
    `/tabdoc/documents/${documentId}`,
    {
      body: {
        base_version: input.baseVersion,
        base_updated_at: input.baseUpdatedAt,
        title: input.title,
        parent_id: input.parentId,
        status: input.status,
        icon: input.icon,
        cover_image: input.coverImage,
        cover_position: input.coverPosition,
        tags: input.tags,
        properties: input.properties,
        is_full_width: input.isFullWidth,
        font_style: input.fontStyle,
      },
    }
  )

  return payload.document
}

export const archiveTabdocDocument = async (documentId: string): Promise<TabdocDocument> => {
  const payload = await getApiClient().raw<{ document: TabdocDocument }>(
    'DELETE',
    `/tabdoc/documents/${documentId}`
  )
  return payload.document
}

export const saveTabdocContent = async (
  documentId: string,
  input: {
    baseVersion: number | null
    baseUpdatedAt?: string | null
    pmJson: Record<string, unknown>
    markdown: string
    plaintext?: string
  }
): Promise<SaveContentResponse> => {
  const response = await getApiClient().raw<BackendSaveContentResponse>(
    'POST',
    `/tabdoc/documents/${documentId}/content`,
    {
      body: {
        base_version: input.baseVersion,
        base_updated_at: input.baseUpdatedAt,
        content_pm_json: input.pmJson,
        content_markdown: input.markdown,
        content_plaintext: input.plaintext ?? '',
      },
    }
  )

  const content = normalizeContent(response.content)

  return {
    document: response.document,
    revision: toDocumentRevision(response.document, content),
  }
}

export const listTabdocRevisions = async (
  documentId: string,
  limit = 20
): Promise<TabdocRevision[]> => {
  const payload = await getApiClient().raw<RevisionsResponse>(
    'GET',
    `/tabdoc/documents/${documentId}/revisions`,
    { params: { limit: Math.max(1, limit) } }
  )

  const revisions = payload.revisions ?? []
  return revisions.map((item, index, list) => normalizeRevisionEntry(item, index, list.length))
}

export const restoreTabdocRevision = async (
  documentId: string,
  input: {
    version?: number
    versionId?: string
    baseVersion?: number | null
    baseUpdatedAt?: string | null
  }
): Promise<SaveContentResponse> => {
  const response = await getApiClient().raw<BackendSaveContentResponse>(
    'POST',
    `/tabdoc/documents/${documentId}/restore`,
    {
      body: {
        version: input.version,
        version_id: input.versionId,
        base_version: input.baseVersion,
        base_updated_at: input.baseUpdatedAt,
      },
    }
  )

  const content = normalizeContent(response.content)

  return {
    document: response.document,
    revision: toDocumentRevision(response.document, content),
  }
}

export const listTabdocPermissions = async (
  documentId: string
): Promise<TabdocPermissionEntry[]> => {
  const payload = await getApiClient().raw<PermissionsResponse>(
    'GET',
    `/tabdoc/documents/${documentId}/permissions`
  )
  return payload.entries
}

export const updateTabdocPermissions = async (
  documentId: string,
  entries: TabdocPermissionInput[]
): Promise<TabdocPermissionEntry[]> => {
  const payload = await getApiClient().raw<PermissionsResponse>(
    'POST',
    `/tabdoc/documents/${documentId}/permissions`,
    {
      body: {
        entries: entries.map((entry) => ({
          subject_type: entry.subject_type,
          subject_id: entry.subject_id,
          permission: entry.permission,
          is_active: entry.is_active ?? true,
        })),
      },
    }
  )
  return payload.entries
}

export const getTabdocMetricsSummary = async (): Promise<TabdocMetricsSummary> => {
  return getApiClient().raw<TabdocMetricsSummary>('GET', '/tabdoc/metrics/summary')
}

// ─── V3 DocHistory API ────────────────────────────────────────────

export interface DocHistoryItem {
  id: string
  document_id?: string
  is_snapshot: boolean
  editor_type: string
  editor_id: string
  expired_at: string | null
  created_at: string | null
  is_named: boolean
  name: string
  pinned: boolean
}

/**
 * V3 版本历史列表（推荐使用，替代 listTabdocRevisions）
 */
export const listTabdocHistories = async (
  documentId: string,
  limit = 50
): Promise<DocHistoryItem[]> => {
  const payload = await getApiClient().raw<DocHistoryItem[]>(
    'GET',
    `/collab/v1/docs/${documentId}/versions`,
    { params: { limit: Math.max(1, limit) } }
  )
  return payload ?? []
}

/**
 * V3 从 DocHistory 恢复（推荐使用，替代 restoreTabdocRevision）
 */
export const restoreTabdocHistory = async (
  documentId: string,
  historyId: string,
  _input?: {
    baseVersion?: number | null
    baseUpdatedAt?: string | null
  }
): Promise<SaveContentResponse> => {
  await getApiClient().raw<Record<string, string>>(
    'POST',
    `/collab/v1/docs/${documentId}/restore`,
    {
      body: {
        version_id: historyId,
      },
    }
  )
  const detail = await getTabdocDocument(documentId)
  const revision = detail.latest_revision
  if (revision == null) {
    throw new Error(`文档 ${documentId} 恢复后缺少 latest_revision，无法组装 SaveContentResponse`)
  }
  return {
    document: detail.document,
    revision,
  }
}

/**
 * V3 创建命名版本
 */
export const createTabdocNamedVersion = async (
  documentId: string,
  name = ''
): Promise<DocHistoryItem> => {
  const payload = await getApiClient().raw<{ id: string; name: string }>(
    'POST',
    `/collab/v1/docs/${documentId}/versions`,
    { body: { name } }
  )
  return {
    ...payload,
    document_id: documentId,
    is_snapshot: true,
    editor_type: '',
    editor_id: '',
    expired_at: null,
    created_at: new Date().toISOString(),
    is_named: true,
    pinned: false,
  }
}

/**
 * V3 删除命名版本
 */
export const deleteTabdocNamedVersion = async (
  documentId: string,
  versionId: string
): Promise<void> => {
  await getApiClient().raw<Record<string, unknown>>(
    'PATCH',
    `/collab/v1/docs/${documentId}/versions/${versionId}/name`,
    { body: { name: '' } }
  )
}

// ─── V1/V2 兼容说明 ──────────────────────────────────────────────
// listTabdocRevisions / restoreTabdocRevision 是 V1/V2 兼容方法。
// 新代码应使用 listTabdocHistories / restoreTabdocHistory。
// 计划在 Phase 2（上线后 4 周）移除 V1/V2 方法。
// 详见 docs/planning/tabdoc/deprecated-model-cleanup.md
