/**
 * OrganizationProfileButton —— 用户头像 + 昵称 + 当前团队 + 团队切换下拉。
 *
 * 供私信独立窗口侧栏底部使用；主窗口 ActivityRail 为「上组织 / 下人」
 * （OrganizationAvatarRailButton / UserAvatarRailButton），组织切换文案在
 * ShellTopBar（TopBarOrganizationSwitcher）。
 */

import React, { useCallback, useState } from 'react'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import { CreateOrganizationDialog } from '@components/organization/CreateOrganizationDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  UserAvatar,
} from '@components/ui'
import type { Organization } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { RailIconTooltip } from './activityRailTooltip'
import {
  ACTIVITY_RAIL_ITEM,
  ACTIVITY_RAIL_ITEM_ACTIVE,
  ACTIVITY_RAIL_ITEM_INACTIVE,
} from './sidebarUi'

/**
 * 窄栏身份入口的固定锚点：人 → 个人资料，组织 → 组织资料。
 * 不用 lastRouteByCategory，避免上次停在「外观显示」等页时点头像落到错位。
 */
function openSettingsCategoryAnchor(category: 'profile' | 'organization') {
  if (category === 'profile') {
    useSettingsSpaceStore.getState().openSettings({ category: 'profile', section: 'account' })
    return
  }
  useSettingsSpaceStore.getState().openSettings({ category: 'organization', section: 'team' })
}

interface OrganizationProfileButtonProps {
  className?: string
  dropdownSide?: 'top' | 'bottom'
  dropdownAlign?: 'start' | 'center' | 'end'
  /** 隐藏「新建团队」入口（如独立私信窗口里不提供建团队） */
  hideCreateOrganization?: boolean
  compact?: boolean
}

/**
 * 当前用户展示名 + 当前组织标签的统一推导。
 * 供 OrganizationProfileButton（私信独立窗口）、TopBarOrganizationSwitcher
 * 与 UserAvatarRailButton 共用，保证各处身份文案一致。
 */
export function useIdentityLabels(): {
  user: ReturnType<typeof useAuthStore.getState>['user']
  displayName: string
  organizationLabel: string
} {
  const { t } = useTranslation(['sidebar', 'settings'])
  const user = useAuthStore((state) => state.user)
  const selectedOrganization = useOrganizationStore((s) => s.selectedOrganization)
  const displayName = user?.nickname || user?.username || ''
  const organizationLabel = selectedOrganization
    ? selectedOrganization.type === 'personal'
      ? t('teamSwitcher.personalLabel', { ns: 'settings', defaultValue: '个人账号' })
      : selectedOrganization.name
    : t('teamSwitcher.empty', { ns: 'settings', defaultValue: '暂无组织' })
  return { user, displayName, organizationLabel }
}

/**
 * 组织切换下拉的菜单项（标题 + 组织列表 + 新建组织）。
 * 供 OrganizationProfileButton 与 TopBarOrganizationSwitcher 弹层共用；「新建组织」Dialog
 * 由调用方持有（下拉选中后即关闭，Dialog 必须挂在 DropdownMenu 外层）。
 */
