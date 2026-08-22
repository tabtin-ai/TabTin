/**
 * Space API 服务 — 从 Electron 抽离
 */

import type {
  CreateSpaceRequest,
  Space,
  SpaceContextItem,
  SpaceContextSearchItem,
  SpaceContextItemListResponse,
  SpaceContextSearchParams,
  SpaceContextSearchResponse,
  SpaceListResponse,
  SpaceQueryParams,
  SpaceStats,
  UpdateSpaceRequest,
  UpdateSpaceStatusRequest,
  SpaceCollection,
  Agent,
  CreateAgentRequest,
  UpdateAgentRequest,
  WorkspaceSummary,
} from '../types/space.js'
import { API_ENDPOINTS, joinApiPath } from '@tabtin/config'
import { authenticatedRequest, apiBaseUrl, formatApiErrorMessage } from './base.js'

function normalizeAgentApiMessage(message: unknown, fallback: string): string {
  const trimmed = typeof message === 'string' ? message.trim() : ''
  if (!trimmed || trimmed === 'Agent') {
    return fallback
  }
  return trimmed
}

function createHttpStatusError(message: string, status?: number): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number }
  if (typeof status === 'number') {
    error.status = status
  }
  return error
}

export interface TrashedItem {
  id: string
  item_type: string
  title: string
  preview?: string
  resource_id?: string
  /** ：org-only 资源（不挂 workspace/project）时为 null。 */
  space_id: string | null
  /** ：org-only 资源直挂 Organization 时携带。 */
  organization_id?: string | null
  is_archived: boolean
  created_at: string
  updated_at: string
  trashed_at: string | null
  trashed_by: string | null
  previous_status: string | null
  metadata?: Record<string, any>
}

export interface TrashedItemsResponse {
  items: TrashedItem[]
  total: number
  page: number
  page_size: number
  retention_days?: number
}

export interface TrashedSpace {
  id: string
  name: string
  icon: string
  description: string
  status: string
  trashed_at: string | null
  trashed_by: string | null
  previous_status: string | null
  created_at: string | null
}

export interface TrashedSpacesResponse {
  items: TrashedSpace[]
  total: number
}

export interface DeactivatedAgent {
  id: string
  name: string
  type: string
  is_default: boolean
  created_at: string | null
  deactivated_at: string | null
}

export interface DeactivatedAgentsResponse {
  items: DeactivatedAgent[]
  total: number
}

export type {
  SpaceContextItem,
  SpaceContextSearchItem,
  SpaceContextItemListResponse,
  SpaceContextSearchParams,
  SpaceContextSearchResponse,
}

export type ContextItem = SpaceContextItem
export type ContextSearchItem = SpaceContextSearchItem
export type ContextSearchResponse = SpaceContextSearchResponse
export type ContextItemListResponse = SpaceContextItemListResponse

export interface SpaceContextItemListParams {
  item_type?: string
  is_archived?: boolean
  page?: number
  page_size?: number
}

/** ：云文档树仅文档/表格；Collection 文件夹归云盘平行系统。 */
export type KnowledgeTreeNodeType = 'tabdoc' | 'tabdata'

export interface KnowledgeTreeNode {
  id: string
  node_type: KnowledgeTreeNodeType
  resource_id: string | null
  context_item_id: string | null
  parent_node_id: string | null
  parent_node_type: KnowledgeTreeNodeType | null
  collection_id: string | null
  title: string
  icon: string | null
  order: number
  is_pinned: boolean
  updated_at: string | null
  child_count: number
  children?: KnowledgeTreeNode[]
  is_empty?: boolean
}

export interface KnowledgeTreeResponse {
  organization_id: string
  folder_scope: string
  orphan_policy: string
  roots: KnowledgeTreeNode[]
  stats: {
    folder_count: number
    doc_count: number
    table_count: number
    orphan_count: number
  }
  warnings: string[]
}

export interface KnowledgeTreeParams {
  item_types?: string
  depth?: number
  owned_only?: boolean
}

export interface SpaceFileUploadRequest {
  file_record_id: string
  collection_id?: string | null
  title?: string | null
}

export interface SpaceFileDownloadUrlResponse {
  url: string
  file_name: string
  mime_type: string
  file_size?: number | null
  preview_eligible?: boolean
  mime_preview_safe?: boolean
}

export interface SpaceFileDownloadUrlOptions {
  previewMaxBytes?: number
}

const SPACE_CRUD_RETIRED =
  'Space CRUD 已退役：请改用 WorkspaceApiService / ProjectApiService'

export class SpaceApiService {
  /** @deprecated  改用 WorkspaceApiService.list + ProjectApiService.list */
  static async listSpaces(_params?: SpaceQueryParams): Promise<SpaceListResponse> {
    throw new Error(SPACE_CRUD_RETIRED)
  }

