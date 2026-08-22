/**
 * SidebarAgentsPrimaryNav — AI 分身域侧栏顶栏（对齐 SidebarIMPrimaryNav / SidebarTaskPrimaryNav）。
 *
 * 开新分身（整行动作）+ 已停用（toggle，主画布切到停用列表）。
 */

import React from 'react'
import { Ban, Bot } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import {
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_TASK_PRIMARY_NAV_ACTIVE,
  SIDEBAR_TASK_PRIMARY_NAV_INACTIVE,
  SIDEBAR_TASK_PRIMARY_NAV_LABEL,
  SIDEBAR_TASK_PRIMARY_NAV_ROW,
  SIDEBAR_TASK_PRIMARY_NAV_SHELL,
} from './sidebarUi'

interface SidebarAgentsPrimaryNavProps {
  isDeactivatedActive: boolean
  createDisabled?: boolean
  onCreateAgent: () => void
  onToggleDeactivated: () => void
}

export const SidebarAgentsPrimaryNav: React.FC<SidebarAgentsPrimaryNavProps> = ({
  isDeactivatedActive,
  createDisabled = false,
  onCreateAgent,
  onToggleDeactivated,
}) => {
  const { t } = useTranslation(['sidebar', 'settings'])

  const createLabel = t('settings:myAgents.newAgent', { defaultValue: '开新分身' })
  const deactivatedLabel = t('settings:myAgents.deactivated.entry', { defaultValue: '已停用' })

  return (
    <nav
      className={SIDEBAR_TASK_PRIMARY_NAV_SHELL}
      aria-label={t('sidebar:agentsPrimaryNav.label', { defaultValue: 'AI 分身快捷入口' })}
      data-testid="sidebar-agents-primary-nav"
    >
      <button
        type="button"
        onClick={onCreateAgent}
        disabled={createDisabled}
        aria-label={createLabel}
        title={createLabel}
        className={cn(
          SIDEBAR_TASK_PRIMARY_NAV_ROW,
          SIDEBAR_TASK_PRIMARY_NAV_INACTIVE,
          createDisabled && 'cursor-not-allowed opacity-40',
        )}
        data-testid="sidebar-agents-create-button"
      >
        <span className={SIDEBAR_LIST_ICON_SLOT}>
          <Bot
            size={SIDEBAR_LIST_ICON_SIZE}
            strokeWidth={SIDEBAR_MENU_ICON_STROKE}
            aria-hidden
          />
        </span>
        <span className={SIDEBAR_TASK_PRIMARY_NAV_LABEL}>{createLabel}</span>
      </button>

      <button
        type="button"
        onClick={onToggleDeactivated}
        aria-pressed={isDeactivatedActive}
        aria-current={isDeactivatedActive ? 'page' : undefined}
        aria-label={deactivatedLabel}
        title={deactivatedLabel}
        className={cn(
          SIDEBAR_TASK_PRIMARY_NAV_ROW,
          isDeactivatedActive ? SIDEBAR_TASK_PRIMARY_NAV_ACTIVE : SIDEBAR_TASK_PRIMARY_NAV_INACTIVE,
        )}
        data-testid="sidebar-agents-deactivated-button"
      >
        <span className={SIDEBAR_LIST_ICON_SLOT}>
          <Ban
            size={SIDEBAR_LIST_ICON_SIZE}
            strokeWidth={SIDEBAR_MENU_ICON_STROKE}
            aria-hidden
          />
        </span>
        <span className={SIDEBAR_TASK_PRIMARY_NAV_LABEL}>{deactivatedLabel}</span>
      </button>
    </nav>
  )
}

SidebarAgentsPrimaryNav.displayName = 'SidebarAgentsPrimaryNav'
