/**
 * ChatSessionHistoryMenu — 顶部 toolbar 里的最近对话标签
 *
 * 桌面模式 / 对话模式右侧 dock 的聊天面板（ChatSidePanel）隐藏了完整的
 * session tabs（`hideSessionTabs`），但用户仍需要在当前聊天上下文里快速切回
 * 最近对话。这里直接展示最近对话标签，复用 ChatPanel 已有的
 * `sessions` / `onSelectSession`，不引入第二套数据。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatSession } from '@tabtin/chat-client'
import { X } from 'lucide-react'
import { useSortedSessions } from '@/utils/chat-session-sort'
import { filterSidebarSessions } from './filterSidebarSessions'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { cn } from '@utils/cn'
import { useScopedEventListener, useScopedResizeObserver } from '@hooks/spaceActivity'
import { TabScrollIndicator } from '@components/context-space/ContextTabs/TabScrollIndicator'
import { scrollHorizontallyWithVerticalWheel } from '@utils/horizontalWheelScroll'
import { SessionArchiveDialog } from './SessionArchiveDialog'
import { useChatStore } from '@/stores/chat/useChatStore'
import { ExternalArchiveDeleteDialog, type ExternalArchiveDeleteTarget } from './ExternalArchiveDeleteDialog'
import { resolveExternalOpenedSession } from '@components/onboarding/external-import/externalOpenedSessionRegistry'

interface ChatSessionHistoryMenuProps {
  sessions: ChatSession[]
  currentSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  onDeleteExternalArchive?: (target: ExternalArchiveDeleteTarget) => void | Promise<void>
}

/** 顶部最多展示的最近对话标签数，避免挤占右侧 panel actions。 */
const MAX_RECENT_SESSION_LABELS = 8
const SCROLL_EDGE_EPSILON = 1
const RECENT_SESSION_TOOLTIP_DELAY_MS = 500

const getSessionLabel = (session: ChatSession, fallback: string): string => {
  const title = session.title?.trim() || fallback
  return title.length > 14 ? `${title.slice(0, 14)}…` : title
}

interface RecentSessionLabelProps {
  session: ChatSession
  isActive: boolean
  fallbackLabel: string
  activeLabelRef: React.RefObject<HTMLButtonElement | null>
  onSelectSession: (sessionId: string) => void
  onArchiveRequest?: (sessionId: string) => void
}

