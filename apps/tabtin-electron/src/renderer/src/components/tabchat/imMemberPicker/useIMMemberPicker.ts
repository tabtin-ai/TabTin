import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as tabchatApi from '@/services/tabchatApi'
import type { IMMemberItem } from './types'

interface UseIMMemberPickerOptions {
  organizationId?: string
  members: IMMemberItem[]
  currentUserId?: string
  enabled?: boolean
}

export function useIMMemberPicker({
  organizationId,
  members,
  currentUserId,
  enabled = true,
}: UseIMMemberPickerOptions) {
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<IMMemberItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const otherMembers = useMemo(
    () => members.filter((member) => member.user_id !== currentUserId),
    [members, currentUserId],
  )

  useEffect(() => {
    if (!enabled) return
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const query = search.trim()
    if (!query || !organizationId) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
    let cancelled = false
    setIsSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await tabchatApi.searchOrganizationMembers(organizationId, query)
        if (cancelled) return
        setSearchResults(results.map((result) => ({
          user_id: result.id,
          user: {
            nickname: result.nickname,
            username: result.username,
            email: result.email,
            avatar: result.avatar,
          },
        })))
      } catch {
        if (!cancelled) setSearchResults([])
      } finally {
        if (!cancelled) setIsSearching(false)
      }
    }, 300)
    return () => {
      cancelled = true
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [enabled, organizationId, search])

  const filteredMembers = useMemo((): IMMemberItem[] => {
    const query = search.trim().toLowerCase()
    if (!query) return otherMembers

    const localFiltered = otherMembers.filter((member) => {
      const name = member.user?.nickname || member.user?.username || member.user_id
      return name.toLowerCase().includes(query)
        || (member.user?.email?.toLowerCase().includes(query) ?? false)
    })

    if (searchResults.length === 0) return localFiltered

    const existing = new Set(localFiltered.map((member) => member.user_id))
    const merged = [...localFiltered]
    for (const result of searchResults) {
      if (!existing.has(result.user_id)) {
        merged.push(result)
        existing.add(result.user_id)
      }
    }
    return merged
  }, [otherMembers, search, searchResults])

  const resetSearch = useCallback(() => {
    setSearch('')
    setSearchResults([])
    setIsSearching(false)
  }, [])

  return {
    search,
    setSearch,
    resetSearch,
    otherMembers,
    filteredMembers,
    isSearching,
  }
}
