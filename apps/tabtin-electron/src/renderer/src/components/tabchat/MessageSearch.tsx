/**
 * MessageSearch — IM 消息常驻搜索框
 *
 * 跟通讯录（ContactsList）一致的「常驻搜索框」交互：搜索框始终展示在列表顶部，
 * 而不是点放大镜按钮再切到全屏搜索。query 为空时展示 children（会话列表），
 * 输入后用 organization 级全文搜索（searchMessages）替换为聚合结果：私聊按对方用户、
 * 群聊按群组归并；组内展示命中消息，点击后回到对应会话和原消息。
 *
 * 保留 300ms debounce、关键词高亮和精确定位能力。
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import {
  getConversation,
  searchMessageGroups,
  searchMessages,
  searchResultStableKey,
  type MessageSearchGroup,
  type SearchResult,
} from '@/services/tabchatApi'
import { useIMStore } from '@stores/useIMStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { formatConversationTime } from '@/lib/dateUtils'
import { sortConversations } from '@/lib/imFormat'
import { useUserProfileCache, useDisplayNames } from '@stores/useUserProfileCache'
import { CONVERSATION_TYPE_GROUP, SEARCH_DEBOUNCE_MS } from '@/constants/tabchat'
import { getConversationNavigationKind } from '@tabtin/app-shell'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { useScopedEventListener } from '@hooks/spaceActivity'
import { cn } from '@utils/cn'
import { SIDEBAR_EMBEDDED_CONTROL_INSET } from '@components/layout/sidebarUi'
import { ColorAvatar } from './ColorAvatar'
import { IM_CHAT_BODY_TEXT, IM_SEARCH_INPUT_TEXT } from './tabchatUi'

const GROUP_PAGE_SIZE = 8
const INITIAL_MESSAGES_PER_GROUP = 3
const MESSAGE_PAGE_SIZE = 10

interface MessageSearchProps {
  organizationId: string
  /** 紧凑模式（侧栏内嵌），跟 ContactsList 的 embedded 尺寸对齐 */
  embedded?: boolean
  /** 搜索框右侧的操作（如「新建对话」按钮），常驻展示 */
  trailing?: React.ReactNode
  /** query 为空时展示的内容（会话列表） */
  children: React.ReactNode
}

