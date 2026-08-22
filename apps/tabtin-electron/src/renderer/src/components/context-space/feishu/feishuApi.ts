/**
 * 飞书多维表格导入 API（/api/integrations/feishu/*）
 *
 * 与后端契约对齐；后端未就绪时 UI 仍可挂载，请求会按信封失败。
 */

import { createJsonApiClient } from '@/services/jsonApiClient'

export class FeishuApiError extends Error {
  readonly statusCode: number
  readonly errorCode?: string

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message)
    this.name = 'FeishuApiError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

const { request } = createJsonApiClient({
  base: '/integrations/feishu',
  loggerName: 'FeishuApi',
  // DELETE /connection 等端点可能无 data；列表/任务端点自行校验
  requireData: false,
  makeError: (message, statusCode, errorCode) => {
    // 404 HTML（路由未挂上 / 后端未重启）时 envelope 解析失败会落成泛化 "Request failed"
    const normalized =
      (!message || message === 'Request failed') && statusCode === 404
        ? '飞书集成接口未就绪（404）。请确认已 migrate integrations_feishu 并重启 Django'
        : (!message || message === 'Request failed') && statusCode > 0
          ? `请求失败（HTTP ${statusCode}）`
          : message
    return new FeishuApiError(normalized, statusCode, errorCode)
  },
})

type FeishuDisplayKind = FeishuResourceKind | 'folder' | 'wiki_space' | 'wiki_node' | 'table'

export function getFeishuDisplayName(
  kind: FeishuDisplayKind,
  rawName: unknown,
  identifiers: Array<string | null | undefined> = [],
): string {
  const name = String(rawName || '').trim()
  const hidden = new Set(identifiers.map((value) => String(value || '').trim()))
  if (name && !hidden.has(name)) return name
  if (kind === 'bitable') return '未命名多维表'
  if (kind === 'table') return '未命名数据表'
  if (kind === 'folder') return '未命名文件夹'
  if (kind === 'wiki_space') return '未命名知识空间'
  return '未命名文档'
}

function asAppList(data: unknown): FeishuBitableApp[] {
  if (Array.isArray(data)) return data as FeishuBitableApp[]
  if (data && typeof data === 'object') {
    const apps = (data as { apps?: unknown }).apps
    if (Array.isArray(apps)) return apps as FeishuBitableApp[]
    const items = (data as { items?: unknown }).items
    if (Array.isArray(items)) return items as FeishuBitableApp[]
  }
  return []
}

function asTableList(data: unknown): FeishuBitableTable[] {
  let rows: unknown[] = []
  if (Array.isArray(data)) rows = data
  if (data && typeof data === 'object') {
    const tables = (data as { tables?: unknown }).tables
    if (Array.isArray(tables)) rows = tables
    const items = (data as { items?: unknown }).items
    if (Array.isArray(items)) rows = items
  }
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const tableId = String((row as { table_id?: string }).table_id || '').trim()
    if (!tableId) return []
    return [{
      table_id: tableId,
      name: getFeishuDisplayName(
        'table',
        (row as { name?: string }).name,
        [tableId],
      ),
    }]
  })
}

export interface FeishuConnection {
  connected: boolean
  display_name?: string | null
  open_id?: string | null
  provider_configured?: boolean
  provider_status?: string | null
  can_manage_provider?: boolean
  provider_app_id?: string | null
}

export interface FeishuOAuthProvider {
  configured: boolean
  can_manage: boolean
  app_id?: string | null
  status?: string | null
  verified_at?: string | null
}

export type FeishuResourceKind = 'bitable' | 'docx'

export interface FeishuBitableApp {
  app_token: string
  name: string
  /** 可选：文件夹 / 空间展示名 */
  folder_token?: string | null
}

/** 同通道可导入资源（多维表 / 云文档） */
export interface FeishuImportableResource {
  token: string
  name: string
  kind: FeishuResourceKind
  /** Search v2 returns a Wiki node token; resolve it only when the user selects the item. */
  wiki_node_token?: string | null
}

export function filterFeishuResourcesByKind(
  resources: FeishuImportableResource[],
  kind: FeishuResourceKind | 'all',
): FeishuImportableResource[] {
  return kind === 'all'
    ? resources
    : resources.filter((resource) => resource.kind === kind)
}

export interface FeishuImportDocumentRef {
  doc_token: string
  name?: string
  doc_type?: 'docx'
}

export interface FeishuBitableTable {
  table_id: string
  name: string
}