  /** @deprecated  改用 WorkspaceApiService / ProjectApiService */
  static async getSpace(_spaceId: string): Promise<Space> {
    throw new Error(SPACE_CRUD_RETIRED)
  }

  /** @deprecated  改用 WorkspaceApiService.create / ProjectApiService */
  static async createSpace(_data: CreateSpaceRequest): Promise<Space> {
    throw new Error(SPACE_CRUD_RETIRED)
  }

  /** @deprecated  改用 WorkspaceApiService.update */
  static async updateSpace(_spaceId: string, _data: UpdateSpaceRequest): Promise<Space> {
    throw new Error(SPACE_CRUD_RETIRED)
  }

  /** @deprecated  ensure-execution-agent 已退役 */
  static async ensureSpaceExecutionAgent(
    _spaceId: string,
  ): Promise<{ space: Space; agent: Agent }> {
    throw new Error(
      'ensureSpaceExecutionAgent 已退役：请先选择 Agent，勿再补建现场身份',
    )
  }

  /** @deprecated  改用 WorkspaceApiService.delete */
  static async deleteSpace(_spaceId: string, _deviceId?: string | null): Promise<void> {
    throw new Error(SPACE_CRUD_RETIRED)
  }

  /** @deprecated  Space status 子路径已 410 */
  static async updateSpaceStatus(
    _spaceId: string,
    _data: UpdateSpaceStatusRequest,
  ): Promise<Space> {
    throw new Error(SPACE_CRUD_RETIRED)
  }

  /** @deprecated  改用 ProjectApiService.archive */
  static async archiveSpace(spaceId: string): Promise<void> {
    return ProjectApiService.archive(spaceId)
  }

  /** @deprecated  改用 ProjectApiService.restore */
  static async restoreSpace(spaceId: string): Promise<void> {
    return ProjectApiService.restore(spaceId)
  }

  /** @deprecated  Space stats 已 410；store 层返回空壳 */
  static async getSpaceStats(_spaceId: string): Promise<SpaceStats> {
    throw new Error(SPACE_CRUD_RETIRED)
  }

