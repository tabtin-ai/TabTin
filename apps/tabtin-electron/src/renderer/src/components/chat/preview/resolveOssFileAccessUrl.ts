/**
 * 按 file_id 换取 OSS FileRecord 访问信息（cdn_url || access_url）。
 * 供图片预览、Office/PDF buffer、以及聊天附件 UUID 被误开成 file tab 时的远端预览共用。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, unwrapData } from '@/services/apiBase'
import { registerResetAction } from '@/stores/sessionResetRegistry'
import { useAuthStore } from '@/stores/useAuthStore'
import {
  isOssFileUrlFresh,
  resolveOssFileUrl,
  resolveOssFileUrlExpiry,
} from './ossFileUrlExpiry'

export interface OssFileDetail {
  fileId: string
  fileName: string
  url: string
  mimeType?: string
  fileType?: string
  fileSize?: number
}

interface OssFileDetailResponse {
  file_id: string
  file_name: string
  access_url: string
  cdn_url?: string
  resolved_url?: string
  expires_at?: string | null
  expires_in?: number | null
  mime_type?: string
  file_type?: string
  file_size?: number
}

interface CachedOssFileDetail {
  detail: OssFileDetail
  expiresAt: number
}

const detailCache = new Map<string, CachedOssFileDetail>()
const inFlight = new Map<string, Promise<OssFileDetail>>()
const forcedInFlight = new Map<string, Promise<OssFileDetail>>()
const requestGeneration = new Map<string, number>()
let cacheEpoch = 0

function scopedCacheKey(fileId: string): string | null {
  const userId = useAuthStore.getState().user?.id
  return userId ? `${String(userId)}:${fileId}` : null
}

const FILE_RECORD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** FileRecord UUID（聊天附件 / OSS 上传产物），区别于 working_dir 相对路径。 */
export function isFileRecordId(id: string | null | undefined): boolean {
  return typeof id === 'string' && FILE_RECORD_ID_RE.test(id.trim())
}

async function fetchOssFileDetail(fileId: string): Promise<CachedOssFileDetail> {
  const url = joinApiPath(API_CONFIG.baseURL, `/services/oss/files/${encodeURIComponent(fileId)}`)
  const detail = await unwrapData<OssFileDetailResponse>(
    await apiRequest({ url, method: 'GET' }),
    'file info failed',
  )
  const resolvedUrl = resolveOssFileUrl(detail)
  if (!resolvedUrl) {
    throw new Error('OSS file has no access url')
  }
  return {
    detail: {
      fileId: detail.file_id || fileId,
      fileName: detail.file_name || fileId,
      url: resolvedUrl,
      mimeType: detail.mime_type,
      fileType: detail.file_type,
      fileSize: detail.file_size,
    },
    expiresAt: resolveOssFileUrlExpiry(detail),
  }
}

export async function resolveOssFileDetail(
  fileId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<OssFileDetail> {
  const cacheKey = scopedCacheKey(fileId)
  if (!cacheKey) {
    return (await fetchOssFileDetail(fileId)).detail
  }
  if (options.forceRefresh) {
    const existingForced = forcedInFlight.get(cacheKey)
    if (existingForced) return existingForced
    const epoch = cacheEpoch
    const generation = (requestGeneration.get(cacheKey) ?? 0) + 1
    requestGeneration.set(cacheKey, generation)
    const forced = fetchOssFileDetail(fileId)
      .then((fresh) => {
        if (cacheEpoch === epoch && requestGeneration.get(cacheKey) === generation) {
          detailCache.set(cacheKey, fresh)
        }
        return fresh.detail
      })
      .finally(() => {
        if (forcedInFlight.get(cacheKey) === forced) {
          forcedInFlight.delete(cacheKey)
        }
      })
    forcedInFlight.set(cacheKey, forced)
    return forced
  }
  const cached = detailCache.get(cacheKey)
  if (cached && isOssFileUrlFresh(cached.expiresAt)) return cached.detail
  if (cached) detailCache.delete(cacheKey)
  const existing = inFlight.get(cacheKey)
  if (existing) return existing
  const epoch = cacheEpoch
  const generation = requestGeneration.get(cacheKey) ?? 0
  const p = fetchOssFileDetail(fileId)
    .then((cachedDetail) => {
      if (
        cacheEpoch === epoch
        && (requestGeneration.get(cacheKey) ?? 0) === generation
      ) {
        detailCache.set(cacheKey, cachedDetail)
      }
      return cachedDetail.detail
    })
    .finally(() => {
      if (inFlight.get(cacheKey) === p) {
        inFlight.delete(cacheKey)
      }
    })
  inFlight.set(cacheKey, p)
  return p
}

export function peekCachedOssFileDetail(fileId: string): OssFileDetail | undefined {
  const cacheKey = scopedCacheKey(fileId)
  if (!cacheKey) return undefined
  const cached = detailCache.get(cacheKey)
  if (cached && isOssFileUrlFresh(cached.expiresAt)) return cached.detail
  return undefined
}

export async function resolveOssFileAccessUrl(
  fileId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const detail = await resolveOssFileDetail(fileId, options)
  return detail.url
}

/** 测试用：清空 URL / detail 缓存 */
export function _clearOssFileAccessUrlCache(): void {
  cacheEpoch += 1
  detailCache.clear()
  inFlight.clear()
  forcedInFlight.clear()
  requestGeneration.clear()
}

registerResetAction('oss-file-access-url-cache', 'cleanup', _clearOssFileAccessUrlCache)