export interface FeishuImportTableRef {
  app_token: string
  table_id: string
}

export interface FeishuImportStartResult {
  task_id: string
}

export type FeishuImportTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'success'
  | 'error'

export interface FeishuImportTask {
  task_id?: string
  status: FeishuImportTaskStatus | string
  /** 成功后落库的 TabData table id 列表 */
  table_ids?: string[]
  /** 兼容部分后端用 tables / result.table_ids */
  tables?: Array<{ table_id?: string; id?: string }>
  /** 后端 ImportStatusOut.result */
  result?: {
    /** phase_a 导表 / phase_b 建关联 / phase_c 回填关联 / phase_d 附件 / done */
    phase?: string
    include_attachments?: boolean
    created_tables?: Array<{
      tabdata_table_id?: string
      app_token?: string
      table_id?: string
      name?: string
    }>
    failed_tables?: Array<{
      app_token?: string
      table_id?: string
      name?: string
      error?: string
    }>
    skipped_tables?: Array<{
      tabdata_table_id?: string
      app_token?: string
      table_id?: string
      name?: string
    }>
    cancelled_tables?: Array<{
      app_token?: string
      table_id?: string
      name?: string
    }>
    skipped_keys?: string[]
    cancelled_keys?: string[]
    created_documents?: Array<{
      doc_token?: string
      name?: string
      tabdoc_id?: string
      doc_type?: string
    }>
    failed_documents?: Array<{
      doc_token?: string
      name?: string
      error?: string
    }>
    progress?: { done?: number; total?: number; docs_done?: number; docs_total?: number }
    docs_progress?: { done?: number; total?: number }
  } | null
  error?: string | null
  message?: string | null
  progress?: number | null
}

export function getFeishuConnection(organizationId: string): Promise<FeishuConnection> {
  return request<FeishuConnection>({
    path: '/connection',
    method: 'GET',
    params: { organization_id: organizationId },
  })
}

export function saveFeishuOAuthProvider(
  organizationId: string,
  appId: string,
  appSecret: string,
): Promise<FeishuOAuthProvider> {
  return request<FeishuOAuthProvider>({
    path: '/oauth/provider',
    method: 'PUT',
    body: {
      organization_id: organizationId,
      app_id: appId,
      app_secret: appSecret,
    },
  })
}

export function removeFeishuOAuthProvider(organizationId: string): Promise<{ deleted?: boolean }> {
  return request<{ deleted?: boolean }>({
    path: '/oauth/provider',
    method: 'DELETE',
    params: { organization_id: organizationId },
  })
}

/** 获取飞书官方授权页 URL（accounts.feishu.cn），由客户端直接 openExternal */
export function startFeishuOAuth(
  organizationId: string,
  returnDeepLink = 'tabtin://integrations/feishu/connected',
): Promise<string> {
  return request<{ authorize_url?: string }>({
    path: '/oauth/start',
    method: 'GET',
    params: {
      organization_id: organizationId,
      return_deep_link: returnDeepLink,
    },
  }).then((data) => {
    const url = data?.authorize_url?.trim()
    if (!url) {
      throw new FeishuApiError('OAuth start missing authorize_url', 500)
    }
    return url
  })
}

export function disconnectFeishu(organizationId: string): Promise<unknown> {
  return request<unknown>({
    path: '/connection',
    method: 'DELETE',
    params: { organization_id: organizationId },
  })
}

export function listFeishuBitableApps(
  organizationId: string,
  searchKey = '',
): Promise<FeishuBitableApp[]> {
  return request<unknown>({
    path: '/bitable/apps',
    method: 'GET',
    params: {
      organization_id: organizationId,
      ...(searchKey.trim() ? { q: searchKey.trim() } : {}),
    },
  }).then(asAppList)
}

function asResource(row: unknown): FeishuImportableResource | null {
  if (!row || typeof row !== 'object') return null
  const token = String((row as { token?: string }).token || '').trim()
  const kind = String((row as { kind?: string }).kind || '').trim().toLowerCase()
  if (!token || (kind !== 'bitable' && kind !== 'docx')) return null
  const wikiNodeToken = String(
    (row as { wiki_node_token?: string }).wiki_node_token || '',
  ).trim()
  return {
    token,
    name: getFeishuDisplayName(
      kind,
      (row as { name?: string }).name,
      [token],
    ),
    kind,
    ...(wikiNodeToken ? { wiki_node_token: wikiNodeToken } : {}),
  }
}