  static async searchSpace(
    spaceId: string,
    params: SpaceContextSearchParams,
  ): Promise<SpaceContextSearchResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('q', params.q)
    if (params.type) queryParams.append('type', params.type)
    if (params.page) queryParams.append('page', String(params.page))
    if (params.page_size) queryParams.append('page_size', String(params.page_size))

    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.WORKSPACE.SEARCH(spaceId)}?${queryParams.toString()}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to search space')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to search space')
    }
    return responseData.data as SpaceContextSearchResponse
  }

  static async searchOrganization(
    organizationId: string,
    params: SpaceContextSearchParams,
  ): Promise<SpaceContextSearchResponse> {
    const queryParams = new URLSearchParams()
    queryParams.append('q', params.q)
    if (params.type) queryParams.append('type', params.type)
    if (params.page) queryParams.append('page', String(params.page))
    if (params.page_size) queryParams.append('page_size', String(params.page_size))

    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.SEARCH(organizationId)}?${queryParams.toString()}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to search organization')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to search organization')
    }
    return responseData.data as SpaceContextSearchResponse
  }

  static async listContextItems(
    spaceId: string,
    params?: { item_type?: string; is_archived?: boolean; page?: number; page_size?: number; scope?: 'space' | 'organization' },
  ): Promise<SpaceContextItemListResponse> {
    const queryParams = new URLSearchParams()
    if (params?.item_type) queryParams.append('item_type', params.item_type)
    if (params?.is_archived !== undefined) queryParams.append('is_archived', String(params.is_archived))
    if (params?.page) queryParams.append('page', String(params.page))
    if (params?.page_size) queryParams.append('page_size', String(params.page_size))
    if (params?.scope) queryParams.append('scope', params.scope)

    const qs = queryParams.toString()
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.WORKSPACE.CONTEXT_ITEMS(spaceId)}${qs ? `?${qs}` : ''}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to list context items')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to list context items')
    }
    return responseData.data as SpaceContextItemListResponse
  }

  /**
   * 云盘挂载文件。
   * ：``hostId`` 为 Workspace.id 或 Project.id；默认走 workspace 路径，
   * Project 场景传 ``hostKind: 'project'``。
   */
  static async uploadSpaceFile(
    hostId: string,
    data: SpaceFileUploadRequest,
    hostKind: 'workspace' | 'project' = 'workspace',
  ): Promise<SpaceContextItem> {
    const endpoint = hostKind === 'project'
      ? API_ENDPOINTS.PROJECT.FILE_UPLOAD(hostId)
      : API_ENDPOINTS.WORKSPACE.FILE_UPLOAD(hostId)
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), endpoint),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response || response.status !== 201) {
      throw new Error(response?.data?.message || 'Failed to upload space file')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to upload space file')
    }
    if (!responseData.data?.id) {
      throw new Error('Invalid upload space file response')
    }
    return responseData.data as SpaceContextItem
  }

  /**
   * 组织级云盘挂载文件（ org-only：不挂 workspace/project）。
   * ：``data.collection_id`` 现支持挂到 Organization Collection（组织级文件夹）；
   * 后端校验该 collection 必须归属同一 organization_id，否则拒绝。
   */
  static async uploadOrganizationFile(
    organizationId: string,
    data: SpaceFileUploadRequest,
  ): Promise<SpaceContextItem> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.FILE_UPLOAD(organizationId)),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response || response.status !== 201) {
      throw new Error(response?.data?.message || 'Failed to upload organization file')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to upload organization file')
    }
    if (!responseData.data?.id) {
      throw new Error('Invalid upload organization file response')
    }
    return responseData.data as SpaceContextItem
  }

  static async getOrganizationFileDownloadUrl(
    organizationId: string,
    itemId: string,
    options?: SpaceFileDownloadUrlOptions,
  ): Promise<SpaceFileDownloadUrlResponse> {
    const query = new URLSearchParams()
    if (options?.previewMaxBytes !== undefined) {
      query.set('preview_max_bytes', String(options.previewMaxBytes))
    }
    const response = await authenticatedRequest({
      url: `${joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.FILE_DOWNLOAD_URL(organizationId, itemId))}${query.size ? `?${query.toString()}` : ''}`,
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw createHttpStatusError(
        response?.data?.message || 'Failed to get organization file download URL',
        response?.status,
      )
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to get organization file download URL')
    }
    if (!responseData.data?.url && responseData.data?.preview_eligible !== false) {
      throw new Error('Invalid organization file download URL response')
    }
    return responseData.data as SpaceFileDownloadUrlResponse
  }

  /** 组织级云盘裸文件移入回收站。 */
  static async trashOrganizationFile(organizationId: string, fileRecordId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.FILE_TRASH(organizationId, fileRecordId)),
      method: 'POST',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to trash organization file')
    }
  }

  /** 从回收站恢复组织级云盘裸文件。 */
  static async restoreOrganizationFileFromTrash(
    organizationId: string,
    fileRecordId: string,
  ): Promise<SpaceContextItem> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.FILE_RESTORE(organizationId, fileRecordId)),
      method: 'POST',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to restore organization file from trash')
    }
    return response.data.data as SpaceContextItem
  }

  /** 从回收站永久删除组织级云盘裸文件。 */
  static async permanentDeleteOrganizationFileFromTrash(
    organizationId: string,
    fileRecordId: string,
  ): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.FILE_PERMANENT(organizationId, fileRecordId)),
      method: 'DELETE',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to permanently delete organization file')
    }
  }

  static async getSpaceFileDownloadUrl(
    hostId: string,
    itemId: string,
    options?: SpaceFileDownloadUrlOptions & { hostKind?: 'workspace' | 'project' },
  ): Promise<SpaceFileDownloadUrlResponse> {
    const query = new URLSearchParams()
    if (options?.previewMaxBytes !== undefined) {
      query.set('preview_max_bytes', String(options.previewMaxBytes))
    }
    const hostKind = options?.hostKind ?? 'workspace'
    const endpoint = hostKind === 'project'
      ? API_ENDPOINTS.PROJECT.FILE_DOWNLOAD_URL(hostId, itemId)
      : API_ENDPOINTS.WORKSPACE.FILE_DOWNLOAD_URL(hostId, itemId)
    const response = await authenticatedRequest({
      url: `${joinApiPath(apiBaseUrl(), endpoint)}${query.size ? `?${query.toString()}` : ''}`,
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw createHttpStatusError(
        response?.data?.message || 'Failed to get space file download URL',
        response?.status,
      )
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to get space file download URL')
    }
    if (!responseData.data?.url && responseData.data?.preview_eligible !== false) {
      throw new Error('Invalid space file download URL response')
    }
    return responseData.data as SpaceFileDownloadUrlResponse
  }

  /**
   * 记录当前用户最近一次打开某资源（per-user last_visited_at upsert）。
   * fire-and-forget：失败仅吞掉返回 false，不阻断资源打开主流程。
   */
  static async recordResourceAccess(itemId: string): Promise<boolean> {
    try {
      const response = await authenticatedRequest({
        url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.CONTEXT_ITEM.ACCESS(itemId)}`),
        method: 'POST',
      })
      return Boolean(response && response.status === 200 && response.data?.success)
    } catch {
      return false
    }
  }

  static async listOrganizationContextItems(
    organizationId: string,
    params?: SpaceContextItemListParams,
  ): Promise<SpaceContextItemListResponse> {
    const queryParams = new URLSearchParams()
    if (params?.item_type) queryParams.append('item_type', params.item_type)
    if (params?.is_archived !== undefined) queryParams.append('is_archived', String(params.is_archived))
    if (params?.page) queryParams.append('page', String(params.page))
    if (params?.page_size) queryParams.append('page_size', String(params.page_size))

    const qs = queryParams.toString()
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.CONTEXT_ITEMS(organizationId)}${qs ? `?${qs}` : ''}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to list organization context items')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to list organization context items')
    }
    return responseData.data as SpaceContextItemListResponse
  }

  static async listKnowledgeTree(
    organizationId: string,
    params?: KnowledgeTreeParams,
  ): Promise<KnowledgeTreeResponse> {
    const queryParams = new URLSearchParams()
    if (params?.item_types) queryParams.append('item_types', params.item_types)
    if (params?.depth) queryParams.append('depth', String(params.depth))
    if (params?.owned_only !== undefined) queryParams.append('owned_only', String(params.owned_only))

    const qs = queryParams.toString()
    const response = await authenticatedRequest({
      url: joinApiPath(
        apiBaseUrl(),
        `${API_ENDPOINTS.ORGANIZATION.KNOWLEDGE_TREE(organizationId)}${qs ? `?${qs}` : ''}`,
      ),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to load knowledge tree')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to load knowledge tree')
    }
    return responseData.data as KnowledgeTreeResponse
  }

  static async listKnowledgeTreeChildren(
    organizationId: string,
    nodeId: string,
    params: KnowledgeTreeParams & { node_type: KnowledgeTreeNodeType },
  ): Promise<{ children: KnowledgeTreeNode[]; node_id: string; node_type: string }> {
    const queryParams = new URLSearchParams()
    queryParams.set('node_type', params.node_type)
    if (params.item_types) queryParams.append('item_types', params.item_types)
    if (params.owned_only !== undefined) queryParams.append('owned_only', String(params.owned_only))

    const qs = queryParams.toString()
    const response = await authenticatedRequest({
      url: joinApiPath(
        apiBaseUrl(),
        `${API_ENDPOINTS.ORGANIZATION.KNOWLEDGE_TREE_CHILDREN(organizationId, nodeId)}?${qs}`,
      ),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to load knowledge tree children')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to load knowledge tree children')
    }
    return responseData.data as { children: KnowledgeTreeNode[]; node_id: string; node_type: string }
  }

  static async listTrashedItems(
    spaceId: string,
    params?: { item_type?: string; page?: number; page_size?: number },
  ): Promise<TrashedItemsResponse> {
    const queryParams = new URLSearchParams()
    if (params?.item_type) queryParams.append('item_type', params.item_type)
    if (params?.page) queryParams.append('page', String(params.page))
    if (params?.page_size) queryParams.append('page_size', String(params.page_size))

    const qs = queryParams.toString()
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.WORKSPACE.TRASH(spaceId)}${qs ? `?${qs}` : ''}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to list trashed items')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to list trashed items')
    }
    return responseData.data as TrashedItemsResponse
  }

  static async listOrganizationTrashedItems(
    organizationId: string,
    params?: { item_type?: string; page?: number; page_size?: number },
  ): Promise<TrashedItemsResponse> {
    const queryParams = new URLSearchParams()
    if (params?.item_type) queryParams.append('item_type', params.item_type)
    if (params?.page) queryParams.append('page', String(params.page))
    if (params?.page_size) queryParams.append('page_size', String(params.page_size))

    const qs = queryParams.toString()
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.TRASH(organizationId)}${qs ? `?${qs}` : ''}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to list organization trashed items')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to list organization trashed items')
    }
    return responseData.data as TrashedItemsResponse
  }

  static async emptyOrganizationTrash(organizationId: string): Promise<{ deleted_count: number }> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.TRASH_EMPTY(organizationId)}`),
      method: 'POST',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to empty organization trash')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to empty organization trash')
    }
    return responseData.data
  }

  /** @deprecated  团队域改用 ProjectApiService.trash；个人域改用 WorkspaceApiService.delete */
  static async trashSpace(spaceId: string): Promise<void> {
    return ProjectApiService.trash(spaceId)
  }

  /** @deprecated  改用 ProjectApiService.restoreFromTrash */
  static async restoreSpaceFromTrash(spaceId: string): Promise<void> {
    return ProjectApiService.restoreFromTrash(spaceId)
  }

  /** @deprecated  改用 ProjectApiService.permanentDeleteFromTrash */
  static async permanentDeleteSpaceFromTrash(spaceId: string): Promise<void> {
    return ProjectApiService.permanentDeleteFromTrash(spaceId)
  }

  /** @deprecated  改用 ProjectApiService.listTrashed */
  static async listTrashedSpaces(organizationId: string): Promise<TrashedSpacesResponse> {
    return ProjectApiService.listTrashed(organizationId)
  }

  static async listDeactivatedAgents(organizationId: string): Promise<DeactivatedAgentsResponse> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.ORGANIZATION.DEACTIVATED_AGENTS(organizationId)}`),
      method: 'GET',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to list deactivated agents')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to list deactivated agents')
    }
    return responseData.data as DeactivatedAgentsResponse
  }

  static async emptyTrash(spaceId: string): Promise<{ deleted_count: number }> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.WORKSPACE.TRASH_EMPTY(spaceId)}`),
      method: 'POST',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to empty trash')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to empty trash')
    }
    return responseData.data
  }

  static async pinContextItem(itemId: string, pinned: boolean): Promise<SpaceContextItem> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.CONTEXT_ITEM.DETAIL(itemId)}`),
      method: 'PATCH',
      body: JSON.stringify({ is_pinned: pinned }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to update pin status')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to update pin status')
    }
    return responseData.data as SpaceContextItem
  }

  static async renameContextItem(itemId: string, title: string): Promise<SpaceContextItem> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.CONTEXT_ITEM.DETAIL(itemId)}`),
      method: 'PATCH',
      body: JSON.stringify({ title }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to rename')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to rename')
    }
    return responseData.data as SpaceContextItem
  }

  /** ：按 ContextItem.parent 同级重排（不触碰 collection_id） */
  static async reorderKnowledgeTreeSiblings(
    organizationId: string,
    itemIds: string[],
    parentId: string | null,
  ): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(
        apiBaseUrl(),
        API_ENDPOINTS.ORGANIZATION.KNOWLEDGE_TREE_REORDER_SIBLINGS(organizationId),
      ),
      method: 'POST',
      body: JSON.stringify({ item_ids: itemIds, parent_id: parentId }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to reorder knowledge tree siblings')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to reorder knowledge tree siblings')
    }
  }

  /** ：挂到父 ContextItem（parent_id=null 落根） */
  static async updateContextItemParent(
    itemId: string,
    parentId: string | null,
  ): Promise<SpaceContextItem> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.CONTEXT_ITEM.DETAIL(itemId)}`),
      method: 'PATCH',
      body: JSON.stringify({ parent_id: parentId }),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to update parent')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to update parent')
    }
    return responseData.data as SpaceContextItem
  }

  static async archiveContextItem(itemId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.CONTEXT_ITEM.DETAIL(itemId)}`),
      method: 'DELETE',
    })
    if (!response || (response.status !== 200 && response.status !== 204)) {
      throw new Error(response?.data?.message || 'Failed to archive')
    }
  }

  static getTrashContextResourcePath(
    item: Pick<SpaceContextItem, 'id' | 'item_type' | 'resource_id' | 'space_id' | 'organization_id'>,
  ): string | null {
    const resourceId = item.resource_id || item.id
    // 后端 item_type 为 tabfiles；列表加载后 normalizeBackendType 会变成 file。
    // 两条入口都必须打到组织级 trash，否则会 silent fallback 到 archive（无 trashed_at）。
    if (item.item_type === 'tabfiles' || item.item_type === 'file') {
      // ：TabFiles 走组织级 trash；resource_id = FileRecord id
      if (!item.organization_id) return null
      return API_ENDPOINTS.ORGANIZATION.FILE_TRASH(item.organization_id, resourceId)
    }
    const routes: Record<string, string> = {
      tabdoc: `/tabdoc/documents/${resourceId}/trash`,
      tabdata: `/tabdata/tables/${resourceId}/trash`,
      tabslide: `/tabslide/projects/${resourceId}/trash/`,
    }
    return routes[item.item_type] ?? null
  }

  static async trashContextResource(
    item: Pick<SpaceContextItem, 'id' | 'item_type' | 'resource_id' | 'space_id' | 'organization_id'>,
  ): Promise<boolean> {
    const path = this.getTrashContextResourcePath(item)
    if (!path) return false

    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), path),
      method: 'POST',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to move resource to trash')
    }
    const responseData = response.data
    if (responseData && responseData.success === false) {
      throw new Error(responseData.message || 'Failed to move resource to trash')
    }
    return true
  }

  // ── Collection（文件夹）API ──

  static async listCollections(spaceId: string): Promise<{ collections: SpaceCollection[]; total: number }> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.WORKSPACE.COLLECTIONS(spaceId)),
      method: 'GET',
    })
    if (!response?.data?.success) {
      throw new Error(response?.data?.message || 'Failed to list collections')
    }
    return response.data.data ?? { collections: [], total: 0 }
  }

  static async createCollection(spaceId: string, data: { name: string; parent_id?: string | null; icon?: string; color?: string; order?: number }): Promise<SpaceCollection> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.WORKSPACE.COLLECTIONS(spaceId)),
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || 'Failed to create collection')
    return response.data.data
  }

  static async updateCollection(collectionId: string, data: { name?: string; parent_id?: string | null; icon?: string; color?: string; order?: number; is_expanded?: boolean; is_pinned?: boolean }): Promise<SpaceCollection> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `/context/collections/${collectionId}`),
      method: 'PATCH',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || 'Failed to update collection')
    return response.data.data
  }

  static async deleteCollection(collectionId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `/context/collections/${collectionId}`),
      method: 'DELETE',
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || 'Failed to delete collection')
  }

  static async reorderCollections(
    spaceId: string,
    collectionIds: string[],
    parentId?: string | null,
  ): Promise<void> {
    await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.WORKSPACE.COLLECTIONS_REORDER(spaceId)),
      method: 'POST',
      body: JSON.stringify({
        collection_ids: collectionIds,
        parent_id: parentId ?? null,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  static async moveItemsToCollection(spaceId: string, data: { item_ids: string[]; collection_id?: string | null }): Promise<{ updated: number }> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.WORKSPACE.COLLECTIONS_MOVE_ITEMS(spaceId)),
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || 'Failed to move items')
    return response.data.data
  }

  static async reorderCollectionItems(
    spaceId: string,
    data: { item_ids: string[]; collection_id?: string | null },
  ): Promise<{ updated: number }> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.WORKSPACE.COLLECTIONS_REORDER_ITEMS(spaceId)),
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || 'Failed to reorder items')
    return response.data.data
  }

  // ── Organization Collection（组织级文件夹，）API ──
  // 云文档/云盘不再挂 workspace 宿主；Collection 直接归属 Organization。
  // update/delete 复用通用 `/context/collections/{id}`（宿主无关，见上方 update/deleteCollection）。

  static async listOrganizationCollections(
    organizationId: string,
  ): Promise<{ collections: SpaceCollection[]; total: number }> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.COLLECTIONS(organizationId)),
      method: 'GET',
    })
    if (!response?.data?.success) {
      throw new Error(response?.data?.message || 'Failed to list organization collections')
    }
    return response.data.data ?? { collections: [], total: 0 }
  }

  static async createOrganizationCollection(
    organizationId: string,
    data: { name: string; parent_id?: string | null; icon?: string; color?: string; order?: number },
  ): Promise<SpaceCollection> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.COLLECTIONS(organizationId)),
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response?.data?.success) {
      throw new Error(response?.data?.message || 'Failed to create organization collection')
    }
    return response.data.data
  }

  static async reorderOrganizationCollections(organizationId: string, collectionIds: string[]): Promise<void> {
    await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.COLLECTIONS_REORDER(organizationId)),
      method: 'POST',
      body: JSON.stringify({ collection_ids: collectionIds }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  static async moveItemsToOrganizationCollection(
    organizationId: string,
    data: { item_ids: string[]; collection_id?: string | null },
  ): Promise<{ updated: number }> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.ORGANIZATION.COLLECTIONS_MOVE_ITEMS(organizationId)),
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response?.data?.success) throw new Error(response?.data?.message || 'Failed to move items')
    return response.data.data
  }
}

