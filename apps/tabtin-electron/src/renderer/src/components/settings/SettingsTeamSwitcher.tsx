/**
 * SettingsTeamSwitcher —— 设置侧栏的「当前团队」切换器。
 *
 * 设计原则：
 *  - 侧栏不再为每个团队展开一份完整设置；用一个下拉表示「当前正在配置哪个团队」
 *  - 切换团队 = 切换全局 `selectedOrganization`（与 Agent / 对话上下文联动），并刷新设置路由的 organizationId
 *  - 触发器视觉上像分组标题（uppercase + 小箭头），保持侧栏轻量感
 */

import React, { useCallback } from 'react'
import { ChevronDown, Check, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import type { Organization } from '@tabtin/app-shell'
import { useShallow } from 'zustand/react/shallow'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { SETTINGS_TEXT_MICRO } from './settingsUi'

interface SettingsTeamSwitcherProps {
  onCreateOrganization?: () => void
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export const SettingsTeamSwitcher: React.FC<SettingsTeamSwitcherProps> = ({
  onCreateOrganization,
  className,
  open,
  onOpenChange,
}) => {
  const { t } = useTranslation(['settings', 'sidebar'])
  const { organizations, selectedOrganization, selectOrganization } = useOrganizationStore(
    useShallow((s) => ({
      organizations: s.organizations,
      selectedOrganization: s.selectedOrganization,
      selectOrganization: s.selectOrganization,
    })),
  )
  const { activeRoute, setRoute } = useSettingsSpaceStore(
    useShallow((s) => ({ activeRoute: s.activeRoute, setRoute: s.setRoute })),
  )

  const handleSelect = useCallback(
    (wt: Organization) => {
      if (wt.id === selectedOrganization?.id) return
      void runWithAgentContextSwitchGuard('organization', () => {
        // 先同步切路由：右侧面板靠已加载的 organizations 列表即时切换，不耦合在
        // selectOrganization 的 detail/members 加载之后（否则触发器已变、面板滞后/错位，见 ）。
        if (activeRoute?.category === 'organization') {
          setRoute({ category: 'organization', section: activeRoute.section, organizationId: wt.id })
        }
        // 再维护全局上下文（selectedOrganization / members / role）；store 内部自带错误处理，无需 await。
        return selectOrganization(wt)
      })
    },
    [selectOrganization, selectedOrganization?.id, activeRoute, setRoute],
  )

  const currentName = selectedOrganization
    ? selectedOrganization.type === 'personal'
      ? t('teamSwitcher.personalLabel', { defaultValue: '个人账号' })
      : selectedOrganization.name
    : t('teamSwitcher.empty', { defaultValue: '暂无组织' })

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'group flex w-full items-center gap-1 px-3 py-1.5 text-left',
            SETTINGS_TEXT_MICRO,
            'font-medium uppercase tracking-wider',
            'text-muted-foreground/60 hover:text-foreground transition-colors',
            className,
          )}
          title={t('teamSwitcher.tooltip', { defaultValue: '切换当前组织' })}
          data-onboarding-target="new-user-organization-team-switcher"
        >
          <span className="truncate">{currentName}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60 group-hover:opacity-100" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="min-w-[220px]">
        <DropdownMenuLabel>
          {t('teamSwitcher.label', { defaultValue: '切换组织' })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {organizations.map((wt) => {
          const isCurrent = wt.id === selectedOrganization?.id
          const label = wt.type === 'personal'
            ? t('teamSwitcher.personalLabel', { defaultValue: '个人账号' })
            : wt.name
          return (
            <DropdownMenuItem
              key={wt.id}
              onSelect={() => void handleSelect(wt)}
              className="flex items-center gap-2"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {isCurrent ? <Check className="h-3.5 w-3.5" /> : null}
              </span>
              <span className="truncate flex-1">{label}</span>
            </DropdownMenuItem>
          )
        })}
        {onCreateOrganization ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => onCreateOrganization()}
              className="flex items-center gap-2"
              data-onboarding-target="new-user-organization-create-team"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span data-onboarding-target="new-user-organization-create-team-label">
                {t('newTeam', { ns: 'sidebar', defaultValue: '新建组织' })}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