function asResourceList(data: unknown): FeishuImportableResource[] {
  const rows = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)
      ? (data as { items: unknown[] }).items
      : [])
  const out: FeishuImportableResource[] = []
  for (const row of rows) {
    const resource = asResource(row)
    if (resource) out.push(resource)
  }
  return out
}

/** 同通道资源列表；kinds 为空表示全部 */
export function listFeishuImportableResources(
  organizationId: string,
  searchKey = '',
  kinds: FeishuResourceKind[] | 'all' = 'all',
): Promise<FeishuImportableResource[]> {
  const kindsParam = kinds === 'all' || kinds.length === 0
    ? 'all'
    : kinds.join(',')
  return request<unknown>({
    path: '/resources',
    method: 'GET',
    params: {
      organization_id: organizationId,
      kinds: kindsParam,
      defer_wiki_resolution: true,
      ...(searchKey.trim() ? { q: searchKey.trim() } : {}),
    },
  }).then(asResourceList)
}

export function resolveFeishuWikiResource(
  organizationId: string,
  nodeToken: string,
  expectedKind: FeishuResourceKind,
): Promise<FeishuImportableResource> {
  return request<unknown>({
    path: '/resources/wiki/resolve',
    method: 'GET',
    params: {
      organization_id: organizationId,
      node_token: nodeToken,
      expected_kind: expectedKind,
    },
  }).then((data) => {
    const resource = asResource(data)
    if (!resource) {
      throw new FeishuApiError('飞书资源解析失败', 502)
    }
    return resource
  })
}

/** 树浏览节点（云盘 / 知识库） */
export type FeishuBrowseNodeKind =
  | 'folder'
  | 'wiki_space'
  | 'wiki_node'
  | 'bitable'
  | 'docx'

export interface FeishuBrowseNode {
  id: string
  name: string
  node_kind: FeishuBrowseNodeKind | string
  selectable: boolean
  expandable: boolean
  token?: string | null
  import_kind?: FeishuResourceKind | null
  folder_token?: string | null
  space_id?: string | null
  node_token?: string | null
  has_child?: boolean | null
}

export interface FeishuBrowseChildrenPage {
  items: FeishuBrowseNode[]
  next_page_token?: string | null
  has_more?: boolean
}

function asBrowseNode(data: unknown): FeishuBrowseNode | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  const id = String(row.id || '').trim()
  if (!id) return null
  const nodeKind = String(row.node_kind || '')
  const importKind = row.import_kind === 'bitable' || row.import_kind === 'docx'
    ? row.import_kind
    : null
  const displayKind: FeishuDisplayKind = importKind
    || (nodeKind === 'folder' || nodeKind === 'wiki_space' || nodeKind === 'wiki_node'
      ? nodeKind
      : 'wiki_node')
  const token = row.token != null ? String(row.token) : null
  const nodeToken = row.node_token != null ? String(row.node_token) : null
  return {
    id,
    name: getFeishuDisplayName(displayKind, row.name, [id, token, nodeToken]),
    node_kind: nodeKind,
    selectable: Boolean(row.selectable),
    expandable: Boolean(row.expandable),
    token,
    import_kind: importKind,
    folder_token: row.folder_token != null ? String(row.folder_token) : null,
    space_id: row.space_id != null ? String(row.space_id) : null,
    node_token: nodeToken,
    has_child: row.has_child == null ? null : Boolean(row.has_child),
  }
}

function asBrowsePage(data: unknown): FeishuBrowseChildrenPage {
  if (!data || typeof data !== 'object') return { items: [], has_more: false }
  const body = data as { items?: unknown[]; next_page_token?: string; has_more?: boolean }
  const items = (body.items || [])
    .map(asBrowseNode)
    .filter((row): row is FeishuBrowseNode => row != null)
  return {
    items,
    next_page_token: body.next_page_token || null,
    has_more: Boolean(body.has_more),
  }
}

export function getFeishuDriveRoot(organizationId: string): Promise<FeishuBrowseNode> {
  return request<unknown>({
    path: '/drive/root',
    method: 'GET',
    params: { organization_id: organizationId },
  }).then((data) => {
    const node = asBrowseNode(data)
    if (!node) throw new FeishuApiError('drive root missing', 500)
    return node
  })
}