export class WorkspaceApiService {
  static async list(organizationId?: string): Promise<WorkspaceSummary[]> {
    const query = organizationId
      ? `?organization_id=${encodeURIComponent(organizationId)}`
      : ''
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.WORKSPACE.LIST}${query}`),
      method: 'GET',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to list workspaces')
    }
    return Array.isArray(response.data.data?.workspaces)
      ? response.data.data.workspaces as WorkspaceSummary[]
      : []
  }

  static async create(data: {
    organization_id: string
    device_id?: string
    device_installation_id?: string
    working_dir: string
    working_dir_type?: string
    name?: string
  }): Promise<WorkspaceSummary> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.WORKSPACE.CREATE),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response || response.status !== 201 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to create workspace')
    }
    return response.data.data as WorkspaceSummary
  }

  static async ensureHome(data: {
    organization_id: string
    device_id: string
    working_dir: string
    working_dir_type?: string
    name?: string
  }): Promise<WorkspaceSummary> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.WORKSPACE.ENSURE_HOME),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to ensure home workspace')
    }
    return response.data.data as WorkspaceSummary
  }

  static async update(
    workspaceId: string,
    data: Pick<
      UpdateSpaceRequest,
      | 'name'
      | 'description'
      | 'working_dir'
      | 'working_dir_type'
      | 'device_fingerprint'
      | 'custom_rules'
      | 'execution_limits'
    >,
  ): Promise<WorkspaceSummary> {
    const body: Record<string, unknown> = {}
    if (data.name !== undefined) body.name = data.name
    if (data.description !== undefined) body.description = data.description
    if (data.working_dir !== undefined) body.working_dir = data.working_dir
    if (data.working_dir_type !== undefined) body.working_dir_type = data.working_dir_type
    if (data.device_fingerprint !== undefined) body.device_fingerprint = data.device_fingerprint
    if (data.custom_rules !== undefined) body.custom_rules = data.custom_rules
    if (data.execution_limits !== undefined) body.execution_limits = data.execution_limits
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `/context/workspaces/${workspaceId}`),
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to update workspace')
    }
    return response.data.data as WorkspaceSummary
  }

  static async updateApprovalGrant(
    workspaceId: string,
    approvalGrant: WorkspaceSummary['approval_grant'],
  ): Promise<WorkspaceSummary> {
    const response = await authenticatedRequest({
      url: joinApiPath(
        apiBaseUrl(),
        API_ENDPOINTS.WORKSPACE.APPROVAL_GRANT(workspaceId),
      ),
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_grant: approvalGrant }),
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(
        response?.data?.message || 'Failed to update workspace approval grant',
      )
    }
    return response.data.data as WorkspaceSummary
  }

  static async delete(workspaceId: string, deviceId?: string | null): Promise<void> {
    const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `/context/workspaces/${workspaceId}${query}`),
      method: 'DELETE',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to delete workspace')
    }
  }
}

/** ：团队协作场真表 API（替代 listSpaces type=team_space） */
export class ProjectApiService {
  static async list(organizationId?: string): Promise<SpaceListResponse> {
    if (!organizationId) {
      return { spaces: [], total: 0 }
    }
    const query = `?organization_id=${encodeURIComponent(organizationId)}`
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.PROJECT.LIST}${query}`),
      method: 'GET',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to list projects')
    }
    const rawProjects = Array.isArray(response.data.data?.projects)
      ? response.data.data.projects
      : []
    // Project 契约用 primary_agent_id；Space 消费方读 agent_id / execution_agent_id。
    const projects = rawProjects.map((project: Space & { primary_agent_id?: string | null }) => {
      const agentId = project.agent_id ?? project.primary_agent_id ?? null
      return {
        ...project,
        type: project.type || 'team_space',
        agent_id: agentId,
        execution_agent_id: project.execution_agent_id ?? agentId,
      } as Space
    })
    return {
      spaces: projects,
      total: typeof response.data.data?.total === 'number'
        ? response.data.data.total
        : projects.length,
    }
  }

  /** ：归档 Project */
  static async archive(projectId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.PROJECT.ARCHIVE(projectId)),
      method: 'POST',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to archive project')
    }
  }

  /** ：从归档恢复 Project */
  static async restore(projectId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.PROJECT.RESTORE(projectId)),
      method: 'POST',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to restore project')
    }
  }

  /** ：Project 移入回收站 */
  static async trash(projectId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.PROJECT.TRASH(projectId)),
      method: 'POST',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to trash project')
    }
  }

  /** ：从回收站恢复 Project */
  static async restoreFromTrash(projectId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.PROJECT.RESTORE_FROM_TRASH(projectId)),
      method: 'POST',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to restore project from trash')
    }
  }

  /** ：从回收站永久删除 Project */
  static async permanentDeleteFromTrash(projectId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.PROJECT.PERMANENT_FROM_TRASH(projectId)),
      method: 'DELETE',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to permanently delete project from trash')
    }
  }

  /** ：组织内已回收的 Project 列表 */
  static async listTrashed(organizationId: string): Promise<TrashedSpacesResponse> {
    const response = await authenticatedRequest({
      url: joinApiPath(
        apiBaseUrl(),
        API_ENDPOINTS.ORGANIZATION.TRASHED_PROJECTS(organizationId),
      ),
      method: 'GET',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to list trashed projects')
    }
    return response.data.data as TrashedSpacesResponse
  }
}

