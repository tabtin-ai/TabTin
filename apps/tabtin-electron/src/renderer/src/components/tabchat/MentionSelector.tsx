/**
 * MentionSelector — 输入 @ 后弹出的会话成员选择器
 *
 * 浮在输入框上方，支持键盘导航（ArrowUp/Down/Enter/Escape）+ 鼠标点选。
 * 群聊顶部固定「所有人」；其下为「会话内成员」分组列表。
 */

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConversationMember } from '@/services/tabchatApi'
import { useIMStore } from '@stores/useIMStore'
import { useDisplayNames, useUserProfileCache } from '@stores/useUserProfileCache'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { AgentMemberBadges } from './AgentMemberBadges'
import { ColorAvatar } from './ColorAvatar'
import { agentOwnerDisplayName, isAgentExecutionOffline } from './conversationMembers'
import { MENTION_ALL_ALIASES } from './resolveMentionsFromText'
import { createLogger } from '@/utils/logger'

const log = createLogger('MentionSelector')
const EMPTY_CONVERSATION_MEMBERS: ConversationMember[] = []

export interface MentionSelectorRef {
  handleKeyDown: (e: React.KeyboardEvent) => boolean
}

/** TC-8：@ 目标可以是人、AI Agent，或群聊「所有人」 */
export interface MentionTarget {
  user_id: string | null
  agent_id: string | null
  member_type: 'user' | 'agent' | 'all'
  display_name: string
}

interface Props {
  conversationId: string
  query: string
  onSelect: (target: MentionTarget) => void
  onClose: () => void
  position?: { bottom: number; left: number }
  /** 群聊开启：列表顶部提供「所有人」 */
  allowMentionAll?: boolean
}

type MentionOption =
  | { kind: 'all'; display_name: string }
  | { kind: 'member'; member: ConversationMember }

function memberIdentity(m: ConversationMember): string {
  return m.agent_id || m.user_id || ''
}

function memberDisplayName(
  m: ConversationMember,
  profileDisplayNames: Record<string, string> = {},
): string {
  const identity = memberIdentity(m)
  const idFallback = identity.slice(0, 8)
  const profileDisplayName = m.user_id ? profileDisplayNames[m.user_id] : ''
  // useDisplayNames 在资料未加载时会返回短 ID；此时保留详情接口已带回的名称。
  const resolvedProfileName = profileDisplayName && profileDisplayName !== idFallback
    ? profileDisplayName
    : ''
  return resolvedProfileName || m.nickname || m.username || idFallback
}

function matchesMentionAllQuery(query: string, label: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (label.toLowerCase().includes(q)) return true
  return MENTION_ALL_ALIASES.some((alias) => alias.toLowerCase().includes(q))
}

function isMentionOptionDisabled(option: MentionOption): boolean {
  return option.kind === 'member' && isAgentExecutionOffline(option.member)
}

function firstEnabledMentionIndex(options: MentionOption[]): number {
  const index = options.findIndex((option) => !isMentionOptionDisabled(option))
  return index >= 0 ? index : 0
}

function nextEnabledMentionIndex(
  options: MentionOption[],
  fromIndex: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return 0
  let index = fromIndex
  for (let step = 0; step < options.length; step += 1) {
    index = (index + direction + options.length) % options.length
    if (!isMentionOptionDisabled(options[index])) return index
  }
  return fromIndex
}

