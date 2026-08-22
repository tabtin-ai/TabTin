import { getApiClient } from '@/api/tabtin-client'
import type { ContentOverviewResponse } from '@/content-ops/types'

export async function getContentOverview(): Promise<ContentOverviewResponse> {
  return getApiClient().raw<ContentOverviewResponse>('GET', '/auth/admin/content/overview')
}