const RecentSessionLabel: React.FC<RecentSessionLabelProps> = ({
  session,
  isActive,
  fallbackLabel,
  activeLabelRef,
  onSelectSession,
  onArchiveRequest,
}) => {
  const { t } = useTranslation('chat')
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const [labelElement, setLabelElement] = useState<HTMLSpanElement | null>(null)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const label = getSessionLabel(session, fallbackLabel)
  const fullTitle = session.title?.trim() || fallbackLabel
  const setLabelNode = useCallback((node: HTMLSpanElement | null) => {
    labelRef.current = node
    setLabelElement(prev => (prev === node ? prev : node))
  }, [])
  const updateOverflow = useCallback(() => {
    const node = labelRef.current
    const measuredOverflow = node
      ? node.scrollWidth - node.clientWidth > SCROLL_EDGE_EPSILON
      : false
    setIsOverflowing(label !== fullTitle || measuredOverflow)
  }, [fullTitle, label])
  const windowTarget = typeof window === 'undefined' ? null : window

  useScopedEventListener(windowTarget, 'resize', updateOverflow)
  useScopedResizeObserver(labelElement, updateOverflow)

  useEffect(() => {
    updateOverflow()
  }, [updateOverflow])

  const tabButton = (
    <div
      className={cn(
        'group/recent-session inline-flex h-7 min-w-[48px] max-w-[160px] shrink-0 items-center rounded-interactive border border-transparent box-border text-caption transition-colors',
        isActive
          ? 'bg-foreground/[0.06] text-foreground font-medium dark:bg-foreground/[0.08]'
          : 'text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]',
      )}
    >
      <button
        ref={isActive ? activeLabelRef : undefined}
        type="button"
        onClick={() => onSelectSession(session.id)}
        onMouseEnter={updateOverflow}
        onFocus={updateOverflow}
        className={cn(
          'min-w-0 flex-1 rounded-interactive py-1 pl-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1',
          onArchiveRequest ? 'pr-1' : 'pr-2',
        )}
        aria-current={isActive ? 'page' : undefined}
        aria-label={fullTitle}
      >
        <span
          ref={setLabelNode}
          className="block truncate"
        >
          {label}
        </span>
      </button>
      {onArchiveRequest ? (
        <button
          type="button"
          draggable={false}
          className={cn(
            'app-region-no-drag no-drag mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-interactive transition-opacity hover:bg-foreground/[0.03] hover:text-foreground',
            isActive
              ? 'opacity-60 hover:opacity-100'
              : 'opacity-0 group-hover/recent-session:opacity-60 group-focus-within/recent-session:opacity-60 hover:opacity-100',
          )}
          aria-label={t('panel.closeRecentSession', {
            title: fullTitle,
            defaultValue: `关闭标签：${fullTitle}`,
          })}
          title={t('panel.closeRecentSession', {
            title: fullTitle,
            defaultValue: `关闭标签：${fullTitle}`,
          })}
          onMouseDown={event => {
            event.stopPropagation()
          }}
          onDragStart={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={event => {
            event.stopPropagation()
            onArchiveRequest(session.id)
          }}
        >
          <X className="h-2.5 w-2.5" aria-hidden />
        </button>
      ) : null}
    </div>
  )

  return (
    <ChatIconTooltip
      content={isOverflowing ? fullTitle : null}
      delayDuration={RECENT_SESSION_TOOLTIP_DELAY_MS}
    >
      {tabButton}
    </ChatIconTooltip>
  )
}
RecentSessionLabel.displayName = 'RecentSessionLabel'

export const ChatSessionHistoryMenu: React.FC<ChatSessionHistoryMenuProps> = ({
  sessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onDeleteExternalArchive,
}) => {
  const { t } = useTranslation('chat')
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const activeLabelRef = useRef<HTMLButtonElement | null>(null)
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null)
  const [externalArchiveTarget, setExternalArchiveTarget] = useState<ExternalArchiveDeleteTarget | null>(null)
  const resolveArchiveSpaceId = useCallback((sessionId: string) => {
    const session = sessions.find(item => item.id === sessionId)
    return session?.space_id ?? session?.workspace_id ?? null
  }, [sessions])

  const handleArchiveRequest = useCallback((sessionId: string) => {
    const externalTarget = resolveExternalOpenedSession(sessionId)
    if (externalTarget && onDeleteExternalArchive) {
      setExternalArchiveTarget(externalTarget)
      return
    }
    setArchiveTarget(sessionId)
  }, [onDeleteExternalArchive])

  const beginArchiveNow = useCallback((sessionId: string) => {
    const spaceId = resolveArchiveSpaceId(sessionId)
    if (spaceId) useChatStore.getState().beginOptimisticArchive(spaceId, sessionId)
  }, [resolveArchiveSpaceId])

  const rollbackArchiveNow = useCallback((sessionId: string) => {
    const spaceId = resolveArchiveSpaceId(sessionId) ?? ''
    useChatStore.getState().rollbackOptimisticArchive(spaceId, sessionId)
  }, [resolveArchiveSpaceId])
  // 与侧栏一致：丢掉预建后未发消息的空「新任务」，包括当前预热会话，
  // 避免草稿提前进入最近任务并在组织级混显时占满顶栏。
  const visibleSessions = useMemo(
    () => filterSidebarSessions(sessions, currentSessionId),
    [sessions, currentSessionId],
  )
  const sortedSessions = useSortedSessions(visibleSessions)
  const fallbackLabel = t('panel.newChat', { defaultValue: '新任务' })
  const recentSessions = sortedSessions.slice(0, MAX_RECENT_SESSION_LABELS)
  const recentSessionsSignature = useMemo(
    () => recentSessions
      .map(session => `${session.id}:${session.title ?? ''}:${session.updated_at ?? ''}:${session.last_message_at ?? ''}`)
      .join('|'),
    [recentSessions],
  )
  const updateScrollIndicators = useCallback(() => {
    const node = scrollContainer
    if (!node) return

    const maxScrollLeft = node.scrollWidth - node.clientWidth
    setCanScrollLeft(node.scrollLeft > SCROLL_EDGE_EPSILON)
    setCanScrollRight(maxScrollLeft - node.scrollLeft > SCROLL_EDGE_EPSILON)
  }, [scrollContainer])

  const windowTarget = typeof window === 'undefined' ? null : window
  useScopedEventListener(windowTarget, 'resize', updateScrollIndicators)
  useScopedResizeObserver(scrollContainer, updateScrollIndicators)

  useEffect(() => {
    updateScrollIndicators()
  }, [recentSessionsSignature, updateScrollIndicators])

  useEffect(() => {
    activeLabelRef.current?.scrollIntoView?.({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    })
  }, [currentSessionId])

  if (recentSessions.length === 0) return null

  return (
    <div
      className="relative min-w-0 flex-1"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {canScrollLeft && (
        <div
          className="pointer-events-none absolute left-0 top-0 bottom-0 z-sticky w-4 bg-gradient-to-r from-[hsl(var(--canvas)/0.7)] to-transparent backdrop-blur-[2px]"
          style={{
            maskImage: 'linear-gradient(to right, black, transparent)',
            WebkitMaskImage: 'linear-gradient(to right, black, transparent)',
          }}
          data-testid="recent-session-scroll-left"
        />
      )}
      {canScrollRight && (
        <div
          className="pointer-events-none absolute right-0 top-0 bottom-0 z-sticky w-4 bg-gradient-to-l from-[hsl(var(--canvas)/0.7)] to-transparent backdrop-blur-[2px]"
          style={{
            maskImage: 'linear-gradient(to left, black, transparent)',
            WebkitMaskImage: 'linear-gradient(to left, black, transparent)',
          }}
          data-testid="recent-session-scroll-right"
        />
      )}
      <div
        ref={(node) => {
          scrollViewportRef.current = node
          setScrollContainer(node)
        }}
        className="min-w-0 overflow-x-auto overflow-y-visible scrollbar-none"
        role="group"
        aria-label={t('panel.recentSessions', { defaultValue: '最近对话' })}
        onScroll={updateScrollIndicators}
        onWheel={(event) => {
          scrollHorizontallyWithVerticalWheel(event, scrollViewportRef.current)
        }}
      >
        <div data-recent-session-labels className="flex min-w-max items-center gap-1 px-1">
          {recentSessions.map((session) => {
            const isActive = session.id === currentSessionId

            return (
              <RecentSessionLabel
                key={session.id}
                session={session}
                isActive={isActive}
                fallbackLabel={fallbackLabel}
                activeLabelRef={activeLabelRef}
                onSelectSession={onSelectSession}
                onArchiveRequest={onDeleteSession ? handleArchiveRequest : undefined}
              />
            )
          })}
        </div>
      </div>
      <TabScrollIndicator
        viewportRef={scrollViewportRef}
        isHovered={isHovered}
        contentSelector="[data-recent-session-labels]"
        indicatorLabel={t('panel.recentSessionsScrollIndicator', { defaultValue: '拖动滚动最近对话' })}
        surfaceColor="hsl(var(--surface-canvas-card))"
        outlineColor="hsl(var(--border) / 0.35)"
      />
      <SessionArchiveDialog
        archiveTarget={archiveTarget}
        onOpenChange={(open) => { if (!open) setArchiveTarget(null) }}
        onBeginArchive={beginArchiveNow}
        onRollbackArchive={rollbackArchiveNow}
        onConfirm={(sessionId) => onDeleteSession?.(sessionId)}
        t={t}
      />
      <ExternalArchiveDeleteDialog
        target={externalArchiveTarget}
        onOpenChange={(open) => { if (!open) setExternalArchiveTarget(null) }}
        onConfirm={(target) => { if (onDeleteExternalArchive) void onDeleteExternalArchive(target) }}
        t={t}
      />
    </div>
  )
}
ChatSessionHistoryMenu.displayName = 'ChatSessionHistoryMenu'
