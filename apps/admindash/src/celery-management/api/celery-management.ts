import { getApiClient } from '@/api/tabtin-client'
import type {
  BatchResolveResponse,
  CeleryOverview,
  FailedTaskDetail,
  FailedTaskListResponse,
  FailedTaskQuery,
  RetryResponse,
} from '@/celery-management/types'

export async function getCeleryOverview(): Promise<CeleryOverview> {
  return getApiClient().raw<CeleryOverview>('GET', '/auth/admin/maintenance/celery/overview')
}

export async function getFailedTasks(
  params: FailedTaskQuery = {}
): Promise<FailedTaskListResponse> {
  const query = new URLSearchParams()
  if (params.resolved && params.resolved !== 'all') {
    query.set('resolved', params.resolved)
  }
  if (params.task_name) {
    query.set('task_name', params.task_name)
  }
  if (params.page) {
    query.set('page', String(params.page))
  }
  if (params.page_size) {
    query.set('page_size', String(params.page_size))
  }
  const qs = query.toString()
  return getApiClient().raw<FailedTaskListResponse>(
    'GET',
    `/auth/admin/maintenance/celery/failed-tasks${qs ? `?${qs}` : ''}`
  )
}

export async function getFailedTaskDetail(id: number): Promise<FailedTaskDetail> {
  return getApiClient().raw<FailedTaskDetail>(
    'GET',
    `/auth/admin/maintenance/celery/failed-tasks/${id}`
  )
}

export async function resolveFailedTask(id: number): Promise<FailedTaskDetail> {
  return getApiClient().raw<FailedTaskDetail>(
    'POST',
    `/auth/admin/maintenance/celery/failed-tasks/${id}/resolve`
  )
}

export async function retryFailedTask(id: number): Promise<RetryResponse> {
  return getApiClient().raw<RetryResponse>(
    'POST',
    `/auth/admin/maintenance/celery/failed-tasks/${id}/retry`
  )
}

export async function batchResolveFailedTasks(ids: number[]): Promise<BatchResolveResponse> {
  return getApiClient().raw<BatchResolveResponse>(
    'POST',
    '/auth/admin/maintenance/celery/failed-tasks/batch-resolve',
    {
      body: { ids },
    }
  )
}
