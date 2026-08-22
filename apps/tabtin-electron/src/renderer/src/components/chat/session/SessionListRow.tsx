import React from 'react'
import { Archive, Check, ChevronDown, ChevronRight, GitFork, Loader2, Outdent, Pin, PinOff, Trash2 } from 'lucide-react'
import { cn } from '@utils/cn'
import type { ChatSession } from '@tabtin/chat-client'
import { warmSpacePathCache } from '@/utils/buildSessionReferenceClipboardText'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useSessionReadStore } from '@/stores/useSessionReadStore'
import { resolveSessionHasUnreadReply } from '@/stores/chat/session/sessionReadProjection'
import { getSessionActivityTs } from '@/utils/chat-session-sort'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import {
  SIDEBAR_CHEVRON,
  SIDEBAR_CHEVRON_TRAILING,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_ROW_BODY,
  SIDEBAR_ROW_BODY_HOVER_MASK,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_META_END,
} from '@components/layout/sidebarUi'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { SessionStatusIcon } from './SessionStatusIcon'
import { SessionWorktreeIndicator } from './SessionWorktreeIndicator'
import { formatRelativeTimeFromTs } from './formatRelativeTimeFromTs'
import { FORK_TREE_GUIDE_WIDTH_PX } from './nestForkSessions'
import type { SessionLinkedWorktreeIndicator } from './resolveSessionLinkedWorktreeIndicator'
import type { ContextMenuState } from './useSessionSwitcherActions'

/** 文件夹树式 └：左缘对齐父行标题首字，右侧紧贴子行标题 */
function ForkTreeGuide() {
  return (
    <span
      aria-hidden
      className="pointer-events-none flex h-4 shrink-0 items-center text-muted-foreground/60"
      style={{ width: FORK_TREE_GUIDE_WIDTH_PX }}
    >
      <svg
        width={FORK_TREE_GUIDE_WIDTH_PX}
        height="16"
        viewBox={`0 0 ${FORK_TREE_GUIDE_WIDTH_PX} 16`}
        fill="none"
        className="block"
      >
        <path
          d={`M1 0V8H${FORK_TREE_GUIDE_WIDTH_PX}`}
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="square"
        />
      </svg>
    </span>
  )
}