export class AgentApiService {
  static async listAgents(organizationId: string): Promise<Agent[]> {
    const response = await authenticatedRequest({
      url: joinApiPath(
        apiBaseUrl(),
        API_ENDPOINTS.ORGANIZATION_AGENT.LIST(organizationId),
      ),
      method: 'GET',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to list agents')
    }
    return (response.data.data?.agents ?? []) as Agent[]
  }

  static async createAgent(data: CreateAgentRequest): Promise<Agent> {
    if (!data.name || data.name.trim().length === 0) {
      throw new Error('Agent name is required')
    }
    if (!data.organization_id) {
      throw new Error('Organization ID is required')
    }

    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.AGENT.CREATE}`),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (!response || response.status !== 201) {
      throw new Error(response?.data?.message || 'Failed to create agent')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to create agent')
    }
    const agentData = responseData.data
    if (!agentData?.id) {
      throw new Error('Invalid create agent response')
    }
    return agentData as Agent
  }

  static async getAgent(agentId: string): Promise<Agent> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.AGENT.DETAIL(agentId)}`),
      method: 'GET',
    })

    if (!response || response.status !== 200) {
      throw new Error(
        normalizeAgentApiMessage(response?.data?.message, 'Failed to get agent'),
      )
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(
        normalizeAgentApiMessage(responseData?.message, 'Failed to get agent'),
      )
    }
    const agentData = responseData.data
    if (!agentData?.id) {
      throw new Error('Invalid agent detail response')
    }
    return agentData as Agent
  }

  static async updateAgent(agentId: string, data: UpdateAgentRequest): Promise<Agent> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.AGENT.UPDATE(agentId)}`),
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (!response || response.status !== 200) {
      throw new Error(formatApiErrorMessage(response?.data, 'Failed to update agent'))
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(formatApiErrorMessage(responseData, 'Failed to update agent'))
    }
    const agentData = responseData.data
    if (!agentData?.id) {
      throw new Error('Invalid update agent response')
    }
    return agentData as Agent
  }

  static async deleteAgent(agentId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.AGENT.DELETE(agentId)}`),
      method: 'DELETE',
    })
    if (!response || (response.status !== 200 && response.status !== 204)) {
      throw new Error(response?.data?.message || 'Failed to delete agent')
    }
  }

  static async permanentDeleteAgent(agentId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.AGENT.PERMANENT_DELETE(agentId)}`),
      method: 'DELETE',
    })
    if (!response || (response.status !== 200 && response.status !== 204)) {
      throw new Error(response?.data?.message || 'Failed to permanently delete agent')
    }
    if (response.data && response.data.success === false) {
      throw new Error(response.data.message || 'Failed to permanently delete agent')
    }
  }

  static async reactivateAgent(agentId: string): Promise<Agent> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.AGENT.REACTIVATE(agentId)}`),
      method: 'POST',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || 'Failed to reactivate agent')
    }
    const responseData = response.data
    if (!responseData?.success) {
      throw new Error(responseData?.message || 'Failed to reactivate agent')
    }
    const agentData = responseData.data
    if (!agentData?.id) {
      throw new Error('Invalid reactivate agent response')
    }
    return agentData as Agent
  }

  static async updatePreferredModel(agentId: string, modelId: string): Promise<void> {
    await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), `${API_ENDPOINTS.AGENT.PREFERRED_MODEL(agentId)}`),
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId }),
    })
  }
}

