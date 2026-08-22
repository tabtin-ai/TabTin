/**
 * 客户端错误监控 - API 调用层
 */

import { getApiClient } from '@/api/tabtin-client'

export interface ErrorGroupItem {
  id: number
  fingerprint: string
  title: string
  level: string
  status: string
  first_seen: string | null
  last_seen: string | null
  event_count: number
  user_count: number
  sample_app_version: string
}

export interface ErrorGroupDetail extends ErrorGroupItem {
  sample_stack_trace: string
  resolved_stack_trace?: string
  /** React 组件栈：取该 group 最近一条事件的 component_stack（后端注入） */
  sample_component_stack?: string
  resolved_component_stack?: string
}

export interface ErrorEventItem {
  id: number
  group_id: number | null
  error_type: string
  message: string
  stack_trace: string
  /** React 组件栈：定位 React 渲染错误（ 等）的关键字段 */
  component_stack: string
  level: string
  source: string
  file: string
  line: number | null
  column: number | null
  user_id: string
  app_version: string
  electron_version: string
  os_name: string
  os_version: string
  arch: string
  locale: string
  occurred_at: string | null
  breadcrumbs?: Breadcrumb[]
  extra?: Record<string, unknown>
  resolved_stack_trace?: string
  resolved_component_stack?: string
}

export interface Breadcrumb {
  type: string
  category: string
  message: string
  timestamp: string
  data?: Record<string, unknown>
}

export interface Pagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export interface ErrorStats {
  period_hours: number
  total_events: number
  affected_users: number
  by_level: Record<string, number>
  by_source: Record<string, number>
  by_version: { app_version: string; count: number }[]
  open_groups: number
  total_groups: number
  trend: { time: string; count: number }[]
}

export interface ReleaseItem {
  app_version: string
  first_seen: string | null
  last_seen: string | null
  event_count: number
  new_group_count: number
  user_count: number
  vs_prev?: {
    prev_version: string
    event_change: number
    event_change_pct: number
    new_groups_introduced: number
  }
}

export interface ReleaseDetail extends ReleaseItem {
  by_level: Record<string, number>
  new_groups: {
    id: number
    title: string
    level: string
    status: string
    event_count: number
    user_count: number
    first_seen: string | null
  }[]
}

// ── API Functions ──

export async function fetchErrorGroups(params: {
  status?: string
  level?: string
  keyword?: string
  page?: number
  page_size?: number
}): Promise<{ items: ErrorGroupItem[]; pagination: Pagination }> {
  return getApiClient().raw('GET', '/auth/admin/client-errors/groups', { params })
}

export async function fetchErrorGroupDetail(groupId: number): Promise<ErrorGroupDetail> {
  return getApiClient().raw('GET', `/auth/admin/client-errors/groups/${groupId}`)
}

export async function fetchGroupEvents(
  groupId: number,
  params: { page?: number; page_size?: number } = {}
): Promise<{ items: ErrorEventItem[]; pagination: Pagination }> {
  return getApiClient().raw('GET', `/auth/admin/client-errors/groups/${groupId}/events`, { params })
}

export async function fetchEventDetail(eventId: number): Promise<ErrorEventItem> {
  return getApiClient().raw('GET', `/auth/admin/client-errors/events/${eventId}`)
}

export async function updateGroupStatus(
  groupId: number,
  status: string
): Promise<{ success: boolean; message: string }> {
  return getApiClient().raw('PUT', `/auth/admin/client-errors/groups/${groupId}/status`, {
    body: { status },
  })
}

export async function batchUpdateGroupStatus(
  groupIds: number[],
  status: string
): Promise<{ success: boolean; updated: number }> {
  return getApiClient().raw('PUT', '/auth/admin/client-errors/groups/batch-status', {
    body: { group_ids: groupIds, status },
  })
}

export async function fetchErrorStats(hours = 24): Promise<ErrorStats> {
  return getApiClient().raw('GET', '/auth/admin/client-errors/stats', {
    params: { hours },
  })
}

export async function fetchReleases(
  params: {
    page?: number
    page_size?: number
  } = {}
): Promise<{ items: ReleaseItem[]; pagination: Pagination }> {
  return getApiClient().raw('GET', '/auth/admin/client-errors/releases', { params })
}

export async function fetchReleaseDetail(appVersion: string): Promise<ReleaseDetail> {
  return getApiClient().raw('GET', `/auth/admin/client-errors/releases/${appVersion}`)
}