export interface SessionListRowProps {
  session: ChatSession
  isActive: boolean
  isPinned: boolean
  forkingSessionId: string | null
  onSelectSession: (id: string) => void | Promise<void>
  onForkSession?: (id: string) => void | Promise<void>
  onUnforkSession?: (id: string) => void | Promise<void>
  onDeleteSession?: (id: string) => void | Promise<void>
  onTogglePin?: (id: string) => void
  onToggleForkCollapse?: (sessionId: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void
  onSetContextMenu: (state: ContextMenuState) => void
  onSetArchiveTarget: (id: string) => void
  pendingArchiveSessionId?: string | null
  sessionRowActionOpacity: string
  /** ：绑定 linked worktree 时右侧常显；行 hover 时淡出 */
  linkedWorktreeIndicator?: SessionLinkedWorktreeIndicator | null
  forkDepth?: number
  forkBranch?: { collapsed: boolean; childCount: number }
  scopeKey?: string | null
  /** 外部档案展开的本机会话：归档语义为删除，且不分叉 */
  isExternalOpened?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any
}

export const SessionListRow = React.memo<SessionListRowProps>(({
  session, isActive, isPinned, forkingSessionId,
  onSelectSession, onForkSession, onUnforkSession, onDeleteSession, onTogglePin, onToggleForkCollapse,
  onDragStart, onSetContextMenu, onSetArchiveTarget,
  pendingArchiveSessionId = null,
  sessionRowActionOpacity, linkedWorktreeIndicator = null,
  forkDepth = 0, forkBranch, scopeKey, isExternalOpened = false, t,
}) => {
  const handleSelect = () => {
    void onSelectSession(session.id)
  }

  const relativeTime = formatRelativeTimeFromTs(getSessionActivityTs(session), t)
  const sessionTitle = session.title || t('sessionList.untitled', { defaultValue: '新任务' })
  const hasPendingInteraction = useChatStore(
    (s) =>
      Boolean(s.pendingApprovalBySessionId[session.id]) ||
      Boolean(s.pendingAskUserBySessionId[session.id]),
  )
  const lastMessageAt = session.last_message_at ?? session.updated_at ?? session.created_at ?? null
  const legacyUnread = useSessionReadStore(
    React.useCallback(
      (s) => (isActive ? false : s.isUnread(session.id, lastMessageAt)),
      [isActive, session.id, lastMessageAt],
    ),
  )
  const hasUnread = isActive
    ? false
    : resolveSessionHasUnreadReply(session, legacyUnread)
  const isForkChild = forkDepth > 0
  const showForkCollapse = Boolean(forkBranch && onToggleForkCollapse)
  const archiveSessionLabel = t('session.archiveTitle', { defaultValue: '归档对话' })
  const archiveConfirmHint = t('session.archiveInlineConfirmHint', { defaultValue: '再次点击以归档对话' })
  const isArchiveConfirming = !isExternalOpened && pendingArchiveSessionId === session.id

  const titleBlock = (
    <div className={cn(SIDEBAR_ROW_BODY, !isForkChild && SIDEBAR_ROW_BODY_HOVER_MASK)}>
      <div className="flex min-w-0 items-center gap-1">
        <span className={SIDEBAR_ROW_LABEL_GROW}>
          {sessionTitle}
        </span>
        {hasPendingInteraction && (
          <span
            className="shrink-0 rounded-full bg-warning/10 px-1.5 py-px text-caption text-warning"
            title={t('session.pendingPillTooltip', { defaultValue: '该对话有待你处理的事项' })}
          >
            {t('session.pendingPill', { defaultValue: '待处理' })}
          </span>
        )}
      </div>
    </div>
  )

  return (
    <SidebarMenuItem
      as="div"
      role="button"
      tabIndex={0}
      active={isActive}
      aria-expanded={forkBranch ? !forkBranch.collapsed : undefined}
      className={cn(
        'ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2',
        // fork 折叠箭头改为 absolute 后，给标题预留右缘，避免与箭头重叠
        showForkCollapse && 'pr-8',
      )}
      draggable
      onDragStart={(e) => onDragStart(e, session.id)}
      onClick={handleSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleSelect()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        const spaceId = session.space_id ?? session.workspace_id ?? scopeKey
        const wtId = session.organization_id
        if (spaceId && wtId) {
          warmSpacePathCache(spaceId, wtId)
        }
        onSetContextMenu({ open: true, x: e.clientX, y: e.clientY, sessionId: session.id })
      }}
      title={sessionTitle}
    >
      {/* 状态在最前；根行 hover 出 pin，fork 子行 hover 出「弹出为根级」 */}
      <div className={cn(SIDEBAR_LIST_ICON_SLOT, 'relative')}>
        {isForkChild && onUnforkSession ? (
          <>
            <span className="group-hover:invisible">
              <SessionStatusIcon session={session} unread={hasUnread} />
            </span>
            <ChatIconTooltip
              content={t('session.unforkSession', { defaultValue: '弹出为独立对话' })}
              triggerClassName="absolute inset-0 invisible group-hover:visible"
            >
              <button
                type="button"
                className="flex h-full w-full items-center justify-center text-muted-foreground/60 hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); void onUnforkSession(session.id) }}
                aria-label={t('session.unforkSession', { defaultValue: '弹出为独立对话' })}
              >
                <Outdent className="h-3.5 w-3.5" />
              </button>
            </ChatIconTooltip>
          </>
        ) : onTogglePin ? (
          <>
            <span className="group-hover:invisible">
              <SessionStatusIcon session={session} unread={hasUnread} />
            </span>
            <ChatIconTooltip
              content={isPinned ? t('session.unpin', { defaultValue: '取消置顶' }) : t('session.pin', { defaultValue: '置顶' })}
              triggerClassName="absolute inset-0 invisible group-hover:visible"
            >
              <button
                type="button"
                className="flex h-full w-full items-center justify-center text-muted-foreground/60 hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); onTogglePin(session.id) }}
                aria-label={isPinned ? t('session.unpin', { defaultValue: '取消置顶' }) : t('session.pin', { defaultValue: '置顶' })}
              >
                {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              </button>
            </ChatIconTooltip>
          </>
        ) : (
          <SessionStatusIcon session={session} unread={hasUnread} />
        )}
      </div>
      {isForkChild ? (
        <div className={cn(
          'flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden',
          SIDEBAR_ROW_BODY_HOVER_MASK,
        )}
        >
          <ForkTreeGuide />
          {titleBlock}
        </div>
      ) : titleBlock}
      <div
        className={cn(
          // 最右侧同槽叠放：默认 worktree 标识；hover 时标识淡出、操作淡入，互不抢水平位
          'absolute top-1/2 h-5 -translate-y-1/2',
          showForkCollapse ? 'right-8' : 'right-1.5',
        )}
      >
        {linkedWorktreeIndicator && (
          <div className="absolute inset-y-0 right-0 flex items-center">
            <SessionWorktreeIndicator
              indicator={linkedWorktreeIndicator}
              fadeOnRowHoverClassName="transition-opacity opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-0"
              label={t('session.linkedWorktreeIndicator', {
                defaultValue: '独立工作树：{{branch}} · {{path}}',
                branch: linkedWorktreeIndicator.branch
                  || t('session.linkedWorktreeDetached', { defaultValue: '分离头指针' }),
                path: linkedWorktreeIndicator.path,
              })}
            />
          </div>
        )}
        <div
          className={cn(
            'absolute inset-y-0 right-0 flex items-center',
            sessionRowActionOpacity,
            'rounded-interactive bg-background/40 py-0.5 pl-1 pr-0 backdrop-blur-md dark:bg-background/40',
            '[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:group-hover:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:pointer-events-auto',
          )}
        >
          <div className="inline-flex items-center gap-0.5">
            {relativeTime && (
              // max-w-none：SIDEBAR_META_END 的 max-w-[40%] 在 shrink-to-fit 工具条里会撑出多余右边距
              <span className={cn(SIDEBAR_META_END, 'max-w-none')}>
                {relativeTime}
              </span>
            )}
            {onForkSession && (
              <ChatIconTooltip content={t('session.forkSession')}>
                <span
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'h-5 w-5 inline-flex items-center justify-center rounded-interactive text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground transition-colors',
                    forkingSessionId === session.id && 'pointer-events-none opacity-50',
                  )}
                  onClick={(e) => { e.stopPropagation(); void onForkSession(session.id) }}
                  onKeyDown={(e) => { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); e.stopPropagation(); void onForkSession(session.id) }}
                  aria-label={t('session.forkSession')}
                >
                  {forkingSessionId === session.id
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <GitFork className="h-3 w-3" />}
                </span>
              </ChatIconTooltip>
            )}
            {onDeleteSession && session.status !== 'archived' && (
              <ChatIconTooltip
                open={isArchiveConfirming || undefined}
                delayDuration={0}
                content={isExternalOpened
                  ? t('sessionList.deleteExternalArchive', { defaultValue: '删除外部档案' })
                  : (isArchiveConfirming ? archiveConfirmHint : archiveSessionLabel)}
              >
                <span
                  role="button"
                  tabIndex={0}
                  data-testid={isExternalOpened ? 'sidebar-external-opened-delete' : 'sidebar-session-archive'}
                  className={cn(
                    'h-5 w-5 inline-flex items-center justify-center rounded-interactive text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground transition-colors',
                    isArchiveConfirming && 'text-foreground bg-foreground/[0.05]',
                  )}
                  onClick={(e) => { e.stopPropagation(); onSetArchiveTarget(session.id) }}
                  onKeyDown={(e) => { if (e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); e.stopPropagation(); onSetArchiveTarget(session.id) }}
                  aria-label={isExternalOpened
                    ? t('sessionList.deleteExternalArchive', { defaultValue: '删除外部档案' })
                    : (isArchiveConfirming ? archiveConfirmHint : archiveSessionLabel)}
                >
                  {isExternalOpened
                    ? <Trash2 className="h-3 w-3" />
                    : (isArchiveConfirming ? <Check className="h-3 w-3" /> : <Archive className="h-3 w-3" />)}
                </span>
              </ChatIconTooltip>
            )}
          </div>
        </div>
      </div>
      {forkBranch && onToggleForkCollapse ? (
        <button
          type="button"
          // absolute：勿用文档流 h-7 撑高行高，否则虚拟列表估高 32 会与下一行叠字
          className={cn(
            SIDEBAR_CHEVRON_TRAILING,
            'absolute right-1.5 top-1/2 ml-0 -translate-y-1/2',
          )}
          onClick={(e) => {
            e.stopPropagation()
            onToggleForkCollapse(session.id)
          }}
          aria-label={forkBranch.collapsed
            ? t('sessionList.expandForkChildren', { defaultValue: '展开分支对话' })
            : t('sessionList.collapseForkChildren', { defaultValue: '折叠分支对话' })}
        >
          {forkBranch.collapsed
            ? <ChevronRight className={SIDEBAR_CHEVRON} aria-hidden />
            : <ChevronDown className={SIDEBAR_CHEVRON} aria-hidden />}
        </button>
      ) : null}
    </SidebarMenuItem>
  )
})
SessionListRow.displayName = 'SessionListRow'