export const OrganizationSwitcherMenuItems: React.FC<{
  hideCreateOrganization?: boolean
  onCreateOrganization: () => void
}> = ({ hideCreateOrganization = false, onCreateOrganization }) => {
  const { t } = useTranslation(['sidebar', 'settings'])
  const { organizations, selectedOrganization, selectOrganization } = useOrganizationStore(
    useShallow((s) => ({
      organizations: s.organizations,
      selectedOrganization: s.selectedOrganization,
      selectOrganization: s.selectOrganization,
    })),
  )

  const handleSelectOrganization = useCallback((organization: Organization) => {
    if (organization.id === selectedOrganization?.id) return
    void runWithAgentContextSwitchGuard('organization', () => selectOrganization(organization))
  }, [selectOrganization, selectedOrganization?.id])

  return (
    <>
      <DropdownMenuLabel>
        {t('teamSwitcher.label', { ns: 'settings', defaultValue: '切换组织' })}
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      {organizations.map((organization) => {
        const isCurrent = organization.id === selectedOrganization?.id
        const label = organization.type === 'personal'
          ? t('teamSwitcher.personalLabel', { ns: 'settings', defaultValue: '个人账号' })
          : organization.name
        return (
          <DropdownMenuItem
            key={organization.id}
            onSelect={() => handleSelectOrganization(organization)}
            className="flex items-center gap-2"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {isCurrent ? <Check className="h-3.5 w-3.5" /> : null}
            </span>
            <span className="truncate flex-1">{label}</span>
          </DropdownMenuItem>
        )
      })}
      {!hideCreateOrganization && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={onCreateOrganization}
            className="flex items-center gap-2"
            data-onboarding-target="new-user-organization-create-team"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span data-onboarding-target="new-user-organization-create-team-label">
              {t('newTeam', { ns: 'sidebar', defaultValue: '新建组织' })}
            </span>
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

export const OrganizationProfileButton: React.FC<OrganizationProfileButtonProps> = ({
  className,
  dropdownSide = 'top',
  dropdownAlign = 'start',
  hideCreateOrganization = false,
  compact = false,
}) => {
  const { t } = useTranslation(['sidebar', 'settings'])
  const { user, displayName, organizationLabel: selectedOrganizationLabel } = useIdentityLabels()
  const [isCreateOrganizationOpen, setIsCreateOrganizationOpen] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'group flex min-w-0 items-center rounded-interactive text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/30 dark:hover:bg-foreground/[0.05]',
              compact ? 'gap-2.5 px-2 py-1.5' : 'gap-3 px-2.5 py-2',
              className,
            )}
            aria-label={t('teamSwitcher.tooltip', { ns: 'settings', defaultValue: '切换当前组织' })}
            title={t('teamSwitcher.tooltip', { ns: 'settings', defaultValue: '切换当前组织' })}
            data-onboarding-target="new-user-organization-me-entry"
          >
            <UserAvatar
              name={displayName || '?'}
              seed={user?.id}
              avatarUrl={user?.avatar}
              size={compact ? 40 : 48}
              className="border border-border/30"
            />
            <div className={cn(
              'min-w-0 flex-1 flex flex-col justify-center py-0.5',
              compact ? 'gap-0.5' : 'gap-1',
            )}>
              <div className="truncate text-body font-medium text-foreground">
                {displayName || t('untitled', { defaultValue: '未命名用户' })}
              </div>
              <div className="truncate text-caption text-muted-foreground/60">{selectedOrganizationLabel}</div>
            </div>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={dropdownAlign} side={dropdownSide} sideOffset={8} className="min-w-[220px]">
          <OrganizationSwitcherMenuItems
            hideCreateOrganization={hideCreateOrganization}
            onCreateOrganization={() => setIsCreateOrganizationOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateOrganizationDialog
        isOpen={isCreateOrganizationOpen}
        onClose={() => setIsCreateOrganizationOpen(false)}
      />
    </>
  )
}

OrganizationProfileButton.displayName = 'OrganizationProfileButton'

/** ShellTopBar 左侧：当前组织切换按钮（折叠入口在其左侧）。 */
export const TopBarOrganizationSwitcher: React.FC = () => {
  const { t } = useTranslation(['sidebar', 'settings'])
  const { displayName, organizationLabel } = useIdentityLabels()
  const [isCreateOrganizationOpen, setIsCreateOrganizationOpen] = useState(false)
  const tooltip = t('teamSwitcher.tooltip', { ns: 'settings', defaultValue: '切换当前组织' })

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'no-drag group inline-flex h-8 min-w-0 max-w-[min(100%,240px)] items-center gap-1 rounded-interactive px-2 text-left transition-colors',
              'bg-foreground/[0.03] hover:bg-foreground/[0.06] dark:bg-foreground/[0.05] dark:hover:bg-foreground/[0.08]',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/30',
            )}
            aria-label={tooltip}
            title={`${tooltip} · ${displayName}`}
            data-onboarding-target="new-user-organization-team-switcher"
            data-testid="shell-top-bar-organization-switcher"
          >
            <span className="truncate text-body font-medium leading-none text-foreground">
              {organizationLabel}
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="min-w-[220px]">
          <OrganizationSwitcherMenuItems
            onCreateOrganization={() => setIsCreateOrganizationOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateOrganizationDialog
        isOpen={isCreateOrganizationOpen}
        onClose={() => setIsCreateOrganizationOpen(false)}
      />
    </>
  )
}

