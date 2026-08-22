/**
 * 「分享给我」资源 API
 *
 * Agent 私有化后，协作者看不到他人的 workspace，只能通过资源级
 * DocumentPermission / TablePermission 访问被显式分享的文档 / 表格。
 * 本 service 对接后端独立访问发现入口：
 *  - GET /tabdoc/shared-with-me
 *  - GET /tabdata/shared-with-me
 *  - GET /context/files/shared-with-me（ TabFiles）
 *
 * 返回的每条记录带 organization_id + 资源 id，足够前端在「分享给我」受限视图里
 * 按资源 id 复用现有编辑器打开，而不需要把资源所属的 workspace 纳入 Space 列表。
 */
import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import i18n from '@/i18n'
import { createLogger } from '@/utils/logger'

const log = createLogger('SharedResourcesApi')

export type SharedResourceType = 'doc' | 'table' | 'file'

/** 资源所有者（即「由 xxx 分享」中的 xxx）展示信息 */
export interface SharedResourceOwner {
  id: string
  displayName: string
  avatar: string
}

export type SharedResourceLocation =
  | { kind: 'root' }
  | { kind: 'folder'; path: Array<{ id: string; name: string }> }
  | { kind: 'restricted' }
  | { kind: 'unavailable' }

export interface SharedResourceItem {
  resourceType: SharedResourceType
  /** 文档 id 或表格 id */
  resourceId: string
  title: string
  icon: string
  organizationId: string
  /** 资源所属 workspace id（owner 的），用于复用编辑器挂载，不代表协作者是该 Space 成员 */
  spaceId: string
  /** viewer / editor / admin */
  permission: string
  updatedAt: string | null
  /** 资源所有者/分享来源，后端可能缺省。 */
  sharedBy: SharedResourceOwner | null
  /** 权限裁剪后的原位置；旧后端缺省时为 null。 */
  location: SharedResourceLocation | null
}

export interface SharedResourcePlacement {
  resourceType: SharedResourceType
  resourceId: string
  collectionId: string | null
  dismissed: boolean
}

interface SharedOwnerRow {
  id?: string
  display_name?: string
  avatar?: string
}

interface SharedDocRow {
  resource_type?: string
  document_id?: string
  title?: string
  icon?: string
  organization_id?: string
  space_id?: string
  permission?: string
  updated_at?: string | null
  shared_by?: SharedOwnerRow | null
  location?: SharedResourceLocation | null
}

interface SharedTableRow {
  resource_type?: string
  table_id?: string
  title?: string
  icon?: string
  organization_id?: string
  space_id?: string
  permission?: string
  updated_at?: string | null
  shared_by?: SharedOwnerRow | null
  location?: SharedResourceLocation | null
}

interface SharedFileRow {
  resource_type?: string
  file_record_id?: string
  context_item_id?: string
  title?: string
  icon?: string
  organization_id?: string
  space_id?: string
  permission?: string
  updated_at?: string | null
  shared_by?: SharedOwnerRow | null
  location?: SharedResourceLocation | null
}

interface StandardEnvelope<T> {
  success?: boolean
  message?: string
  data?: T
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch (error) {
    log.warn(i18n.t('common:logs.tokenFetchFailed'), error)
    return {}
  }
}

async function getEnvelope<T>(path: string): Promise<T | null> {
  const authHeaders = await getAuthHeaders()
  const response = await adapterApiRequest({
    url: joinApiPath(API_CONFIG.baseURL, path),
    method: 'GET',
    headers: authHeaders,
  })
  if (!response || response.status !== 200) {
    throw new Error(`shared resources request failed: ${response?.status ?? 'no_response'}`)
  }
  const body = response.data as StandardEnvelope<T>
  if (!body?.success || body.data === undefined) {
    throw new Error(body?.message || 'shared resources response is invalid')
  }
  return body.data
}

async function putEnvelope<T>(path: string, data: Record<string, unknown>): Promise<T> {
  const authHeaders = await getAuthHeaders()
  const response = await adapterApiRequest({
    url: joinApiPath(API_CONFIG.baseURL, path),
    method: 'PUT',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  })
  const body = response?.data as StandardEnvelope<T> | undefined
  if (!response || response.status !== 200 || !body?.success || body.data === undefined) {
    throw new Error(body?.message || 'shared resource placement request failed')
  }
  return body.data
}

function mapOwner(row: SharedOwnerRow | null | undefined): SharedResourceOwner | null {
  if (!row || !row.id) return null
  return {
    id: String(row.id),
    displayName: row.display_name ?? '',
    avatar: row.avatar ?? '',
  }
}

function mapLocation(value: unknown): SharedResourceLocation | null {
  if (!value || typeof value !== 'object') return null
  const row = value as { kind?: unknown; path?: unknown }
  if (row.kind === 'root' || row.kind === 'restricted' || row.kind === 'unavailable') {
    return { kind: row.kind }
  }
  if (row.kind !== 'folder' || !Array.isArray(row.path)) return null
  const path = row.path
    .filter(segment => segment && typeof segment === 'object')
    .map(segment => segment as { id?: unknown; name?: unknown })
    .filter(segment => typeof segment.id === 'string' && typeof segment.name === 'string')
    .map(segment => ({ id: segment.id as string, name: segment.name as string }))
  return path.length > 0 ? { kind: 'folder', path } : null
}

