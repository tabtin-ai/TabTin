import React from 'react'
import { AlertCircle, Archive, ChevronDown, ChevronRight, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import {
  SIDEBAR_CHEVRON,
  SIDEBAR_COUNT,
  SIDEBAR_ROW_BODY_HOVER_MASK,
  SIDEBAR_ROW_LABEL,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
} from '@components/layout/sidebarUi'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import {
  type CollapsibleGroupKey,
  type SessionListVirtualItem,
} from './buildSessionListVirtualItems'
import { forkCollapseKey } from './nestForkSessions'
import { SessionListRow } from './SessionListRow'
import type { SessionLinkedWorktreeIndicator } from './resolveSessionLinkedWorktreeIndicator'
import type { ContextMenuState } from './useSessionSwitcherActions'
import { SessionSpaceTreeHeader } from './SessionSpaceTreeHeader'
import { SessionSpaceSectionHeader } from './SessionSpaceSectionHeader'
import type { ExecutionDeviceStatus } from '@components/context-space/terminalOverviewModel'

export interface SessionListVirtualRowProps {
  item: SessionListVirtualItem
  currentSessionId: string | null
  forkingSessionId: string | null
  pinnedSessionIds?: Set<string>
  sessionRowActionOpacity: string
  /** ：sessionId → linked worktree 展示模型（编排层预计算） */
  linkedWorktreeBySessionId?: Readonly<Record<string, SessionLinkedWorktreeIndicator>>
  scopeKey?: string | null
  highlightedSpaceId: string | null
  alreadyOnNewTaskLabel: string
  spaceSectionTitle?: string
  spaceSectionTitleByKey?: Record<string, string>
  createSpaceActionBySectionKey?: Record<string, React.ReactNode>
  showWorkspaceSortControlBySectionKey?: Record<string, boolean>
  showWorkspaceSortControl: boolean
  workspaceListSortMode: 'name' | 'activity'
  setWorkspaceListSortMode: (mode: 'name' | 'activity') => void
  createSpaceAction?: React.ReactNode
  resolveSpaceDeviceStatus: (targetSpaceId: string | null) => ExecutionDeviceStatus | null
  isSpaceAlreadyOnNewTask: (targetSpaceId: string | null) => boolean
  onCreateSessionInSpace?: (spaceId: string) => void
  canCreateSessionInSpace?: (spaceId: string) => boolean
  onOpenSpaceSettings?: (spaceId: string) => void
  onSelectSession: (sessionId: string) => void | Promise<void>
  onForkSession?: (sessionId: string) => void | Promise<void>
  onUnforkSession?: (sessionId: string) => void | Promise<void>
  onDeleteSession?: (sessionId: string) => void | Promise<void>
  onTogglePin?: (sessionId: string) => void
  onDragStart: (e: React.DragEvent, sessionId: string) => void
  onSetContextMenu: (state: ContextMenuState) => void
  onSetArchiveTarget: (sessionId: string) => void
  pendingArchiveSessionId?: string | null
  onToggleGroupCollapse: (key: CollapsibleGroupKey) => void
  onRetryTrackerRuns?: () => void
  onOpenExternalArchive?: (archive: {
    source: string
    sourceSessionId: string
  }) => void
  onRequestDeleteExternalArchive?: (archive: {
    source: string
    sourceSessionId: string
    title: string
    openedSessionId?: string | null
  }) => void
  externalOpenedSessionIds?: ReadonlySet<string>
  t: (key: string, opts?: Record<string, unknown>) => string
}

const SessionTimeGroupHeader: React.FC<{
  item: Extract<SessionListVirtualItem, { type: 'header' }>
  onToggle: (key: CollapsibleGroupKey) => void
}> = ({ item, onToggle }) => (
  <div
    role="button"
    tabIndex={0}
    className={cn(
      SIDEBAR_SECTION_HEADER,
      'mx-1.5 flex items-center gap-1 cursor-pointer select-none group/hdr',
    )}
    onClick={() => onToggle(item.key)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onToggle(item.key)
      }
    }}
  >
    <span className={cn(SIDEBAR_SECTION_LABEL, 'flex-1 min-w-0')}>
      {item.label}
    </span>
    <span className="ml-auto flex items-center gap-1 opacity-0 group-hover/hdr:opacity-100 transition-opacity">
      {item.collapsed && item.count !== null && (
        <span className={SIDEBAR_COUNT}>
          {item.count}
        </span>
      )}
      {item.collapsed
        ? <ChevronRight className={SIDEBAR_CHEVRON} />
        : <ChevronDown className={SIDEBAR_CHEVRON} />}
    </span>
  </div>
)

