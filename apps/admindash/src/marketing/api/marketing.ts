/**
 * 官网获客分析 - API 调用层
 *
 * 对应后端 apps/analytics/admin_api.py（/auth/admin/analytics/*）。
 */

import { getApiClient } from '@/api/tabtin-client'

export interface Pagination {
  total: number
  page: number
  page_size: number
  total_pages: number
}

export type TargetType = 'static' | 'latest_release'

export interface ShortLink {
  id: string
  slug: string
  name: string
  description: string
  target_type: TargetType
  target_url: string
  release_platform: string
  release_arch: string
  release_channel: string
  channel: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  is_active: boolean
  click_count: number
  last_clicked_at: string | null
  resolved_url: string
  created_at: string | null
  updated_at: string | null
}

export interface ShortLinkInput {
  slug: string
  name: string
  description?: string
  target_type: TargetType
  target_url?: string
  release_platform?: string
  release_arch?: string
  release_channel?: string
  channel?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  is_active?: boolean
}

export interface AnalyticsOverview {
  days: number
  page_views: number
  unique_visitors: number
  new_visitors: number
  returning_visitors: number
  downloads: number
  platform_breakdown: Array<{ platform: string; arch: string; count: number }>
  top_channels: Array<{ utm_source: string; count: number }>
  top_pages: Array<{ path: string; count: number }>
  geo_breakdown: Array<{ geo_country: string; geo_province: string; count: number }>
  referrer_breakdown: Array<{ referrer_host: string; count: number }>
}

export interface TrendPoint {
  day: string | null
  count: number
}

export interface AnalyticsTrends {
  event_name: string
  days: number
  series: TrendPoint[]
}

export interface AnalyticsEventItem {
  id: string
  source: string
  event_name: string
  occurred_at: string | null
  path: string
  referrer_host: string
  utm_source: string
  platform: string
  arch: string
  geo_country: string
  geo_province: string
  props: Record<string, unknown>
}

const BASE = '/auth/admin/analytics'

export async function fetchOverview(days = 7): Promise<AnalyticsOverview> {
  return getApiClient().raw('GET', `${BASE}/overview`, { params: { days } })
}

export async function fetchTrends(days = 30, eventName = 'page_view'): Promise<AnalyticsTrends> {
  return getApiClient().raw('GET', `${BASE}/trends`, { params: { days, event_name: eventName } })
}

export async function fetchEvents(params: {
  source?: string
  event_name?: string
  days?: number
  page?: number
  page_size?: number
}): Promise<{ items: AnalyticsEventItem[]; pagination: Pagination }> {
  return getApiClient().raw('GET', `${BASE}/events`, { params })
}

export async function fetchShortLinks(
  params: {
    is_active?: boolean
    page?: number
    page_size?: number
  } = {}
): Promise<{ items: ShortLink[]; pagination: Pagination }> {
  return getApiClient().raw('GET', `${BASE}/short-links`, { params })
}

export async function createShortLink(payload: ShortLinkInput): Promise<ShortLink> {
  return getApiClient().raw('POST', `${BASE}/short-links`, { body: payload })
}

export async function updateShortLink(id: string, payload: ShortLinkInput): Promise<ShortLink> {
  return getApiClient().raw('PUT', `${BASE}/short-links/${id}`, { body: payload })
}

export async function deleteShortLink(id: string): Promise<{ success: boolean }> {
  return getApiClient().raw('DELETE', `${BASE}/short-links/${id}`)
}