function mapDoc(row: SharedDocRow): SharedResourceItem | null {
  if (!row.document_id || !row.organization_id) return null
  return {
    resourceType: 'doc',
    resourceId: String(row.document_id),
    title: row.title ?? '',
    icon: row.icon ?? '',
    organizationId: String(row.organization_id),
    spaceId: String(row.space_id ?? ''),
    permission: row.permission ?? 'viewer',
    updatedAt: row.updated_at ?? null,
    sharedBy: mapOwner(row.shared_by),
    location: mapLocation(row.location),
  }
}

function mapTable(row: SharedTableRow): SharedResourceItem | null {
  if (!row.table_id || !row.organization_id) return null
  return {
    resourceType: 'table',
    resourceId: String(row.table_id),
    title: row.title ?? '',
    icon: row.icon ?? '',
    organizationId: String(row.organization_id),
    spaceId: String(row.space_id ?? ''),
    permission: row.permission ?? 'viewer',
    updatedAt: row.updated_at ?? null,
    sharedBy: mapOwner(row.shared_by),
    location: mapLocation(row.location),
  }
}

function mapFile(row: SharedFileRow): SharedResourceItem | null {
  if (!row.file_record_id || !row.organization_id) return null
  return {
    resourceType: 'file',
    resourceId: String(row.file_record_id),
    title: row.title ?? '',
    icon: row.icon ?? '',
    organizationId: String(row.organization_id),
    spaceId: String(row.space_id ?? ''),
    permission: row.permission ?? 'viewer',
    updatedAt: row.updated_at ?? null,
    sharedBy: mapOwner(row.shared_by),
    location: mapLocation(row.location),
  }
}

function buildQuery(organizationId?: string): string {
  if (!organizationId) return ''
  return `?organization_id=${encodeURIComponent(organizationId)}`
}

/**
 * 拉取「分享给我」的文档 + 表格 + 文件，合并并按更新时间倒序。
 *
 * 任一来源失败不阻断另一来源（独立 try/catch）：发现入口是辅助视图，
 * 不应因单边后端异常整体白屏。
 */
export async function listSharedWithMe(organizationId?: string): Promise<SharedResourceItem[]> {
  const query = buildQuery(organizationId)

  const [docData, tableData, fileData] = await Promise.all([
    getEnvelope<{ documents?: SharedDocRow[] }>(`/tabdoc/shared-with-me${query}`).catch(() => null),
    getEnvelope<{ tables?: SharedTableRow[] }>(`/tabdata/shared-with-me${query}`).catch(() => null),
    getEnvelope<{ files?: SharedFileRow[] }>(`/context/files/shared-with-me${query}`).catch(() => null),
  ])
  if (docData === null && tableData === null && fileData === null) {
    throw new Error('shared resources request failed')
  }

  const docs = (docData?.documents ?? [])
    .map(mapDoc)
    .filter((item): item is SharedResourceItem => item !== null)
  const tables = (tableData?.tables ?? [])
    .map(mapTable)
    .filter((item): item is SharedResourceItem => item !== null)
  const files = (fileData?.files ?? [])
    .map(mapFile)
    .filter((item): item is SharedResourceItem => item !== null)

  return [...docs, ...tables, ...files].sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
    return tb - ta
  })
}

export async function listSharedResourcePlacements(
  organizationId: string,
): Promise<SharedResourcePlacement[]> {
  const data = await getEnvelope<{
    placements?: Array<{
      resource_type?: string
      resource_id?: string
      collection_id?: string | null
      dismissed?: boolean
    }>
  }>(`/context/organizations/${encodeURIComponent(organizationId)}/shared-resource-placements`)
  return (data?.placements ?? []).flatMap(row => {
    if (
      (row.resource_type !== 'doc' && row.resource_type !== 'table' && row.resource_type !== 'file')
      || !row.resource_id
    ) return []
    return [{
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      collectionId: row.collection_id ?? null,
      dismissed: row.dismissed === true,
    }]
  })
}

export async function moveSharedResourcePlacement(input: {
  organizationId: string
  resourceType: SharedResourceType
  resourceId: string
  collectionId: string | null
}): Promise<void> {
  await putEnvelope(
    `/context/organizations/${encodeURIComponent(input.organizationId)}/shared-resource-placement`,
    {
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      collection_id: input.collectionId,
    },
  )
}

export async function dismissSharedResourcePlacement(input: {
  organizationId: string
  resourceType: SharedResourceType
  resourceId: string
}): Promise<void> {
  const authHeaders = await getAuthHeaders()
  const response = await adapterApiRequest({
    url: joinApiPath(
      API_CONFIG.baseURL,
      `/context/organizations/${encodeURIComponent(input.organizationId)}/shared-resource-placement/dismiss`,
    ),
    // Electron 主进程代理对 DELETE 请求体在部分版本中会丢失，导致后端收到“数据不能为空”。
    // 使用语义等价的 POST dismiss 端点，保持旧 DELETE 端点兼容，同时确保桌面端请求体可靠传输。
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resource_type: input.resourceType,
      resource_id: input.resourceId,
    }),
  })
  const body = response?.data as StandardEnvelope<{ dismissed?: boolean }> | undefined
  if (response?.status === 200 && body?.success) return
  throw new Error(body?.message || `shared resource dismissal failed (${response?.status ?? 'no_response'})`)
}
