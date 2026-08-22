/**
 * SidebarIMPrimaryNav — 消息域侧栏顶栏（对齐任务域 SidebarTaskPrimaryNav）。
 *
 * 创建群组（等同「新任务」整行入口）+ 通讯录（等同模块入口 toggle）。
 */

import React from 'react'
import { Contact, UsersRound } from 'lucide-react'
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

interface SidebarIMPrimaryNavProps {
  isContactsActive: boolean
  createGroupDisabled?: boolean
  onToggleContacts: () => void
  onCreateGroup: () => void
}

export const SidebarIMPrimaryNav: React.FC<SidebarIMPrimaryNavProps> = ({
  isContactsActive,
  createGroupDisabled = false,
  onToggleContacts,
  onCreateGroup,
}) => {
  const { t } = useTranslation('tabchat')

  const createGroupLabel = t('createGroup', { defaultValue: '创建群组' })
  const contactsLabel = t('contacts', { defaultValue: '通讯录' })

  return (
    <nav
      className={SIDEBAR_TASK_PRIMARY_NAV_SHELL}
      aria-label={t('imPrimaryNav.label', { defaultValue: '消息快捷入口' })}
      data-testid="sidebar-im-primary-nav"
    >
      <button
        type="button"
        onClick={onCreateGroup}
        disabled={createGroupDisabled}
        aria-label={createGroupLabel}
        title={createGroupLabel}
        className={cn(
          SIDEBAR_TASK_PRIMARY_NAV_ROW,
          SIDEBAR_TASK_PRIMARY_NAV_INACTIVE,
          createGroupDisabled && 'cursor-not-allowed opacity-40',
        )}
        data-testid="sidebar-im-create-group-button"
      >
        <span className={SIDEBAR_LIST_ICON_SLOT}>
          <UsersRound
            size={SIDEBAR_LIST_ICON_SIZE}
            strokeWidth={SIDEBAR_MENU_ICON_STROKE}
            aria-hidden
          />
        </span>
        <span className={SIDEBAR_TASK_PRIMARY_NAV_LABEL}>{createGroupLabel}</span>
      </button>

      <button
        type="button"
        onClick={onToggleContacts}
        aria-pressed={isContactsActive}
        aria-current={isContactsActive ? 'page' : undefined}
        aria-label={contactsLabel}
        title={contactsLabel}
        className={cn(
          SIDEBAR_TASK_PRIMARY_NAV_ROW,
          isContactsActive ? SIDEBAR_TASK_PRIMARY_NAV_ACTIVE : SIDEBAR_TASK_PRIMARY_NAV_INACTIVE,
        )}
        data-testid="sidebar-im-contacts-button"
      >
        <span className={SIDEBAR_LIST_ICON_SLOT}>
          <Contact
            size={SIDEBAR_LIST_ICON_SIZE}
            strokeWidth={SIDEBAR_MENU_ICON_STROKE}
            aria-hidden
          />
        </span>
        <span className={SIDEBAR_TASK_PRIMARY_NAV_LABEL}>{contactsLabel}</span>
      </button>
    </nav>
  )
}

SidebarIMPrimaryNav.displayName = 'SidebarIMPrimaryNav'