export const MentionSelector = forwardRef<MentionSelectorRef, Props>(
  (
    {
      conversationId,
      query,
      onSelect,
      onClose,
      position,
      allowMentionAll = false,
    },
    ref,
  ) => {
    const { t } = useTranslation('tabchat')
    const [activeIndex, setActiveIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)
    const mentionAllLabel = t('mentionAll')
    const memberSnapshot = useIMStore((state) => state.conversationMembers[conversationId])
    const membersLoading = useIMStore(
      (state) => state.conversationMembersLoading[conversationId] ?? false,
    )
    const refreshConversationMembers = useIMStore((state) => state.refreshConversationMembers)
    const members = membersLoading
      ? EMPTY_CONVERSATION_MEMBERS
      : memberSnapshot ?? EMPTY_CONVERSATION_MEMBERS

    // 每次打开都在浏览器绘制前失效并重验共享快照，校准期间不暴露旧候选。
    useLayoutEffect(() => {
      void refreshConversationMembers(conversationId, {
        supersede: true,
        invalidateSnapshot: true,
      })
        .catch((err) => {
          log.warn('failed to refresh conversation members', { conversationId, err })
        })
    }, [conversationId, refreshConversationMembers])

    const ensureProfiles = useUserProfileCache((state) => state.ensureProfiles)
    const humanUserIds = useMemo(() => Array.from(new Set(
      members
        .filter((member) => member.member_type !== 'agent' && member.user_id)
        .map((member) => member.user_id as string),
    )), [members])
    const profileDisplayNames = useDisplayNames(humanUserIds)

    useEffect(() => {
      if (humanUserIds.length > 0) ensureProfiles(humanUserIds)
    }, [ensureProfiles, humanUserIds])

    const { showMentionAll, filteredMembers, options } = useMemo(() => {
      const showAll = allowMentionAll && matchesMentionAllQuery(query, mentionAllLabel)
      const filtered = members
        .filter((m) => {
          if (!query) return true
          const q = query.toLowerCase()
          return (
            memberDisplayName(m, profileDisplayNames).toLowerCase().includes(q) ||
            (m.nickname || '').toLowerCase().includes(q) ||
            (m.username || '').toLowerCase().includes(q)
          )
        })

      const next: MentionOption[] = []
      if (showAll) {
        next.push({ kind: 'all', display_name: mentionAllLabel })
      }
      for (const member of filtered) {
        next.push({ kind: 'member', member })
      }
      return { showMentionAll: showAll, filteredMembers: filtered, options: next }
    }, [allowMentionAll, mentionAllLabel, members, profileDisplayNames, query])

    useEffect(() => {
      setActiveIndex(firstEnabledMentionIndex(options))
    }, [query, options])

    // 让活跃项滚动到可视区域（跳过分组标题等非选项节点）
    useEffect(() => {
      const list = listRef.current
      if (!list) return
      const active = list.querySelector<HTMLElement>(`[data-mention-index="${activeIndex}"]`)
      if (typeof active?.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' })
      }
    }, [activeIndex])

    const selectOption = useCallback(
      (option: MentionOption) => {
        if (isMentionOptionDisabled(option)) return
        if (option.kind === 'all') {
          onSelect({
            user_id: null,
            agent_id: null,
            member_type: 'all',
            display_name: option.display_name,
          })
          return
        }
        const member = option.member
        const isAgent = member.member_type === 'agent' || (!member.user_id && !!member.agent_id)
        onSelect({
          user_id: isAgent ? null : member.user_id,
          agent_id: isAgent ? (member.agent_id ?? null) : null,
          member_type: isAgent ? 'agent' : 'user',
          display_name: memberDisplayName(member, profileDisplayNames),
        })
      },
      [onSelect, profileDisplayNames],
    )

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent): boolean => {
        if (options.length === 0) {
          if (e.key === 'Escape') { onClose(); return true }
          return false
        }
        switch (e.key) {
          case 'ArrowUp':
            e.preventDefault()
            setActiveIndex((prev) => nextEnabledMentionIndex(options, prev, -1))
            return true
          case 'ArrowDown':
            e.preventDefault()
            setActiveIndex((prev) => nextEnabledMentionIndex(options, prev, 1))
            return true
          case 'Enter':
            e.preventDefault()
            if (options[activeIndex]) selectOption(options[activeIndex])
            return true
          case 'Escape':
            e.preventDefault()
            onClose()
            return true
          default:
            return false
        }
      },
      [options, activeIndex, selectOption, onClose],
    )

    useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown])

    if (members.length === 0 && !allowMentionAll) return null

    const rowClass = (idx: number) =>
      `w-full flex items-center gap-2.5 px-3 py-2 text-body text-left transition-colors ${
        idx === activeIndex
          ? 'bg-accent/10 text-foreground'
          : 'text-foreground hover:bg-muted/30'
      }`
    const memberStartIndex = showMentionAll ? 1 : 0

    return (
      <div
        className={`absolute z-dropdown w-[280px] max-h-72 overflow-y-auto rounded-xl ${OVERLAY_SURFACE_CLASS}`}
        style={position ? { bottom: position.bottom, left: position.left } : { bottom: '100%', left: 0 }}
      >
        <div ref={listRef} className="py-1.5">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-body text-muted-foreground">{t('noMentionResults')}</div>
          ) : (
            <>
              {showMentionAll && (
                <button
                  key="mention-all"
                  type="button"
                  data-mention-index={0}
                  className={rowClass(0)}
                  onMouseEnter={() => setActiveIndex(0)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectOption(options[0])
                  }}
                >
                  <span
                    aria-hidden
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-info text-white text-body font-semibold leading-none"
                  >
                    @
                  </span>
                  <span className="min-w-0 flex items-baseline gap-2">
                    <span className="truncate font-medium text-foreground">{mentionAllLabel}</span>
                    <span className="flex-shrink-0 text-caption text-muted-foreground/60">
                      {t('mentionAllHint')}
                    </span>
                  </span>
                </button>
              )}

              {filteredMembers.length > 0 && (
                <>
                  {showMentionAll && (
                    <div className="px-3 pt-2 pb-1 text-caption text-muted-foreground/60">
                      {t('mentionMembersSection')}
                    </div>
                  )}
                  {filteredMembers.map((member, memberOffset) => {
                    const idx = memberStartIndex + memberOffset
                    const displayName = memberDisplayName(member, profileDisplayNames)
                    const isAgent = member.member_type === 'agent' || (!member.user_id && !!member.agent_id)
                    const offline = isAgentExecutionOffline(member)
                    return (
                      <button
                        key={memberIdentity(member)}
                        type="button"
                        disabled={offline}
                        data-mention-index={idx}
                        data-offline={offline || undefined}
                        className={`${rowClass(idx)}${offline ? ' text-muted-foreground opacity-50 cursor-not-allowed hover:bg-transparent' : ''}`}
                        onMouseEnter={() => {
                          if (!offline) setActiveIndex(idx)
                        }}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          if (!offline) selectOption(options[idx])
                        }}
                      >
                        <ColorAvatar
                          name={displayName}
                          seed={memberIdentity(member)}
                          imageUrl={member.avatar || undefined}
                          isAgent={isAgent}
                          className={`h-7 w-7${offline ? ' opacity-50' : ''}`}
                          fallbackClassName="text-caption"
                        />
                        <span className={`truncate${offline ? ' opacity-60' : ''}`}>{displayName}</span>
                        {isAgent && (
                          <AgentMemberBadges
                            ownerName={agentOwnerDisplayName(member)}
                            offline={offline}
                            className="ml-auto"
                          />
                        )}
                      </button>
                    )
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    )
  },
)

MentionSelector.displayName = 'MentionSelector'