TopBarOrganizationSwitcher.displayName = 'TopBarOrganizationSwitcher'

/** ActivityRail 顶部：当前组织头像（复用 UserAvatar 色块/首字算法），点击切到组织设置锚点。 */
export const OrganizationAvatarRailButton: React.FC<{ active?: boolean }> = ({
  active = false,
}) => {
  const { t } = useTranslation(['sidebar', 'settings'])
  const { organizationLabel } = useIdentityLabels()
  const selectedOrganization = useOrganizationStore((s) => s.selectedOrganization)
  const orgName = selectedOrganization
    ? (selectedOrganization.type === 'personal'
      ? t('teamSwitcher.personalLabel', { ns: 'settings', defaultValue: '个人账号' })
      : selectedOrganization.name)
    : organizationLabel
  const tooltipLabel = t('rail.organizationProfile', {
    ns: 'sidebar',
    defaultValue: '组织资料',
  })
  const ariaLabel = `${tooltipLabel} · ${orgName}`

  const handleOpenOrganizationSettings = useCallback(() => {
    openSettingsCategoryAnchor('organization')
  }, [])

  return (
    <RailIconTooltip label={`${tooltipLabel} · ${orgName}`}>
      <button
        type="button"
        className={cn(
          ACTIVITY_RAIL_ITEM,
          active ? ACTIVITY_RAIL_ITEM_ACTIVE : ACTIVITY_RAIL_ITEM_INACTIVE,
          'mb-2',
          active && 'ring-2 ring-accent/40',
        )}
        aria-label={ariaLabel}
        aria-current={active ? 'page' : undefined}
        data-onboarding-target="new-user-organization-team-entry"
        data-testid="activity-rail-organization-avatar"
        onClick={handleOpenOrganizationSettings}
      >
        <UserAvatar
          name={orgName || '?'}
          seed={selectedOrganization?.id}
          avatarUrl={selectedOrganization?.settings?.logo_url}
          size={32}
          className="border border-border/30 !rounded-[8px]"
        />
      </button>
    </RailIconTooltip>
  )
}

OrganizationAvatarRailButton.displayName = 'OrganizationAvatarRailButton'

/** ActivityRail 底部：用户头像，点击切到个人设置锚点。 */
export const UserAvatarRailButton: React.FC<{ active?: boolean }> = ({
  active = false,
}) => {
  const { t } = useTranslation(['sidebar'])
  const { user, displayName } = useIdentityLabels()
  const tooltipLabel = displayName || t('untitled', { ns: 'sidebar', defaultValue: '未命名用户' })
  const ariaLabel = t('rail.profileSettings', {
    ns: 'sidebar',
    defaultValue: '个人资料',
  })

  const handleOpenProfileSettings = useCallback(() => {
    openSettingsCategoryAnchor('profile')
  }, [])

  return (
    <RailIconTooltip label={tooltipLabel}>
      <button
        type="button"
        className={cn(
          ACTIVITY_RAIL_ITEM,
          active ? ACTIVITY_RAIL_ITEM_ACTIVE : ACTIVITY_RAIL_ITEM_INACTIVE,
          active && 'ring-2 ring-accent/40',
        )}
        aria-label={ariaLabel}
        aria-current={active ? 'page' : undefined}
        data-onboarding-target="new-user-organization-me-entry"
        data-testid="activity-rail-user-avatar"
        onClick={handleOpenProfileSettings}
      >
        <UserAvatar
          name={displayName || '?'}
          seed={user?.id}
          avatarUrl={user?.avatar}
          size={32}
          className="border border-border/30"
        />
      </button>
    </RailIconTooltip>
  )
}

UserAvatarRailButton.displayName = 'UserAvatarRailButton'
