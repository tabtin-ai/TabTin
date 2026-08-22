import { getApiClient } from '@/api/tabtin-client'

export interface PendingReviewItem {
  id: string
  skill_id: string
  skill_name: string
  skill_slug: string
  skill_description: string
  skill_emoji: string
  owner_user_id: string
  owner_name: string
  version_seq: number
  version_label: string
  change_note: string
  bundle_sha256: string
  bundle_oss_key: string
  review_status: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string
  published_by: string | null
  published_at: string | null
  skill_md_content?: string | null
}

interface PaginatedResponse {
  items: PendingReviewItem[]
  total: number
  pagination: { page: number; page_size: number; total_pages: number }
}

export async function listPendingReview(
  page = 1,
  pageSize = 20
): Promise<PaginatedResponse> {
  return getApiClient().raw<PaginatedResponse>(
    'GET',
    `/auth/admin/skills/pending-review?page=${page}&page_size=${pageSize}`
  )
}

export async function getVersionDetail(
  skillId: string,
  seq: number
): Promise<PendingReviewItem> {
  return getApiClient().raw<PendingReviewItem>(
    'GET',
    `/auth/admin/skills/${skillId}/versions/${seq}`
  )
}

export async function approveVersion(
  skillId: string,
  seq: number,
  reviewNote = ''
): Promise<void> {
  await getApiClient().raw('POST', `/auth/admin/skills/${skillId}/versions/${seq}/approve`, {
    body: { review_note: reviewNote },
  })
}

export async function rejectVersion(
  skillId: string,
  seq: number,
  reviewNote = ''
): Promise<void> {
  await getApiClient().raw('POST', `/auth/admin/skills/${skillId}/versions/${seq}/reject`, {
    body: { review_note: reviewNote },
  })
}
