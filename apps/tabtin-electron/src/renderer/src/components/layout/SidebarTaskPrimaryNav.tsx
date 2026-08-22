/**
 * SidebarTaskPrimaryNav — 任务域侧栏顶栏（一排一个）。
 *
 * 新任务 / 技能库 / 自动化 / 导入数据同属任务域次级入口，不属于 ActivityRail 空间域导航。
 * 「导入数据」检测到可导入历史时显示指示灯；已导入档案挂在对应 Workspace 下「外部历史」子组。
 */

import React from 'react'
import { Activity, BookText, DownloadCloud, SquarePen, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { selectIsAuthenticated, useAuthStore } from '@stores/useAuthStore'
import {
  useExternalImportDetection,
} from '@components/onboarding/external-import/useExternalImportDetection'
import type { PrimaryNavId } from './primaryNavigation'
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

type TaskPrimaryNavTarget = Extract<
  PrimaryNavId,
  'new-task' | 'automation' | 'skills' | 'import-data'
>

/** 与全屏页 StandaloneModulePage 页眉同源（SkillPanel → BookText；TrackerPanel → Activity） */
const TASK_PRIMARY_NAV_ICONS: Record<TaskPrimaryNavTarget, LucideIcon> = {
  'new-task': SquarePen,
  skills: BookText,
  automation: Activity,
  'import-data': DownloadCloud,
}

const TASK_PRIMARY_NAV_ITEMS: Array<{
  id: TaskPrimaryNavTarget
  labelKey: string
  defaultLabel: string
  testId: string
}> = [
  {
    id: 'new-task',
    labelKey: 'sidebar:primaryNav.newTask',
    defaultLabel: '新任务',
    testId: 'sidebar-new-task-button',
  },
  {
    id: 'skills',
    labelKey: 'sidebar:primaryNav.skills',
    defaultLabel: '技能和连接器',
    testId: 'sidebar-task-module-link-skills',
  },
  {
    id: 'automation',
    labelKey: 'sidebar:primaryNav.automation',
    defaultLabel: '自动化',
    testId: 'sidebar-task-module-link-automation',
  },
  {
    id: 'import-data',
    labelKey: 'sidebar:primaryNav.importData',
    defaultLabel: '导入数据',
    testId: 'sidebar-import-data-button',
  },
]

interface SidebarTaskPrimaryNavProps {
  activePrimaryNavId: PrimaryNavId | null
  newTaskDisabled?: boolean
  onNavigate: (target: TaskPrimaryNavTarget) => void
}

export const SidebarTaskPrimaryNav: React.FC<SidebarTaskPrimaryNavProps> = ({
  activePrimaryNavId,
  newTaskDisabled = false,
  onNavigate,
}) => {
  const { t } = useTranslation(['sidebar'])
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const importDetection = useExternalImportDetection({ enabled: isAuthenticated })
  const showImportIndicator = importDetection.shouldShow

  return (
    <nav
      className={SIDEBAR_TASK_PRIMARY_NAV_SHELL}
      aria-label={t('sidebar:taskPrimaryNav.label', { defaultValue: '任务快捷入口' })}
      data-testid="sidebar-task-primary-nav"
    >
      {TASK_PRIMARY_NAV_ITEMS.map(({ id, labelKey, defaultLabel, testId }) => {
        const active = activePrimaryNavId === id
        const disabled = id === 'new-task' && newTaskDisabled
        const isImport = id === 'import-data'
        const label = t(labelKey, { defaultValue: defaultLabel })
        const Icon = TASK_PRIMARY_NAV_ICONS[id]
        const ariaLabel = isImport && showImportIndicator
          ? t('sidebar:primaryNav.importDataDetected', {
              defaultValue: '导入数据（检测到可导入的历史）',
            })
          : label

        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              if (isImport) {
                importDetection.markNavClicked()
              }
              onNavigate(id)
            }}
            disabled={disabled}
            aria-current={active ? 'page' : undefined}
            aria-label={ariaLabel}
            title={label}
            className={cn(
              SIDEBAR_TASK_PRIMARY_NAV_ROW,
              active ? SIDEBAR_TASK_PRIMARY_NAV_ACTIVE : SIDEBAR_TASK_PRIMARY_NAV_INACTIVE,
              disabled && 'cursor-not-allowed opacity-40',
            )}
            data-testid={testId}
          >
            <span className={SIDEBAR_LIST_ICON_SLOT}>
              <Icon
                size={SIDEBAR_LIST_ICON_SIZE}
                strokeWidth={SIDEBAR_MENU_ICON_STROKE}
                aria-hidden
              />
            </span>
            <span className={SIDEBAR_TASK_PRIMARY_NAV_LABEL}>{label}</span>
            {isImport && showImportIndicator ? (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-accent"
                aria-hidden
                data-testid="sidebar-import-data-indicator"
              />
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}

SidebarTaskPrimaryNav.displayName = 'SidebarTaskPrimaryNav'

/** @deprecated 使用 SidebarTaskPrimaryNav */
export const SidebarTaskModuleLinks = SidebarTaskPrimaryNav
