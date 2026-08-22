/**
 * SidebarMePanel —— 「我的」tab 的侧栏内容（新 IA）。
 *
 * 设计原则（参考 macOS Settings / Linear / Telegram macOS；窄栏对齐 Slack「上组织/下人」）：
 *  - 侧栏只承担「去哪儿」的职责（组织项在上 → 个人项 → 设备项）
 *  - 子项（如「账户 → 资料/密钥/API key」）收进主面板顶部 tab，由 URL 表达
 *  - 多团队场景：设置页只展示当前团队；团队切换统一收口到 ShellTopBar
 *
 * 高亮逻辑：当前 activeRoute.section 可能是叶子（如 'profile'），需通过
 * SECTION_PARENT_MAP / PROFILE_SECTION_PARENT_MAP / DEVICE_SECTION_PARENT_MAP 反查父组高亮。
 */

import React, { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { canManageOrganization as canManageOrganizationFn } from '@/hooks/useCanManageOrganization'
import { useEffectiveFeature } from '@/hooks/useEffectiveFeature'
import { ScrollArea } from '@components/ui'
import { cn } from '@utils/cn'
import { SETTINGS_SIDEBAR_GROUPS } from '@components/settings/settingsNavigation'
import type { SettingsSidebarItem } from '@components/settings/settingsNavigation'
import { prefetchSettingsPanel } from '@components/settings/settingsPanelPrefetch'
import {
  SECTION_PARENT_MAP,
  PROFILE_SECTION_PARENT_MAP,
  DEVICE_SECTION_PARENT_MAP,
} from '@components/settings/settingsGroupConfig'
import {
  SIDEBAR_GROUPS,
  SIDEBAR_SCROLL,
  SIDEBAR_SCROLLBAR_TYPE,
  SIDEBAR_LIST_ICON,
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_ICON_ACTIVE,
  SIDEBAR_ICON_INACTIVE,
  SIDEBAR_EMPTY_STATE,
  SIDEBAR_SUBSECTION_LABEL,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_SECTION_LIST,
} from './sidebarUi'
import { SidebarMenuItem } from './SidebarMenuItem'
import type {
  ProfileSettingsSection,
  OrganizationSettingsSection,
  DeviceSettingsSection,
} from '@/settings/settingsRoutes'

function resolveActiveProfileParent(section?: string): ProfileSettingsSection | undefined {
  if (!section) return undefined
  const parent = PROFILE_SECTION_PARENT_MAP[section as ProfileSettingsSection]
  return (parent ?? (section as ProfileSettingsSection))
}

function resolveActiveOrganizationParent(section?: string): OrganizationSettingsSection | undefined {
  if (!section) return undefined
  const parent = SECTION_PARENT_MAP[section as OrganizationSettingsSection]
  return (parent ?? (section as OrganizationSettingsSection))
}

function resolveActiveDeviceParent(section?: string): DeviceSettingsSection | undefined {
  if (!section) return undefined
  const parent = DEVICE_SECTION_PARENT_MAP[section as DeviceSettingsSection]
  return (parent ?? (section as DeviceSettingsSection))
}

export const SidebarMePanel: React.FC = React.memo(() => {
  const { t } = useTranslation('settings')
  const { activeRoute, setRoute } = useSettingsSpaceStore(
    useShallow((s) => ({
      activeRoute: s.activeRoute,
      setRoute: s.setRoute,
    })),
  )
  const { selectedOrganization, currentUserRole } = useOrganizationStore(
    useShallow((s) => ({ selectedOrganization: s.selectedOrganization, currentUserRole: s.currentUserRole })),
  )
  const user = useAuthStore((s) => s.user)
  const daemonControlAvailable = useEffectiveFeature('daemon_control', selectedOrganization?.id).enabled

  // owner-only 菜单过滤：与 SettingsSpace 同口径——currentUserRole 为准，
  // 切组织瞬间 role 尚未拉到时回退 owner_id 判定，避免 owner 侧菜单闪烁。
  const isSelectedOrganizationOwner = Boolean(
    selectedOrganization && user && selectedOrganization.owner_id === user.id,
  )
  const effectiveRole = currentUserRole ?? (isSelectedOrganizationOwner ? ('owner' as const) : null)
  const canManageSelectedOrganization = canManageOrganizationFn(effectiveRole)

  // 不要对 SETTINGS_SIDEBAR_GROUPS 做空依赖 useMemo：侧栏隐藏项变更后 HMR 会卡住旧列表。
  const profileGroup = SETTINGS_SIDEBAR_GROUPS.find((g) => g.category === 'profile')!
  const organizationGroup = SETTINGS_SIDEBAR_GROUPS.find((g) => g.category === 'organization')!
  const organizationItems = useMemo(
    () =>
      (organizationGroup.subgroups[0]?.items ?? []).filter(
        (item) => canManageSelectedOrganization || !(item.category === 'organization' && item.ownerOnly),
      ),
    [organizationGroup, canManageSelectedOrganization],
  )
  const deviceGroup = SETTINGS_SIDEBAR_GROUPS.find((g) => g.category === 'device')!

  const activeCategory = activeRoute?.category
  const activeProfileSection = resolveActiveProfileParent(
    activeCategory === 'profile' ? activeRoute?.section : undefined,
  )
  const activeOrganizationSection = resolveActiveOrganizationParent(
    activeCategory === 'organization' ? activeRoute?.section : undefined,
  )
  const activeDeviceSection = resolveActiveDeviceParent(
    activeCategory === 'device' ? activeRoute?.section : undefined,
  )
  const activeOrganizationId = activeRoute?.category === 'organization' ? activeRoute.organizationId : null

  const handleSelectProfile = useCallback(
    (section: ProfileSettingsSection) => {
      setRoute({ category: 'profile', section })
    },
    [setRoute],
  )

  const handleSelectOrganization = useCallback(
    (section: OrganizationSettingsSection) => {
      const wtId = selectedOrganization?.id
      if (!wtId) return
      setRoute({ category: 'organization', section, organizationId: wtId })
    },
    [setRoute, selectedOrganization],
  )

  const handleSelectDevice = useCallback(
    (section: DeviceSettingsSection) => {
      setRoute({ category: 'device', section })
    },
    [setRoute],
  )

  const selectedOrganizationLabel = selectedOrganization
    ? selectedOrganization.type === 'personal'
      ? t('teamSwitcher.personalLabel', { ns: 'settings', defaultValue: '个人账号' })
      : selectedOrganization.name
    : t('teamSwitcher.empty', { ns: 'settings', defaultValue: '暂无组织' })

  const handlePrefetchNavItem = useCallback((item: SettingsSidebarItem) => {
    prefetchSettingsPanel(item)
  }, [])

  const renderNavItem = (item: SettingsSidebarItem, isActive: boolean, onClick: () => void) => {
    const Icon = item.icon
    const onboardingTarget =
      item.category === 'organization' && item.section === 'team'
        ? 'new-user-organization-team-entry'
        : item.category === 'organization' && item.section === 'teamMembers'
          ? 'new-user-organization-members-entry'
        : undefined
    return (
      <SidebarMenuItem
        key={`${item.category}:${item.section}`}
        active={isActive}
        fullWidth
        onClick={onClick}
        onMouseEnter={() => handlePrefetchNavItem(item)}
        onFocus={() => handlePrefetchNavItem(item)}
        aria-current={isActive ? 'page' : undefined}
        data-onboarding-target={onboardingTarget}
        leading={(
          <span className={cn(SIDEBAR_LIST_ICON_SLOT, 'transition-colors', isActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE)}>
            <Icon className={SIDEBAR_LIST_ICON} size={SIDEBAR_LIST_ICON_SIZE} strokeWidth={SIDEBAR_MENU_ICON_STROKE} />
          </span>
        )}
        label={t(item.labelKey, { ns: 'settings' })}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea
        className={SIDEBAR_SCROLL}
        scrollBar="vertical"
        type={SIDEBAR_SCROLLBAR_TYPE}
      >
        <div className={SIDEBAR_GROUPS}>
          {/* ── 组织区在上（与 ActivityRail「上组织 / 下人」一致；组织切换仍走顶栏） ── */}
          <div>
            <div className={SIDEBAR_SECTION_HEADER} title={selectedOrganizationLabel}>
              <span className={SIDEBAR_SECTION_LABEL}>{selectedOrganizationLabel}</span>
            </div>
            {selectedOrganization ? (
              <div className={`mt-1 ${SIDEBAR_SECTION_LIST}`}>
                {organizationItems.map((item) => {
                  const sec = (item as { section: OrganizationSettingsSection }).section
                  const isActive =
                    activeCategory === 'organization' &&
                    activeOrganizationSection === sec &&
                    activeOrganizationId === selectedOrganization.id
                  return renderNavItem(item, isActive, () => handleSelectOrganization(sec))
                })}
              </div>
            ) : (
              <div className={cn(SIDEBAR_EMPTY_STATE, 'text-muted-foreground/60')}>
                {t('teamSwitcher.empty', { ns: 'settings' })}
              </div>
            )}
          </div>

          {/* ── 个人区（账户 / 凭据 / 开发者 / 偏好） ── */}
          <div>
            <div className={SIDEBAR_SECTION_HEADER}>
              <span className={SIDEBAR_SECTION_LABEL}>
                {t('categories.profile', { ns: 'settings' })}
              </span>
            </div>
            {profileGroup.subgroups.map((subgroup, idx) => (
              <div key={subgroup.labelKey ?? `__nolabel_${idx}`} className={idx === 0 ? 'mt-1' : 'mt-3'}>
                {subgroup.labelKey && (
                  <div className={SIDEBAR_SUBSECTION_LABEL}>
                    {t(subgroup.labelKey, { ns: 'settings' })}
                  </div>
                )}
                <div className={subgroup.labelKey ? `mt-0.5 ${SIDEBAR_SECTION_LIST}` : SIDEBAR_SECTION_LIST}>
                  {subgroup.items.filter(item => (
                    item.section !== 'devices' || daemonControlAvailable
                  )).map((item) => {
                    const isActive =
                      activeCategory === 'profile' &&
                      activeProfileSection === (item as { section: ProfileSettingsSection }).section
                    return renderNavItem(item, isActive, () =>
                      handleSelectProfile((item as { section: ProfileSettingsSection }).section),
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* ── 设备区（一级 category，与个人/团队并列） ── */}
          <div>
            <div className={SIDEBAR_SECTION_HEADER}>
              <span className={SIDEBAR_SECTION_LABEL}>{t('categories.device', { ns: 'settings' })}</span>
            </div>
            <div className={`mt-1 ${SIDEBAR_SECTION_LIST}`}>
              {deviceGroup.subgroups[0]?.items.map((item) => {
                const sec = (item as { section: DeviceSettingsSection }).section
                const isActive = activeCategory === 'device' && activeDeviceSection === sec
                return renderNavItem(item, isActive, () => handleSelectDevice(sec))
              })}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
})

SidebarMePanel.displayName = 'SidebarMePanel'
