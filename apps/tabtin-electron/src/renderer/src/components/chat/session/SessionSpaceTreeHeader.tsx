import React from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import { cn } from '@utils/cn'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import {
  SIDEBAR_ICON_ACTIVE,
  SIDEBAR_LIST_ICON,
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_ROW_ACTIVE_CONTEXT_ACCENT,
  SIDEBAR_ROW_LABEL_GROW,
} from '@components/layout/sidebarUi'
import { ExecutionDeviceStatusTag } from '@components/context-space/ExecutionDeviceStatusTag'
import type { ExecutionDeviceStatus } from '@components/context-space/terminalOverviewModel'
import { SpaceTreeCreateSessionButton, SpaceTreeSettingsButton } from './SessionSpaceTreeHeaderActions'
import type { SessionListVirtualItem } from './buildSessionListVirtualItems'

function resolveCreateSessionActionSpaceId(
  targetSpaceId: string | null,
  onCreateSessionInSpace?: (spaceId: string) => void,
  canCreateSessionInSpace?: (spaceId: string) => boolean,
): string | null {
  if (!targetSpaceId || !onCreateSessionInSpace) return null
  return !canCreateSessionInSpace || canCreateSessionInSpace(targetSpaceId)
    ? targetSpaceId
    : null
}

export interface SessionSpaceTreeHeaderProps {
  item: Extract<SessionListVirtualItem, { type: 'header' }>
  highlightedSpaceId: string | null
  alreadyOnNewTaskLabel: string
  resolveSpaceDeviceStatus: (targetSpaceId: string | null) => ExecutionDeviceStatus | null
  isSpaceAlreadyOnNewTask: (targetSpaceId: string | null) => boolean
  onToggleCollapse: (key: Extract<SessionListVirtualItem, { type: 'header' }>['key']) => void
  onCreateSessionInSpace?: (spaceId: string) => void
  canCreateSessionInSpace?: (spaceId: string) => boolean
  onOpenSpaceSettings?: (spaceId: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
}

export const SessionSpaceTreeHeader: React.FC<SessionSpaceTreeHeaderProps> = ({
  item,
  highlightedSpaceId,
  alreadyOnNewTaskLabel,
  resolveSpaceDeviceStatus,
  isSpaceAlreadyOnNewTask,
  onToggleCollapse,
  onCreateSessionInSpace,
  canCreateSessionInSpace,
  onOpenSpaceSettings,
  t,
}) => {
  const targetSpaceId = item.key.startsWith('space:') ? item.key.slice('space:'.length) : null
  const isContextActive = Boolean(targetSpaceId && targetSpaceId === highlightedSpaceId)
  const collapsed = item.collapsed
  const deviceStatus = resolveSpaceDeviceStatus(targetSpaceId)
  const settingsLabel = t('sessionList.openSpaceSettings', { defaultValue: '工作空间设置' })
  const hasExternalArchives = (item.externalArchiveCount ?? 0) > 0
  const spaceCreateDisabled = isSpaceAlreadyOnNewTask(targetSpaceId) && !hasExternalArchives
  const newSessionLabel = spaceCreateDisabled
    ? alreadyOnNewTaskLabel
    : t('sessionList.newSessionInSpace', { defaultValue: '在此工作空间新建任务' })
  const rowLabel = t(collapsed ? 'sessionList.expandSpace' : 'sessionList.collapseSpace', {
    defaultValue: collapsed ? '展开 {{name}}' : '收起 {{name}}',
    name: item.label,
  })
  const headerTitle = deviceStatus ? `${rowLabel} · ${deviceStatus.title}` : rowLabel
  const createActionSpaceId = resolveCreateSessionActionSpaceId(
    targetSpaceId,
    onCreateSessionInSpace,
    canCreateSessionInSpace,
  )

  const folderIconClass = cn(
    SIDEBAR_LIST_ICON,
    isContextActive && SIDEBAR_ICON_ACTIVE,
  )

  return (
    <SidebarMenuItem
      as="div"
      contextActive={isContextActive}
      contextActiveClassName={SIDEBAR_ROW_ACTIVE_CONTEXT_ACCENT}
      className="cursor-pointer"
      role="button"
      tabIndex={0}
      aria-label={rowLabel}
      aria-expanded={!collapsed}
      aria-current={isContextActive ? 'true' : undefined}
      data-testid={targetSpaceId ? `space-tree-header-${targetSpaceId}` : undefined}
      title={headerTitle}
      onClick={() => onToggleCollapse(item.key)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onToggleCollapse(item.key)
      }}
    >
      <span className={SIDEBAR_LIST_ICON_SLOT}>
        {!collapsed ? (
          <FolderOpen
            size={SIDEBAR_LIST_ICON_SIZE}
            className={folderIconClass}
            strokeWidth={SIDEBAR_MENU_ICON_STROKE}
          />
        ) : (
          <Folder
            size={SIDEBAR_LIST_ICON_SIZE}
            className={folderIconClass}
            strokeWidth={SIDEBAR_MENU_ICON_STROKE}
          />
        )}
      </span>
      <span className={SIDEBAR_ROW_LABEL_GROW}>
        {item.label}
      </span>
      {deviceStatus ? (
        <ExecutionDeviceStatusTag status={deviceStatus} />
      ) : null}
      {createActionSpaceId && onCreateSessionInSpace ? (
        <SpaceTreeCreateSessionButton
          targetSpaceId={createActionSpaceId}
          disabled={spaceCreateDisabled}
          label={newSessionLabel}
          onCreateSessionInSpace={onCreateSessionInSpace}
        />
      ) : null}
      {targetSpaceId && onOpenSpaceSettings ? (
        <SpaceTreeSettingsButton
          targetSpaceId={targetSpaceId}
          label={settingsLabel}
          onOpenSpaceSettings={onOpenSpaceSettings}
        />
      ) : null}
    </SidebarMenuItem>
  )
}
