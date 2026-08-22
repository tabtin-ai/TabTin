import type { ThreadStatusFilter } from '@/types/agent-debug'

const DEFAULT_PAGE_SIZE = 20
const ALLOWED_PAGE_SIZES = new Set([10, 20, 50, 100])
const ALLOWED_STATUSES = new Set<ThreadStatusFilter>(['all', 'error', 'running', 'completed'])

export interface ThreadListQueryState {
  keyword: string
  sessionTitle: string
  user: string
  organization: string
  status: ThreadStatusFilter
  page: number
  pageSize: number
}

function positiveInteger(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function parseThreadListQuery(searchParams: URLSearchParams): ThreadListQueryState {
  const rawStatus = searchParams.get('status') as ThreadStatusFilter | null
  const requestedPageSize = positiveInteger(searchParams.get('page_size'), DEFAULT_PAGE_SIZE)

  return {
    keyword: searchParams.get('keyword') ?? '',
    sessionTitle: searchParams.get('title') ?? '',
    user: searchParams.get('user') ?? '',
    organization: searchParams.get('organization') ?? '',
    status: rawStatus && ALLOWED_STATUSES.has(rawStatus) ? rawStatus : 'all',
    page: positiveInteger(searchParams.get('page'), 1),
    pageSize: ALLOWED_PAGE_SIZES.has(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE,
  }
}

export function serializeThreadListQuery(state: ThreadListQueryState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.keyword.trim()) params.set('keyword', state.keyword.trim())
  if (state.sessionTitle.trim()) params.set('title', state.sessionTitle.trim())
  if (state.user.trim()) params.set('user', state.user.trim())
  if (state.organization.trim()) params.set('organization', state.organization.trim())
  if (state.status !== 'all') params.set('status', state.status)
  if (state.page !== 1) params.set('page', String(state.page))
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set('page_size', String(state.pageSize))
  return params
}

export function threadDetailHref(threadId: string, searchParams: URLSearchParams): string {
  const query = searchParams.toString()
  return `/threads/${encodeURIComponent(threadId)}${query ? `?${query}` : ''}`
}