export const SessionListVirtualRow = React.memo(function SessionListVirtualRow(
  props: SessionListVirtualRowProps,
) {
  const { item, t } = props

  if (item.type === 'space_section_header') {
    return (
      <SessionSpaceSectionHeader
        spaceSectionTitle={
          (item.sectionKey ? props.spaceSectionTitleByKey?.[item.sectionKey] : undefined)
          ?? props.spaceSectionTitle
        }
        count={item.count}
        collapsed={item.collapsed}
        onToggleCollapse={() => props.onToggleGroupCollapse(
          `section:${item.sectionKey ?? 'default'}`,
        )}
        showWorkspaceSortControl={
          (item.sectionKey
            ? props.showWorkspaceSortControlBySectionKey?.[item.sectionKey]
            : undefined)
          ?? props.showWorkspaceSortControl
        }
        workspaceListSortMode={props.workspaceListSortMode}
        setWorkspaceListSortMode={props.setWorkspaceListSortMode}
        createSpaceAction={
          (item.sectionKey ? props.createSpaceActionBySectionKey?.[item.sectionKey] : undefined)
          ?? props.createSpaceAction
        }
        t={t}
      />
    )
  }

  if (item.type === 'header') {
    if (item.key.startsWith('space:')) {
      return (
        <SessionSpaceTreeHeader
          item={item}
          highlightedSpaceId={props.highlightedSpaceId}
          alreadyOnNewTaskLabel={props.alreadyOnNewTaskLabel}
          resolveSpaceDeviceStatus={props.resolveSpaceDeviceStatus}
          isSpaceAlreadyOnNewTask={props.isSpaceAlreadyOnNewTask}
          onToggleCollapse={props.onToggleGroupCollapse}
          onCreateSessionInSpace={props.onCreateSessionInSpace}
          canCreateSessionInSpace={props.canCreateSessionInSpace}
          onOpenSpaceSettings={props.onOpenSpaceSettings}
          t={t}
        />
      )
    }
    return <SessionTimeGroupHeader item={item} onToggle={props.onToggleGroupCollapse} />
  }

  if (item.type === 'external_archive') {
    const title = item.archive.title?.trim() || t('sessionList.untitled', { defaultValue: '新任务' })
    const empty = item.archive.messageCount <= 0
    const canDelete = Boolean(props.onRequestDeleteExternalArchive)
    const openArchive = () => {
      if (empty) return
      props.onOpenExternalArchive?.({
        source: item.archive.source,
        sourceSessionId: item.archive.sourceSessionId,
      })
    }
    return (
      <SidebarMenuItem
        as="div"
        role="button"
        tabIndex={empty ? -1 : 0}
        aria-disabled={empty || undefined}
        className={cn(
          'pl-6 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2',
          empty && 'opacity-50',
          empty && 'cursor-default',
        )}
        onClick={() => {
          if (empty) return
          openArchive()
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          openArchive()
        }}
        data-testid="sidebar-external-archive-row"
        title={
          empty
            ? `${title} · 无消息，无法打开`
            : item.archive.openedSessionId
              ? `${title} · 回到已打开的对话`
              : `${title} · 打开为特殊新对话`
        }
      >
        <Archive className="h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden />
        <span
          className={cn(
            SIDEBAR_ROW_LABEL,
            'min-w-0 flex-1 truncate text-foreground/90',
            canDelete && SIDEBAR_ROW_BODY_HOVER_MASK,
          )}
        >
          {title}
        </span>
        {canDelete && (
          <div
            className={cn(
              'absolute right-1.5 top-1/2 -translate-y-1/2',
              props.sessionRowActionOpacity,
              'rounded-interactive bg-background/40 py-0.5 pl-1 pr-0 backdrop-blur-md dark:bg-background/40',
              '[@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:group-hover:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:pointer-events-auto',
            )}
          >
            <ChatIconTooltip content={t('sessionList.deleteExternalArchive', { defaultValue: '删除外部档案' })}>
              <span
                role="button"
                tabIndex={0}
                data-testid="sidebar-external-archive-delete"
                className="h-5 w-5 inline-flex items-center justify-center rounded-interactive text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  props.onRequestDeleteExternalArchive?.({
                    source: item.archive.source,
                    sourceSessionId: item.archive.sourceSessionId,
                    title,
                    openedSessionId: item.archive.openedSessionId,
                  })
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  e.stopPropagation()
                  props.onRequestDeleteExternalArchive?.({
                    source: item.archive.source,
                    sourceSessionId: item.archive.sourceSessionId,
                    title,
                    openedSessionId: item.archive.openedSessionId,
                  })
                }}
                aria-label={t('sessionList.deleteExternalArchive', { defaultValue: '删除外部档案' })}
              >
                <Trash2 className="h-3 w-3" />
              </span>
            </ChatIconTooltip>
          </div>
        )}
      </SidebarMenuItem>
    )
  }

  if (item.type === 'tracker_loading') {
    return (
      <SidebarMenuItem
        as="div"
        className="cursor-default"
        aria-label={t('sessionList.trackerRunsLoading', { defaultValue: '正在加载自动化任务执行记录…' })}
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/60" />
        <span className={cn(SIDEBAR_ROW_LABEL, 'text-muted-foreground/60')}>
          {t('sessionList.trackerRunsLoading', { defaultValue: '正在加载自动化任务执行记录…' })}
        </span>
      </SidebarMenuItem>
    )
  }

  if (item.type === 'tracker_error') {
    return (
      <SidebarMenuItem as="div" className="cursor-default flex-col items-stretch gap-1.5 py-2">
        <div className="flex items-center gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive/80" />
          <span className={cn(SIDEBAR_ROW_LABEL, 'text-destructive/80')}>
            {t('sessionList.trackerRunsLoadFailed', { defaultValue: '加载失败' })}
          </span>
        </div>
        <button
          type="button"
          className="self-start inline-flex items-center gap-1 rounded-interactive px-1.5 py-0.5 text-caption text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => props.onRetryTrackerRuns?.()}
          disabled={!props.onRetryTrackerRuns}
        >
          <RotateCcw className="h-3 w-3" />
          <span>{t('sessionList.trackerRunsRetry', { defaultValue: '重试' })}</span>
        </button>
      </SidebarMenuItem>
    )
  }

  const isExternalOpened = props.externalOpenedSessionIds?.has(item.session.id) ?? false
  return (
    <SessionListRow
      session={item.session}
      forkDepth={item.forkDepth}
      forkBranch={item.forkBranch}
      isActive={item.session.id === props.currentSessionId}
      isPinned={props.pinnedSessionIds?.has(item.session.id) ?? false}
      forkingSessionId={props.forkingSessionId}
      onSelectSession={props.onSelectSession}
      onForkSession={isExternalOpened ? undefined : props.onForkSession}
      onUnforkSession={isExternalOpened ? undefined : props.onUnforkSession}
      onDeleteSession={props.onDeleteSession}
      onTogglePin={props.onTogglePin}
      onToggleForkCollapse={(sessionId) => {
        props.onToggleGroupCollapse(forkCollapseKey(sessionId))
      }}
      onDragStart={props.onDragStart}
      onSetContextMenu={props.onSetContextMenu}
      onSetArchiveTarget={props.onSetArchiveTarget}
      pendingArchiveSessionId={props.pendingArchiveSessionId}
      sessionRowActionOpacity={props.sessionRowActionOpacity}
      linkedWorktreeIndicator={props.linkedWorktreeBySessionId?.[item.session.id] ?? null}
      scopeKey={props.scopeKey}
      isExternalOpened={isExternalOpened}
      t={t}
    />
  )
})