export function listFeishuDriveChildren(
  organizationId: string,
  folderToken: string,
  pageToken = '',
): Promise<FeishuBrowseChildrenPage> {
  return request<unknown>({
    path: '/drive/children',
    method: 'GET',
    params: {
      organization_id: organizationId,
      folder_token: folderToken,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  }).then(asBrowsePage)
}

export function listFeishuWikiSpaces(
  organizationId: string,
  pageToken = '',
): Promise<FeishuBrowseChildrenPage> {
  return request<unknown>({
    path: '/wiki/spaces',
    method: 'GET',
    params: {
      organization_id: organizationId,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  }).then(asBrowsePage)
}

export function listFeishuWikiNodes(
  organizationId: string,
  spaceId: string,
  parentNodeToken = '',
  pageToken = '',
): Promise<FeishuBrowseChildrenPage> {
  return request<unknown>({
    path: '/wiki/nodes',
    method: 'GET',
    params: {
      organization_id: organizationId,
      space_id: spaceId,
      ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}),
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  }).then(asBrowsePage)
}

export function listFeishuBitableTables(
  organizationId: string,
  appToken: string,
): Promise<FeishuBitableTable[]> {
  return request<unknown>({
    path: `/bitable/apps/${encodeURIComponent(appToken)}/tables`,
    method: 'GET',
    params: { organization_id: organizationId },
  }).then(asTableList)
}

export interface FeishuImportPreviewTable {
  app_token: string
  table_id: string
  name: string
  selected?: boolean
  auto_included?: boolean
}

export interface FeishuImportPreviewEdge {
  app_token: string
  from_table_id: string
  from_table_name: string
  field_name: string
  to_table_id: string
  to_table_name: string
  duplex?: boolean
  same_base?: boolean
}

export interface FeishuImportPreviewResult {
  tables: FeishuImportPreviewTable[]
  edges: FeishuImportPreviewEdge[]
  warnings: string[]
  has_attachments?: boolean
}

export function previewFeishuImport(body: {
  organization_id: string
  tables: Array<FeishuImportTableRef & { name?: string }>
}): Promise<FeishuImportPreviewResult> {
  return request<FeishuImportPreviewResult>({
    path: '/import/preview',
    method: 'POST',
    body: {
      organization_id: body.organization_id,
      tables: body.tables,
    },
  })
}

export function startFeishuImport(body: {
  organization_id: string
  space_id: string
  collection_id?: string | null
  tables?: Array<FeishuImportTableRef & { name?: string }>
  documents?: FeishuImportDocumentRef[]
  include_attachments?: boolean
}): Promise<FeishuImportStartResult> {
  return request<FeishuImportStartResult>({
    path: '/import',
    method: 'POST',
    body: {
      organization_id: body.organization_id,
      space_id: body.space_id,
      ...(body.collection_id ? { collection_id: body.collection_id } : {}),
      tables: body.tables ?? [],
      documents: body.documents ?? [],
      include_attachments: Boolean(body.include_attachments),
    },
  })
}

export function getFeishuImportTask(taskId: string): Promise<FeishuImportTask> {
  return request<FeishuImportTask>({
    path: `/import/${encodeURIComponent(taskId)}`,
    method: 'GET',
  })
}

export function cancelFeishuImportTable(
  taskId: string,
  body: FeishuImportTableRef,
): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>({
    path: `/import/${encodeURIComponent(taskId)}/cancel-table`,
    method: 'POST',
    body,
  })
}

export function skipFeishuImportTable(
  taskId: string,
  body: FeishuImportTableRef,
): Promise<{ ok?: boolean }> {
  return request<{ ok?: boolean }>({
    path: `/import/${encodeURIComponent(taskId)}/skip-table`,
    method: 'POST',
    body,
  })
}

/** 从任务结果里抽出落库 table id（兼容多种字段形态） */
export function extractImportedTableIds(task: FeishuImportTask): string[] {
  const fromCreated = task.result?.created_tables
  if (Array.isArray(fromCreated) && fromCreated.length > 0) {
    return fromCreated
      .map((row) => row.tabdata_table_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  }
  if (Array.isArray(task.table_ids) && task.table_ids.length > 0) {
    return task.table_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  }
  if (Array.isArray(task.tables)) {
    return task.tables
      .map((row) => row.table_id || row.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  }
  return []
}

export function isFeishuImportTerminalSuccess(status: string): boolean {
  const s = status.toLowerCase()
  return s === 'completed' || s === 'success' || s === 'done'
}

export function isFeishuImportTerminalFailure(status: string): boolean {
  const s = status.toLowerCase()
  return s === 'failed' || s === 'error'
}
