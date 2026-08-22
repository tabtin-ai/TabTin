/**
 * useMemberSearch — Organization 成员搜索（防抖 + 分页加载）
 *
 * 后端契约：
 *  - GET /context/organizations/{organization_id}/members
 *      ?search=...&search_mode=nickname&limit=100&offset=0
 *    → { members: [{ user_id, role, user: { id, nickname, username, avatar } }], total }
 *
 * 为什么用 members 而非 search-users：
 * 协作者只能在「同组织成员」里挑（邀请接口 invite_collaborators 会拒绝非成员），
 * 而 search-users 是给「往组织加新成员」用的——它搜全平台用户并排除已有成员，
 * 与协作者场景语义相反，会导致「搜到组织外的人邀不了、组织内成员搜不到」。
 *
 * 设计：
 * - enabled=true 时即可拉取（空关键词 = 浏览成员列表）
 * - 输入关键词 300ms 防抖；首次打开（enabled 从 false→true）立即请求
 * - 分页：limit=100，滚动触底 loadMore（offset 递增）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import type { SearchedUser } from '../types'
import { buildMemberSearchRequest, MEMBER_SEARCH_PAGE_SIZE } from './memberSearchRequest'

const DEBOUNCE_MS = 300

interface MemberItem {
  user_id: string
  role?: string
  user?: {
    id?: string
    nickname?: string
    username?: string
    avatar?: string
  }
}

interface ListMembersResponse {
  members: MemberItem[]
  total: number
}

function mapMembers(members: MemberItem[] | undefined): SearchedUser[] {
  if (!Array.isArray(members)) return []
  return members.map((m) => {
    const u = m.user || {}
    return {
      id: String(u.id || m.user_id),
      nickname: u.nickname || '',
      username: u.username || '',
      avatar: u.avatar || '',
    }
  })
}

export interface UseMemberSearchResult {
  results: SearchedUser[]
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
}

export function useMemberSearch(
  organizationId: string | undefined | null,
  query: string,
  enabled = true,
): UseMemberSearchResult {
  const client = useAppHostClient()
  const [results, setResults] = useState<SearchedUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = query.trim()
  const offsetRef = useRef(0)
  const requestGenRef = useRef(0)
  const prevEnabledRef = useRef(false)
  const inFlightMoreRef = useRef(false)

  const reset = useCallback(() => {
    requestGenRef.current += 1
    offsetRef.current = 0
    inFlightMoreRef.current = false
    setResults([])
    setTotal(0)
    setError(null)
    setLoading(false)
    setLoadingMore(false)
  }, [])

  const fetchPage = useCallback(
    async (wId: string, q: string, offset: number, append: boolean) => {
      const gen = append ? requestGenRef.current : ++requestGenRef.current
      if (append) {
        inFlightMoreRef.current = true
        setLoadingMore(true)
      } else {
        setLoading(true)
        setLoadingMore(false)
        inFlightMoreRef.current = false
      }
      setError(null)
      try {
        const data = await client.request<ListMembersResponse>(
          buildMemberSearchRequest(wId, q, offset, MEMBER_SEARCH_PAGE_SIZE),
        )
        if (gen !== requestGenRef.current) return

        const users = mapMembers(data?.members)
        const nextTotal = typeof data?.total === 'number' ? data.total : users.length
        setTotal(nextTotal)
        setResults((prev) => (append ? [...prev, ...users] : users))
        offsetRef.current = offset + users.length
      } catch (err) {
        if (gen !== requestGenRef.current) return
        if (!append) {
          setResults([])
          setTotal(0)
        }
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (gen === requestGenRef.current) {
          setLoading(false)
          setLoadingMore(false)
          inFlightMoreRef.current = false
        }
      }
    },
    [client],
  )

  useEffect(() => {
    if (!enabled || !organizationId) {
      prevEnabledRef.current = false
      reset()
      return
    }

    const justEnabled = !prevEnabledRef.current
    prevEnabledRef.current = true
    const delay = justEnabled ? 0 : DEBOUNCE_MS

    const timer = setTimeout(() => {
      offsetRef.current = 0
      void fetchPage(organizationId, trimmed, 0, false)
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [organizationId, trimmed, enabled, fetchPage, reset])

  const hasMore = results.length < total

  const loadMore = useCallback(() => {
    if (!organizationId || !enabled || loading || inFlightMoreRef.current || !hasMore) return
    void fetchPage(organizationId, trimmed, offsetRef.current, true)
  }, [organizationId, enabled, loading, hasMore, fetchPage, trimmed])

  return useMemo(
    () => ({ results, loading, loadingMore, error, hasMore, loadMore }),
    [results, loading, loadingMore, error, hasMore, loadMore],
  )
}
