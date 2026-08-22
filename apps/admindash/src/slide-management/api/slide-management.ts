import { rawJson } from '@/api/raw-json'
import { getApiClient } from '@/api/tabtin-client'
import type {
  AdminSlideBatchActionResponse,
  AdminSlideDetailResponse,
  AdminSlideListResponse,
  AdminSlideOperationDetailResponse,
  AdminSlideOperationsQuery,
  AdminSlideOperationsResponse,
  AdminSlideQuery,
} from '@/slide-management/types'

interface SensitiveActionPayload {
  reason: string
  ticket_id?: string
}

export async function getAdminSlides(
  params: AdminSlideQuery = {}
): Promise<AdminSlideListResponse> {
  const query = new URLSearchParams()
  if (params.keyword) query.set('keyword', params.keyword)
  if (params.status) query.set('status', params.status)
  if (params.attention) query.set('attention', params.attention)
  if (params.organization_id) query.set('organization_id', params.organization_id)
  if (params.organization_query) query.set('organization_query', params.organization_query)
  if (params.space_id) query.set('space_id', params.space_id)
  if (params.space_query) query.set('space_query', params.space_query)
  if (params.updated_by_id) query.set('updated_by_id', params.updated_by_id)
  if (params.page) query.set('page', String(params.page))
  if (params.page_size) query.set('page_size', String(params.page_size))

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminSlideListResponse>('GET', `/auth/admin/slides${suffix}`)
}

export async function getAdminSlideDetail(slideId: string): Promise<AdminSlideDetailResponse> {
  return getApiClient().raw<AdminSlideDetailResponse>('GET', `/auth/admin/slides/${slideId}`)
}

export async function getAdminSlideOperations(
  params: AdminSlideOperationsQuery = {}
): Promise<AdminSlideOperationsResponse> {
  const query = new URLSearchParams()
  if (params.action_type) query.set('action_type', params.action_type)
  if (params.success !== undefined) query.set('success', String(params.success))
  if (params.keyword) query.set('keyword', params.keyword)
  if (params.slide_id) query.set('slide_id', params.slide_id)
  if (params.operation_id) query.set('operation_id', params.operation_id)
  if (params.page) query.set('page', String(params.page))
  if (params.page_size) query.set('page_size', String(params.page_size))

  const suffix = query.toString() ? `?${query.toString()}` : ''
  return getApiClient().raw<AdminSlideOperationsResponse>(
    'GET',
    `/auth/admin/slides/operations${suffix}`
  )
}

export async function getAdminSlideOperationDetail(
  operationId: string
): Promise<AdminSlideOperationDetailResponse> {
  return getApiClient().raw<AdminSlideOperationDetailResponse>(
    'GET',
    `/auth/admin/slides/operations/${operationId}`
  )
}

export async function archiveAdminSlide(
  slideId: string,
  payload: SensitiveActionPayload
): Promise<{ message: string }> {
  return rawJson<{ message: string }>('POST', `/auth/admin/slides/${slideId}/status/archive`, {
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function restoreAdminSlide(
  slideId: string,
  payload: SensitiveActionPayload
): Promise<{ message: string }> {
  return rawJson<{ message: string }>('POST', `/auth/admin/slides/${slideId}/status/restore`, {
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function batchArchiveAdminSlides(
  slideIds: string[],
  payload: SensitiveActionPayload
): Promise<AdminSlideBatchActionResponse> {
  return rawJson<AdminSlideBatchActionResponse>('POST', '/auth/admin/slides/batch/archive', {
    slide_ids: slideIds,
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}

export async function batchRestoreAdminSlides(
  slideIds: string[],
  payload: SensitiveActionPayload
): Promise<AdminSlideBatchActionResponse> {
  return rawJson<AdminSlideBatchActionResponse>('POST', '/auth/admin/slides/batch/restore', {
    slide_ids: slideIds,
    reason: payload.reason,
    ticket_id: payload.ticket_id ?? '',
  })
}
