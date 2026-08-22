/**
 * 存储分析 API — Phase 1
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, unwrapData } from '@/services/apiBase'
import i18n from '@/i18n'

// ── Types ──────────────────────────────────────────────────────────────

export interface StorageModuleBreakdown {
  module: string
  display_name: string
  file_count: number
  total_bytes: number
}

export interface StorageOverview {
  quota_bytes: number
  used_bytes: number
  used_pct: number
  file_count: number
  approximate: boolean
  by_module: StorageModuleBreakdown[]
}

export interface StorageMemberBreakdown {
  user_id: string
  display_name: string
  file_count: number
  total_bytes: number
}

export interface StorageFileTypeBreakdown {
  file_type: string
  file_count: number
  total_bytes: number
}

export interface StorageLargeFileItem {
  file_id: string
  file_name: string
  file_size: number
  file_type: string
  mime_type: string
  module: string
  module_display: string
  context_type: string
  context_id: string
  context_display: string
  upload_user: string
  upload_user_display: string
  created_at: string
  cdn_url: string
}

// ── Phase 2 Types ──────────────────────────────────────────────────────

export interface StorageFileItem {
  file_id: string
  file_name: string
  file_size: number
  file_type: string
  mime_type: string
  module: string
  module_display: string
  context_type: string
  context_id: string
  context_display: string
  upload_user: string
  upload_user_display: string
  created_at: string
  cdn_url: string
  ref_count: number
  is_safe_to_delete: boolean
}

export interface StorageFileListParams {
  module?: string
  file_type?: string
  min_size?: number
  max_size?: number
  uploaded_after?: string
  uploaded_before?: string
  search?: string
  sort?: string
  cursor?: string
  limit?: number
}

export interface StorageFileListResponse {
  items: StorageFileItem[]
  next_cursor: string | null
  has_more: boolean
  total_estimate: number
}

export interface StorageFileUsageItem {
  usage_id: string
  module: string
  module_display: string
  context_type: string
  context_id: string
  is_active: boolean
  created_at: string
}

export interface StorageBatchDeleteResponse {
  success_count: number
  failed_count: number
  results: Array<{
    file_id: string
    success: boolean
    message: string
    usage_count_removed: number
  }>
}

// ── API ────────────────────────────────────────────────────────────────

const BASE = joinApiPath(API_CONFIG.baseURL, `/services/oss/storage`)

function errMsg(): string {
  return i18n.t('settings:storage.errors.loadFailed', { defaultValue: 'Failed to load storage data' })
}

export class StorageAnalyticsApi {
  static async getOverview(organizationId: string): Promise<StorageOverview> {
    const url = `${BASE}/overview?organization_id=${encodeURIComponent(organizationId)}`
    const res = await apiRequest({ url, method: 'GET' })
    return unwrapData<StorageOverview>(res, errMsg())
  }

  static async getByModule(organizationId: string): Promise<StorageModuleBreakdown[]> {
    const url = `${BASE}/by-module?organization_id=${encodeURIComponent(organizationId)}`
    const res = await apiRequest({ url, method: 'GET' })
    return unwrapData<StorageModuleBreakdown[]>(res, errMsg())
  }

  static async getByMember(organizationId: string, limit = 20): Promise<StorageMemberBreakdown[]> {
    const url = `${BASE}/by-member?organization_id=${encodeURIComponent(organizationId)}&limit=${limit}`
    const res = await apiRequest({ url, method: 'GET' })
    return unwrapData<StorageMemberBreakdown[]>(res, errMsg())
  }

  static async getByFileType(organizationId: string): Promise<StorageFileTypeBreakdown[]> {
    const url = `${BASE}/by-file-type?organization_id=${encodeURIComponent(organizationId)}`
    const res = await apiRequest({ url, method: 'GET' })
    return unwrapData<StorageFileTypeBreakdown[]>(res, errMsg())
  }

  static async getLargeFiles(organizationId: string, minSize = 1_048_576, limit = 10): Promise<StorageLargeFileItem[]> {
    const url = `${BASE}/large-files?organization_id=${encodeURIComponent(organizationId)}&min_size=${minSize}&limit=${limit}`
    const res = await apiRequest({ url, method: 'GET' })
    return unwrapData<StorageLargeFileItem[]>(res, errMsg())
  }

  // ── Phase 2: 文件管理 ─────────────────────────────────────────────

  static async listFiles(organizationId: string, params: StorageFileListParams = {}): Promise<StorageFileListResponse> {
    const query = new URLSearchParams()
    query.set('organization_id', organizationId)
    if (params.module) query.set('module', params.module)
    if (params.file_type) query.set('file_type', params.file_type)
    if (params.min_size) query.set('min_size', String(params.min_size))
    if (params.max_size) query.set('max_size', String(params.max_size))
    if (params.uploaded_after) query.set('uploaded_after', params.uploaded_after)
    if (params.uploaded_before) query.set('uploaded_before', params.uploaded_before)
    if (params.search) query.set('search', params.search)
    if (params.sort) query.set('sort', params.sort)
    if (params.cursor) query.set('cursor', params.cursor)
    if (params.limit) query.set('limit', String(params.limit))
    const url = `${BASE}/files?${query.toString()}`
    const res = await apiRequest({ url, method: 'GET' })
    return unwrapData<StorageFileListResponse>(res, errMsg())
  }

  static async getFileUsages(organizationId: string, fileId: string): Promise<StorageFileUsageItem[]> {
    const url = `${BASE}/files/${encodeURIComponent(fileId)}/usages?organization_id=${encodeURIComponent(organizationId)}`
    const res = await apiRequest({ url, method: 'GET' })
    return unwrapData<StorageFileUsageItem[]>(res, errMsg())
  }

  static async batchDeleteFiles(organizationId: string, fileIds: string[]): Promise<StorageBatchDeleteResponse> {
    const url = `${BASE}/files/batch-delete?organization_id=${encodeURIComponent(organizationId)}`
    const res = await apiRequest({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_ids: fileIds }),
    })
    return unwrapData<StorageBatchDeleteResponse>(res,
      i18n.t('settings:storage.fileManager.deleteFailed', { defaultValue: 'Failed to delete files' }))
  }
}