/**
 * Agent.agent_config.approval_memo（PRD 05 v0.4 §7.3 + §8.1.2）。
 *
 * 跟 ``packages/agent-runtime`` 里的 ``createApprovalMemoCommitClient`` /
 * ``createApprovalMemoRefetchClient`` 是平行的两个客户端：
 *
 * - **agent-runtime memo-sync-client**：runtime 在用户点"总是同意"时上行 commit；
 *   refetch 用于 bootstrap / WS broadcast 触发的失效重拉。fail-soft 不抛错。
 * - **本 Service**：renderer 在 UI（``AgentSecurityPanel`` 等）显式撤销 always
 *   memo 时调用。需要把成功结果同步回 store（``selectedAgent.agent_config``），
 *   因此**抛错**给上层走 toast 反馈，跟 ``AgentApiService.updateAgent`` 同语义。
 *
 * URL 模式从 ``API_ENDPOINTS.APPROVAL_MEMO`` 取，避免再现"前缀漂移成 /space"
 * 或漏 ``/context`` 的 404 静默失败。
 */
export class ApprovalMemoApiService {
  static async get(workspaceId: string): Promise<{
    version: number
    entries: Record<string, {
      decision?: string
      scope_description?: string
    }>
    generation: number
  }> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.APPROVAL_MEMO.GET(workspaceId)),
      method: 'GET',
    })
    if (!response || response.status !== 200 || !response.data?.success) {
      throw new Error(response?.data?.message || 'Failed to get approval memo')
    }
    return response.data.data
  }

  /**
   * 单条删除（editor 及以上 + optimistic lock）。
   *
   * @param lastSeenGeneration 客户端已知的 ``approval_memo.generation``，
   *   服务端比对失败抛 409 ``GENERATION_CONFLICT``。从
   *   ``Agent.agent_config.approval_memo.generation`` 取；首次写入传 0。
   */
  static async deleteEntry(
    workspaceId: string,
    entryKey: string,
    lastSeenGeneration: number,
  ): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.APPROVAL_MEMO.DELETE(workspaceId, entryKey)),
      method: 'DELETE',
      headers: { 'If-Match': String(lastSeenGeneration) },
    })
    if (!response || response.status !== 200) {
      const code = response?.data?.code
      const msg = response?.data?.message || `Failed to delete approval memo (status=${response?.status})`
      const err = new Error(msg) as Error & { code?: string; status?: number }
      err.code = typeof code === 'string' ? code : undefined
      err.status = response?.status
      throw err
    }
    if (!response.data?.success) {
      throw new Error(response.data?.message || 'Failed to delete approval memo')
    }
  }

  /**
   * 清空所有 always memo（无 If-Match，因为是用户主动一键全清）。
   */
  static async revokeAll(workspaceId: string): Promise<void> {
    const response = await authenticatedRequest({
      url: joinApiPath(apiBaseUrl(), API_ENDPOINTS.APPROVAL_MEMO.REVOKE_ALL(workspaceId)),
      method: 'POST',
    })
    if (!response || response.status !== 200) {
      throw new Error(response?.data?.message || `Failed to revoke all approval memos (status=${response?.status})`)
    }
    if (!response.data?.success) {
      throw new Error(response.data?.message || 'Failed to revoke all approval memos')
    }
  }
}
