import { getApiClient } from '@/api/tabtin-client'
import type {
  AdminUpdateActionResponse,
  AdminUpdateAssetActionResponse,
  AdminUpdateManifestPreview,
  AdminUpdateOverview,
  AdminUpdatePushPayload,
  AdminUpdateReleaseAssetCompletePayload,
  AdminUpdateReleaseAssetUploadIntent,
  AdminUpdateReleaseAssetUploadIntentPayload,
  AdminUpdateReleaseCreatePayload,
  AdminUpdateReleaseDetail,
  AdminUpdateReleaseListResponse,
  AdminUpdateReleaseQuery,
  AdminUpdateReleaseReadiness,
  AdminUpdateReleaseUpdatePayload,
} from '@/update-management/types'

function getErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const record = body as Record<string, unknown>
  const directMessage = record.message
  if (typeof directMessage === 'string' && directMessage.trim()) return directMessage
  const detail = record.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object') {
    const detailMessage = (detail as Record<string, unknown>).message
    if (typeof detailMessage === 'string' && detailMessage.trim()) return detailMessage
  }
  return fallback
}

async function rawAction<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await getApiClient().raw(method, path, {
    rawResponse: true,
    ...(body === undefined ? {} : { body }),
  }) as Response

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok || !payload || typeof payload !== 'object') {
    throw new Error(getErrorMessage(payload, `${method.toUpperCase()} ${path} failed`))
  }

  const record = payload as Record<string, unknown>
  if ('success' in record && record.success === false) {
    throw new Error(getErrorMessage(payload, '操作失败'))
  }

  return payload as T
}

export async function getDesktopUpdateOverview(): Promise<AdminUpdateOverview> {
  return getApiClient().raw<AdminUpdateOverview>('GET', '/auth/admin/desktop-updates/overview')
}

export async function getDesktopUpdateReleases(
  params: AdminUpdateReleaseQuery = {}
): Promise<AdminUpdateReleaseListResponse> {
  const query = new URLSearchParams()

  if (params.keyword) query.set('keyword', params.keyword)
  if (params.channel) query.set('channel', params.channel)
  if (params.platform) query.set('platform', params.platform)
  if (params.arch) query.set('arch', params.arch)
  if (params.status) query.set('status', params.status)
  if (params.page) query.set('page', String(params.page))
  if (params.page_size) query.set('page_size', String(params.page_size))

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminUpdateReleaseListResponse>(
    'GET',
    `/auth/admin/desktop-updates/releases${suffix}`
  )
}

export async function getDesktopUpdateReleaseDetail(
  releaseId: number
): Promise<AdminUpdateReleaseDetail> {
  return getApiClient().raw<AdminUpdateReleaseDetail>(
    'GET',
    `/auth/admin/desktop-updates/releases/${releaseId}`
  )
}

export async function checkDesktopUpdateReleaseReadiness(
  releaseId: number
): Promise<AdminUpdateReleaseReadiness> {
  return getApiClient().raw<AdminUpdateReleaseReadiness>(
    'POST',
    `/auth/admin/desktop-updates/releases/${releaseId}/readiness-check`
  )
}

export async function getDesktopUpdateReleaseManifestPreview(
  releaseId: number
): Promise<AdminUpdateManifestPreview> {
  return getApiClient().raw<AdminUpdateManifestPreview>(
    'GET',
    `/auth/admin/desktop-updates/releases/${releaseId}/manifest-preview`
  )
}

export async function createDesktopUpdateReleaseAssetUploadIntent(
  releaseId: number,
  payload: AdminUpdateReleaseAssetUploadIntentPayload
): Promise<AdminUpdateReleaseAssetUploadIntent> {
  return getApiClient().raw<AdminUpdateReleaseAssetUploadIntent>(
    'POST',
    `/auth/admin/desktop-updates/releases/${releaseId}/asset-upload-intent`,
    {
      body: payload,
    }
  )
}

export async function completeDesktopUpdateReleaseAssetUpload(
  releaseId: number,
  payload: AdminUpdateReleaseAssetCompletePayload
): Promise<AdminUpdateAssetActionResponse> {
  return rawAction<AdminUpdateAssetActionResponse>(
    'POST',
    `/auth/admin/desktop-updates/releases/${releaseId}/asset-upload-complete`,
    payload
  )
}

export async function generateDesktopUpdateReleaseManifest(
  releaseId: number
): Promise<AdminUpdateAssetActionResponse> {
  return rawAction<AdminUpdateAssetActionResponse>(
    'POST',
    `/auth/admin/desktop-updates/releases/${releaseId}/manifest-generate`
  )
}

export async function createDesktopUpdateRelease(
  payload: AdminUpdateReleaseCreatePayload
): Promise<AdminUpdateActionResponse> {
  return rawAction<AdminUpdateActionResponse>(
    'POST',
    '/auth/admin/desktop-updates/releases',
    payload
  )
}

export async function updateDesktopUpdateRelease(
  releaseId: number,
  payload: AdminUpdateReleaseUpdatePayload
): Promise<AdminUpdateActionResponse> {
  return rawAction<AdminUpdateActionResponse>(
    'PUT',
    `/auth/admin/desktop-updates/releases/${releaseId}`,
    payload
  )
}

export async function publishDesktopUpdateRelease(
  releaseId: number
): Promise<AdminUpdateActionResponse> {
  return rawAction<AdminUpdateActionResponse>(
    'POST',
    `/auth/admin/desktop-updates/releases/${releaseId}/publish`
  )
}

export async function pushDesktopUpdateRelease(
  releaseId: number,
  payload: AdminUpdatePushPayload
): Promise<AdminUpdateActionResponse> {
  return rawAction<AdminUpdateActionResponse>(
    'POST',
    `/auth/admin/desktop-updates/releases/${releaseId}/push`,
    payload
  )
}

export async function rolloutDesktopUpdateRelease(
  releaseId: number,
  rolloutPercentage: number
): Promise<AdminUpdateActionResponse> {
  return rawAction<AdminUpdateActionResponse>(
    'POST',
    `/auth/admin/desktop-updates/releases/${releaseId}/rollout`,
    { rollout_percentage: rolloutPercentage }
  )
}

export async function deprecateDesktopUpdateRelease(
  releaseId: number
): Promise<AdminUpdateActionResponse> {
  return rawAction<AdminUpdateActionResponse>(
    'POST',
    `/auth/admin/desktop-updates/releases/${releaseId}/deprecate`
  )
}
