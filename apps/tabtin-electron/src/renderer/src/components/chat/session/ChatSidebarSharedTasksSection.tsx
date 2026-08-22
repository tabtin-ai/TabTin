/**
 * 任务侧栏中的「协作任务」分组。
 *
 * 列表直接读取组织级共享授权事实；Centrifugo 事件只负责触发同一列表重拉。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Share2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import {
  SIDEBAR_CHEVRON,
  SIDEBAR_CHEVRON_TRAILING,
  SIDEBAR_COUNT,
  SIDEBAR_DIVIDER_BOTTOM,
  SIDEBAR_LIST_ICON,
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_LABEL_ACTIVE,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_ROW_LIST,
  SIDEBAR_SECTION_BLOCK,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
} from '@components/layout/sidebarUi'
import { listIncomingSessionShares, type SessionShareInfo } from '@/services/tabchatApi'
import { useIMStore } from '@/stores/useIMStore'
import { useSessionAccessStore } from '@/stores/chat/session/sessionAccessStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { cn } from '@/utils/cn'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChatSidebarSharedTasksSection')

export interface SharedTaskSelection {
  share: SessionShareInfo
}

export function normalizeIncomingSharedTasks(shares: SessionShareInfo[]): SessionShareInfo[] {
  const latestBySessionId = new Map<string, SessionShareInfo>()
  for (const share of shares) {
    if (share.direction === 'outgoing') continue
    const current = latestBySessionId.get(share.session_id)
    if (!current || shareTimestamp(share) >= shareTimestamp(current)) {
      latestBySessionId.set(share.session_id, share)
    }
  }
  return [...latestBySessionId.values()].filter(share => share.status !== 'revoked')
}

function shareTimestamp(share: SessionShareInfo): number {
  const parsed = Date.parse(share.created_at ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

type SharedTaskRow = SharedTaskSelection

interface Props {
  organizationId: string
  onSelectSharedSession: (selection: SharedTaskSelection) => void
}

export const ChatSidebarSharedTasksSection: React.FC<Props> = React.memo(({
  organizationId,
  onSelectSharedSession,
}) => {
  const { t } = useTranslation('tabchat')
  const shareListVersions = useIMStore(state => state.sessionShareListVersions)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const activeShareId = useSessionAccessStore(state => (
    currentSessionId ? state.bySessionId[currentSessionId]?.shareId ?? null : null
  ))
  const [collapsed, setCollapsed] = useState(false)
  const [rows, setRows] = useState<SharedTaskRow[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const loadGenerationRef = useRef(0)
  const currentSessionIdRef = useRef(currentSessionId)

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  const listVersion = useMemo(() => Object.values(shareListVersions)
    .reduce((sum, version) => sum + version, 0), [shareListVersions])

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current
    setIsLoading(true)
    setLoadError(false)
    try {
      const incoming = normalizeIncomingSharedTasks(
        await listIncomingSessionShares(organizationId),
      ).map(share => ({ share }))
      if (generation !== loadGenerationRef.current) return
      setRows(incoming)
      const activeSessionId = currentSessionIdRef.current
      const activeRow = activeSessionId
        ? incoming.find(row => row.share.session_id === activeSessionId)
        : undefined
      const activeDescriptor = activeSessionId
        ? useSessionAccessStore.getState().bySessionId[activeSessionId]
        : undefined
      if (activeRow && activeDescriptor) {
        useSessionAccessStore.getState().setSharedAccess({
          ...activeDescriptor,
          shareId: activeRow.share.id,
        })
      }
      log.info('协作任务列表加载完成', { organizationId, count: incoming.length })
    } catch (error) {
      if (generation !== loadGenerationRef.current) return
      log.error('协作任务列表加载失败', { organizationId }, error)
      setRows([])
      setLoadError(true)
    } finally {
      if (generation === loadGenerationRef.current) setIsLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    void load()
  }, [listVersion, load])

  const handleOpen = useCallback((row: SharedTaskRow) => {
    onSelectSharedSession(row)
  }, [onSelectSharedSession])

  return (
    <div className={cn(SIDEBAR_DIVIDER_BOTTOM, SIDEBAR_SECTION_BLOCK)} data-testid="chat-sidebar-shared-tasks-section">
      <div className={cn(SIDEBAR_SECTION_HEADER, SIDEBAR_ROW_FULL_WIDTH, 'flex items-center gap-1')}>
        <button
          type="button"
          onClick={() => setCollapsed(value => !value)}
          className="flex min-w-0 flex-1 items-center rounded-interactive text-left transition-colors hover:text-foreground"
          aria-expanded={!collapsed}
        >
          <span className={cn(SIDEBAR_SECTION_LABEL, 'min-w-0 flex-1')}>
            {t('sidebarSharedTasks.title', { defaultValue: '协作任务' })}
            {rows.length > 0 ? (
              <span className={cn('ml-1 normal-case tracking-normal', SIDEBAR_COUNT)}>({rows.length})</span>
            ) : null}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(value => !value)}
          className={SIDEBAR_CHEVRON_TRAILING}
          aria-expanded={!collapsed}
          aria-label={collapsed
            ? t('sidebarSharedTasks.expand', { defaultValue: '展开协作任务' })
            : t('sidebarSharedTasks.collapse', { defaultValue: '收起协作任务' })}
        >
          {collapsed
            ? <ChevronRight className={SIDEBAR_CHEVRON} aria-hidden />
            : <ChevronDown className={SIDEBAR_CHEVRON} aria-hidden />}
        </button>
      </div>

      {!collapsed ? (
        <div className={cn(SIDEBAR_ROW_LIST, 'pb-1')}>
          {loadError ? (
            <SidebarMenuItem onClick={() => { void load() }} fullWidth>
              <span className={SIDEBAR_LIST_ICON_SLOT}>
                <RefreshCw size={SIDEBAR_LIST_ICON_SIZE} className={SIDEBAR_LIST_ICON} strokeWidth={SIDEBAR_MENU_ICON_STROKE} aria-hidden />
              </span>
              <span className={SIDEBAR_ROW_LABEL_GROW}>
                {t('sidebarSharedTasks.retry', { defaultValue: '加载失败，点击重试' })}
              </span>
            </SidebarMenuItem>
          ) : isLoading && rows.length === 0 ? (
            <SidebarMenuItem as="div" fullWidth aria-busy="true" className="cursor-default">
              <span className={SIDEBAR_LIST_ICON_SLOT}>
                <Loader2 size={SIDEBAR_LIST_ICON_SIZE} className={cn(SIDEBAR_LIST_ICON, 'animate-spin')} strokeWidth={SIDEBAR_MENU_ICON_STROKE} aria-hidden />
              </span>
              <span className={SIDEBAR_ROW_LABEL_GROW}>
                {t('loading', { defaultValue: '加载中…' })}
              </span>
            </SidebarMenuItem>
          ) : rows.length === 0 ? (
            <SidebarMenuItem as="div" fullWidth className="cursor-default text-muted-foreground/60">
              <span className={SIDEBAR_LIST_ICON_SLOT}>
                <Share2 size={SIDEBAR_LIST_ICON_SIZE} className={SIDEBAR_LIST_ICON} strokeWidth={SIDEBAR_MENU_ICON_STROKE} aria-hidden />
              </span>
              <span className={SIDEBAR_ROW_LABEL_GROW}>
                {t('sidebarSharedTasks.empty', { defaultValue: '暂无收到的共享任务' })}
              </span>
            </SidebarMenuItem>
          ) : rows.map(row => {
            const isActive = row.share.session_id === currentSessionId && row.share.id === activeShareId
            return (
            <SidebarMenuItem
              key={row.share.id}
              onClick={() => handleOpen(row)}
              fullWidth
              active={isActive}
              aria-current={isActive ? 'page' : undefined}
              data-testid={`chat-sidebar-shared-task-${row.share.id}`}
            >
              <span
                className={SIDEBAR_LIST_ICON_SLOT}
                data-shared-task-status-slot
                aria-hidden
              />
              <span
                className={cn(
                  SIDEBAR_ROW_LABEL_GROW,
                  isActive && SIDEBAR_ROW_LABEL_ACTIVE,
                )}
                title={row.share.session_title || undefined}
              >
                {row.share.session_title || t('sessionShareTitleFallback', { defaultValue: '未命名任务' })}
              </span>
            </SidebarMenuItem>
            )
          })}
        </div>
      ) : null}
    </div>
  )
})

ChatSidebarSharedTasksSection.displayName = 'ChatSidebarSharedTasksSection'