export const MessageSearch: React.FC<MessageSearchProps> = ({
  organizationId,
  embedded = false,
  trailing,
  children,
}) => {
  const { t } = useTranslation('tabchat')
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<MessageSearchGroup[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [pendingResultKey, setPendingResultKey] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set())
  const [loadingGroupIds, setLoadingGroupIds] = useState<Set<string>>(() => new Set())
  const [isLoadingMoreGroups, setIsLoadingMoreGroups] = useState(false)
  const [hasMoreGroups, setHasMoreGroups] = useState(false)
  const [nextGroupOffset, setNextGroupOffset] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latestSearchRequestIdRef = useRef(0)
  const navigateToMessage = useIMStore((s) => s.navigateToMessage)
  const conversations = useIMStore((s) => s.conversations)
  const selectSpaceById = useSpaceListStore((s) => s.selectSpaceById)
  const ensureProfiles = useUserProfileCache((s) => s.ensureProfiles)
  const profiles = useUserProfileCache((s) => s.profiles)
  const dmPeerUserIds = useMemo(
    () => groups
      .filter((group) => group.conversation_type !== CONVERSATION_TYPE_GROUP)
      .map((group) => conversations.find((conversation) => conversation.id === group.conversation_id)?.dm_peer_user_id)
      .filter((userId): userId is string => Boolean(userId)),
    [conversations, groups],
  )
  const resultSenderIds = useMemo(
    () => [...new Set(groups.flatMap((group) => group.messages.map((result) => result.sender_id)))],
    [groups],
  )
  const profileUserIds = useMemo(
    () => [...new Set([...resultSenderIds, ...dmPeerUserIds])],
    [dmPeerUserIds, resultSenderIds],
  )
  const displayNames = useDisplayNames(profileUserIds)
  const isSearching = query.trim().length > 0

  const documentTarget = typeof document === 'undefined' ? null : document
  useScopedEventListener<KeyboardEvent>(documentTarget, 'keydown', (event) => {
    if (
      event.key.toLowerCase() !== 'f'
      || (!event.metaKey && !event.ctrlKey)
      || event.shiftKey
      || event.altKey
    ) return
    event.preventDefault()
    event.stopPropagation()
    searchInputRef.current?.focus()
  })

  useEffect(() => {
    if (profileUserIds.length > 0) ensureProfiles(profileUserIds)
  }, [profileUserIds, ensureProfiles])

  const clearSearchState = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    latestSearchRequestIdRef.current++
    setQuery('')
    setGroups([])
    setHasSearched(false)
    setSearchError(false)
    setIsLoading(false)
    setHasMoreGroups(false)
    setNextGroupOffset(0)
    setCollapsedGroupIds(new Set())
    setLoadingGroupIds(new Set())
    setIsLoadingMoreGroups(false)
    setPendingResultKey(null)
  }, [])

  // 搜索结果只属于发起查询时的 organization。切换后清空关键词和结果，既不让
  // 旧组织命中停留在新界面，也令尚未返回的旧请求无法回填。
  useEffect(() => {
    clearSearchState()
  }, [clearSearchState, organizationId])

  const doSearch = useCallback(
    async (q: string) => {
      const requestId = ++latestSearchRequestIdRef.current
      if (!q.trim() || !organizationId) {
        setGroups([])
        setHasSearched(false)
        setSearchError(false)
        setIsLoading(false)
        setHasMoreGroups(false)
        setNextGroupOffset(0)
        return
      }
      setIsLoading(true)
      setHasSearched(true)
      setSearchError(false)
      try {
        const data = await searchMessageGroups(
          organizationId,
          q.trim(),
          0,
          GROUP_PAGE_SIZE,
          INITIAL_MESSAGES_PER_GROUP,
        )
        if (latestSearchRequestIdRef.current !== requestId) return
        setGroups(data.groups)
        setHasMoreGroups(data.has_more)
        setNextGroupOffset(data.next_group_offset)
        setCollapsedGroupIds(new Set(
          data.groups
            .filter((group) => group.messages.length === 0 && group.messages_has_more)
            .map((group) => group.conversation_id),
        ))
      } catch (err) {
        if (latestSearchRequestIdRef.current !== requestId) return
        console.error('[TabChat] Search failed:', err)
        setGroups([])
        setHasMoreGroups(false)
        setNextGroupOffset(0)
        setSearchError(true)
      } finally {
        if (latestSearchRequestIdRef.current !== requestId) return
        setIsLoading(false)
      }
    },
    [organizationId],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setQuery(value)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => doSearch(value), SEARCH_DEBOUNCE_MS)
    },
    [doSearch],
  )

  const handleClear = useCallback(() => {
    clearSearchState()
  }, [clearSearchState])

  const handleLoadMoreGroups = useCallback(async () => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery || !organizationId || !hasMoreGroups || isLoadingMoreGroups) return
    const requestId = latestSearchRequestIdRef.current
    setIsLoadingMoreGroups(true)
    try {
      const data = await searchMessageGroups(
        organizationId,
        trimmedQuery,
        nextGroupOffset,
        GROUP_PAGE_SIZE,
        INITIAL_MESSAGES_PER_GROUP,
      )
      if (latestSearchRequestIdRef.current !== requestId) return
      setGroups((current) => {
        const known = new Set(current.map((group) => group.conversation_id))
        return [...current, ...data.groups.filter((group) => !known.has(group.conversation_id))]
      })
      setCollapsedGroupIds((current) => {
        const next = new Set(current)
        data.groups.forEach((group) => {
          if (group.messages.length === 0 && group.messages_has_more) {
            next.add(group.conversation_id)
          }
        })
        return next
      })
      setHasMoreGroups(data.has_more)
      setNextGroupOffset(data.next_group_offset)
    } catch (err) {
      console.error('[TabChat] Loading more search groups failed:', err)
      toast({ title: t('searchError'), variant: 'destructive' })
    } finally {
      if (latestSearchRequestIdRef.current === requestId) setIsLoadingMoreGroups(false)
    }
  }, [hasMoreGroups, isLoadingMoreGroups, nextGroupOffset, organizationId, query, t])

  const handleLoadMoreInGroup = useCallback(async (group: MessageSearchGroup) => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery || !organizationId || !group.messages_has_more || loadingGroupIds.has(group.conversation_id)) return
    const requestId = latestSearchRequestIdRef.current
    setLoadingGroupIds((current) => new Set(current).add(group.conversation_id))
    try {
      const messages = await searchMessages(
        organizationId,
        trimmedQuery,
        group.conversation_id,
        MESSAGE_PAGE_SIZE,
        group.next_message_offset,
      )
      if (latestSearchRequestIdRef.current !== requestId) return
      setGroups((current) => current.map((item) => {
        if (item.conversation_id !== group.conversation_id) return item
        const known = new Set(item.messages.map(searchResultStableKey))
        const appended = messages.filter((message) => !known.has(searchResultStableKey(message)))
        const nextMessages = [...item.messages, ...appended]
        return {
          ...item,
          messages: nextMessages,
          next_message_offset: item.next_message_offset + messages.length,
          messages_has_more: nextMessages.length < item.match_count && messages.length > 0,
        }
      }))
    } catch (err) {
      console.error('[TabChat] Loading more messages in search group failed:', err)
      toast({ title: t('searchError'), variant: 'destructive' })
    } finally {
      setLoadingGroupIds((current) => {
        const next = new Set(current)
        next.delete(group.conversation_id)
        return next
      })
    }
  }, [loadingGroupIds, organizationId, query, t])

  const handleToggleGroup = useCallback((group: MessageSearchGroup) => {
    const isCollapsed = collapsedGroupIds.has(group.conversation_id)
    setCollapsedGroupIds((current) => {
      const next = new Set(current)
      if (next.has(group.conversation_id)) next.delete(group.conversation_id)
      else next.add(group.conversation_id)
      return next
    })
    if (
      isCollapsed
      && group.messages.length === 0
      && group.messages_has_more
    ) {
      void handleLoadMoreInGroup(group)
    }
  }, [collapsedGroupIds, handleLoadMoreInGroup])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleResultClick = useCallback(
    (result: SearchResult) => {
      if (pendingResultKey != null) return
      const resultKey = searchResultStableKey(result)
      setPendingResultKey(resultKey)
      void (async () => {
        let conversation = conversations.find((item) => item.id === result.conversation_id) ?? null
        if (!conversation) {
          try {
            conversation = await getConversation(result.conversation_id)
          } catch (err) {
            console.warn('[TabChat] Search result conversation load failed:', err)
          }
        }
        if (!conversation) {
          toast({
            title: t('searchNavigateFailed', { defaultValue: '无法打开该会话，请稍后重试' }),
            variant: 'destructive',
          })
          return
        }
        const currentOrganizationId = useOrganizationStore.getState().selectedOrganization?.id
        if (conversation.organization_id !== currentOrganizationId) {
          // 组织切换与点击交错时，旧搜索结果可能仍在浏览器事件队列中；
          // 即使本地缓存命中，也不能用它重开旧组织会话。
          toast({
            title: t('searchNavigateFailed', { defaultValue: '无法打开该会话，请稍后重试' }),
            variant: 'destructive',
          })
          return
        }
        if (!conversations.some((item) => item.id === conversation.id)) {
          useIMStore.setState((state) => ({
            conversations: sortConversations([
              conversation,
              ...state.conversations.filter((item) => item.id !== conversation.id),
            ]),
          }))
        }
        selectSpaceById(getConversationNavigationKind(conversation), conversation.id)
        navigateToMessage(result.conversation_id, {
          id: result.id,
          transport: result.transport,
          metadata: result.metadata ?? {},
        })
      })().finally(() => {
        setPendingResultKey((current) => (current === resultKey ? null : current))
      })
    },
    [conversations, navigateToMessage, pendingResultKey, selectSpaceById, t],
  )

  const formatTime = (dateStr: string | null) => formatConversationTime(dateStr, t)

  const highlightText = (text: string, q: string) => {
    if (!q.trim()) return text
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escaped})`, 'gi')
    const parts = text.split(regex)
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <mark key={i} className="bg-warning/40 text-foreground rounded-sm px-0.5">
          {part}
        </mark>
      ) : (
        part
      ),
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 常驻搜索框（与 ContactsList 同款样式） + 右侧操作 */}
      <div className={cn('flex flex-shrink-0 items-center gap-1', embedded ? cn(SIDEBAR_EMBEDDED_CONTROL_INSET, 'pt-0 pb-2') : 'px-3 pt-3 pb-2')}>
        <div className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-foreground/[0.025] transition-colors duration-200 focus-within:bg-foreground/[0.04] dark:bg-black/10 dark:focus-within:bg-foreground/[0.06]',
          embedded
            ? 'h-8 px-2.5'
            : 'h-9 px-3',
        )}>
          <Search className={cn('h-3.5 w-3.5', 'flex-shrink-0 text-muted-foreground/60')} />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={handleInputChange}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className={cn(
              'min-w-0 flex-1 border-0 bg-transparent placeholder:text-muted-foreground/60 focus:outline-none',
              '[&::-webkit-search-cancel-button]:hidden',
              IM_SEARCH_INPUT_TEXT,
            )}
          />
          {isLoading && (
            <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground/60" />
          )}
          {isSearching && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              className="flex-shrink-0 text-muted-foreground/60 transition-colors hover:text-foreground"
              title={t('cancel')}
              aria-label={t('cancel')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {trailing}
      </div>

      {/* query 为空展示会话列表，否则展示搜索结果 */}
      {!isSearching ? (
        <div className="flex-1 min-h-0">{children}</div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hover">
          {isLoading ? (
            <div className="py-1">
              <DetailedRowListSkeleton count={6} compact leadingShape="icon" />
            </div>
          ) : !hasSearched ? null : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <p className={cn('text-muted-foreground', IM_CHAT_BODY_TEXT)}>
                {searchError ? t('searchError') : t('searchNoResults')}
              </p>
            </div>
          ) : (
            <div className="py-1">
              {groups.map((group) => {
                const cachedConversation = conversations.find((item) => item.id === group.conversation_id)
                const isGroup = group.conversation_type === CONVERSATION_TYPE_GROUP
                const isCollapsed = collapsedGroupIds.has(group.conversation_id)
                const isLoadingGroup = loadingGroupIds.has(group.conversation_id)
                const remainingCount = Math.max(0, group.match_count - group.messages.length)
                const dmPeerUserId = isGroup ? null : cachedConversation?.dm_peer_user_id
                const groupName = isGroup
                  ? group.conversation_name || cachedConversation?.name || t('group')
                  : (dmPeerUserId ? displayNames[dmPeerUserId] : '') || t('dm')
                const avatarUrl = isGroup
                  ? group.conversation_avatar_url || cachedConversation?.avatar_url || ''
                  : (dmPeerUserId ? profiles[dmPeerUserId]?.avatar : '') || ''
                // 私聊复用会话列表的对方 userId；搜索接口未提供时才退回会话 ID。
                const avatarSeed = isGroup
                  ? group.conversation_id
                  : dmPeerUserId || group.conversation_id

                return (
                  <section
                    key={group.conversation_id}
                    className="mx-2 mb-2 overflow-hidden rounded-xl bg-foreground/[0.025] ring-1 ring-inset ring-foreground/[0.04]"
                  >
                    <button
                      type="button"
                      onClick={() => handleToggleGroup(group)}
                      aria-expanded={!isCollapsed}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-foreground/[0.03] transition-colors"
                    >
                      {isCollapsed
                        ? <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
                        : <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />}
                      <ColorAvatar
                        name={groupName}
                        seed={avatarSeed}
                        imageUrl={avatarUrl || undefined}
                        group={isGroup}
                        className="h-8 w-8"
                        fallbackClassName="text-caption"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={cn('truncate font-medium text-foreground', IM_CHAT_BODY_TEXT)}>{groupName}</span>
                          <span className="flex-shrink-0 text-caption text-muted-foreground/60">
                            {t(isGroup ? 'searchGroupKind' : 'searchUserKind', {
                              defaultValue: isGroup ? '群组' : '用户',
                            })}
                          </span>
                        </div>
                        <div className="text-caption text-muted-foreground/60">
                          {t('searchMatchCount', {
                            count: group.match_count,
                            defaultValue: `${group.match_count} 条匹配`,
                          })}
                        </div>
                      </div>
                      <span className="flex-shrink-0 text-caption text-muted-foreground/60">
                        {formatTime(group.latest_match_at)}
                      </span>
                    </button>

                    {!isCollapsed && (
                      <div className="border-t border-border/60 px-1.5 py-1">
                        {group.messages.map((result) => (
                          <button
                            key={searchResultStableKey(result)}
                            type="button"
                            onClick={() => handleResultClick(result)}
                            disabled={pendingResultKey != null}
                            className="group flex w-full items-start gap-2 rounded-interactive px-2 py-2 text-left hover:bg-foreground/[0.03] disabled:cursor-wait disabled:opacity-60 dark:hover:bg-foreground/[0.05] transition-colors"
                          >
                            <div className="min-w-0 flex-1">
                              {pendingResultKey === searchResultStableKey(result) && (
                                <div className="mb-1 flex items-center gap-1.5 text-caption text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  <span>{t('searchNavigating', { defaultValue: '正在打开会话...' })}</span>
                                </div>
                              )}
                              <div className={cn('line-clamp-2 text-foreground/80 [overflow-wrap:anywhere]', IM_CHAT_BODY_TEXT)}>
                                <span className="mr-1 font-medium text-foreground">
                                  {displayNames[result.sender_id] || result.sender_id.slice(0, 8)}:
                                </span>
                                {highlightText(result.highlight || result.content, query)}
                              </div>
                            </div>
                            <span className="mt-0.5 flex-shrink-0 text-caption text-muted-foreground/60">
                              {formatTime(result.created_at)}
                            </span>
                          </button>
                        ))}

                        {group.messages_has_more && remainingCount > 0 && (
                          <button
                            type="button"
                            onClick={() => void handleLoadMoreInGroup(group)}
                            disabled={isLoadingGroup}
                            className="flex w-full items-center px-2 py-1.5 text-caption text-muted-foreground hover:text-foreground disabled:cursor-wait disabled:opacity-60 transition-colors"
                          >
                            {isLoadingGroup ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <ChevronDown className="mr-1 h-3 w-3" />
                            )}
                            {t('searchShowMoreInGroup', {
                              count: remainingCount,
                              defaultValue: `查看更多结果（剩余 ${remainingCount} 条）`,
                            })}
                          </button>
                        )}
                      </div>
                    )}
                  </section>
                )
              })}

              {hasMoreGroups && (
                <button
                  type="button"
                  onClick={() => void handleLoadMoreGroups()}
                  disabled={isLoadingMoreGroups}
                  className={cn('mx-2 flex w-[calc(100%_-_16px)] items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground disabled:cursor-wait disabled:opacity-60 transition-colors', IM_CHAT_BODY_TEXT)}
                >
                  {isLoadingMoreGroups ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {t('searchShowMoreGroups', { defaultValue: '查看更多用户和群组' })}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
