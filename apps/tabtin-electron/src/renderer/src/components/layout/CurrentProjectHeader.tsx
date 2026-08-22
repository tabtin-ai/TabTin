import React from 'react'
import { FolderKanban, LogOut } from 'lucide-react'
import { cn } from '@utils/cn'
import {
  SIDEBAR_ICON,
  SIDEBAR_ICON_BUTTON,
  SIDEBAR_ICON_SM,
  SIDEBAR_LIST_ICON,
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_PANEL_PRIMARY_TOP_SHELL,
  SIDEBAR_ROW_BODY,
  SIDEBAR_ROW_LABEL,
  SIDEBAR_ROW_LABEL_ACTIVE,
  SIDEBAR_TASK_PRIMARY_NAV_ACTIVE,
  SIDEBAR_TASK_PRIMARY_NAV_ROW,
} from './sidebarUi'

export interface CurrentProjectHeaderProps {
  projectName: string
  onExit: () => void
}

/**
 * Project 沉浸侧栏顶锚：当前项目名 +「退出项目 / 回组织」。
 * 退出路径由调用方接 exitTeamSpaceProjectView。
 */
export const CurrentProjectHeader: React.FC<CurrentProjectHeaderProps> = ({
  projectName,
  onExit,
}) => (
  <div className={SIDEBAR_PANEL_PRIMARY_TOP_SHELL} data-testid="current-project-header">
    <div className="flex min-w-0 items-center gap-1">
      <div
        className={cn(
          SIDEBAR_TASK_PRIMARY_NAV_ROW,
          SIDEBAR_TASK_PRIMARY_NAV_ACTIVE,
          'min-w-0 flex-1 cursor-default',
        )}
        aria-current="page"
      >
        <span className={cn(SIDEBAR_LIST_ICON_SLOT, 'rounded-md bg-accent/10 text-accent')}>
          <FolderKanban className={SIDEBAR_LIST_ICON} size={SIDEBAR_LIST_ICON_SIZE} strokeWidth={SIDEBAR_MENU_ICON_STROKE} aria-hidden />
        </span>
        <div className={SIDEBAR_ROW_BODY}>
          <span className={cn(SIDEBAR_ROW_LABEL, SIDEBAR_ROW_LABEL_ACTIVE)}>
            {projectName}
          </span>
        </div>
      </div>
      <button
        type="button"
        aria-label={`退出 ${projectName}`}
        title="退出当前 Project"
        onClick={onExit}
        className={cn(SIDEBAR_ICON_BUTTON, 'mr-1.5 shrink-0')}
        data-testid="exit-current-project"
      >
        <LogOut className={SIDEBAR_ICON_SM} aria-hidden />
      </button>
    </div>
  </div>
)

CurrentProjectHeader.displayName = 'CurrentProjectHeader'
