/**
 * 组级设置组合面板（个人侧 + 团队侧）
 *
 * 设计原则（新 IA）：
 *  - 侧栏只展示主干（账户 / 偏好 / 团队 / 模型与 AI 等）
 *  - 子项收进 composite 内部的横向 tab，由 URL 表达当前子项
 *  - 切换 tab → setRoute({ section: '<child>' })，深链接刷新可恢复
 */

import React, { lazy, Suspense, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Building2, HardDrive, Sparkles, Users } from 'lucide-react'
import type { Organization, OrganizationRole } from '@tabtin/app-shell'
import { SettingsSkeleton } from '../SettingsSkeleton'
import { SettingsCompositeContainer, type SettingsCompositeTab } from '../SettingsCompositeContainer'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSection } from '../SettingsSection'
import { SettingsSectionHeader } from '../SettingsSectionHeader'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useShallow } from 'zustand/react/shallow'
import type {
  ProfileSettingsSection,
  OrganizationSettingsSection,
  DeviceSettingsSection,
} from '@/settings/settingsRoutes'
import { SPACE_TRASH_UI_ENABLED } from '@/utils/featureFlags'
// ── Lazy imports（团队侧） ──

const OrganizationSettingsPanel = lazy(() =>
  import('./OrganizationSettingsPanel').then((m) => ({ default: m.OrganizationSettingsPanel })),
)
// 「通知规则」尚未做好、配置无实际效果，已从团队资料移除，仅保留团队资料本身。
const OrganizationModelSettings = lazy(() =>
  import('@components/organization/OrganizationModelSettings').then((m) => ({ default: m.OrganizationModelSettings })),
)
const AppMarketplacePanel = lazy(() =>
  import('./AppMarketplacePanel').then((m) => ({ default: m.AppMarketplacePanel })),
)
const LocalPluginMarketplacePanel = lazy(() =>
  import('./LocalPluginMarketplacePanel').then((m) => ({ default: m.LocalPluginMarketplacePanel })),
)
const OrganizationMembersPanel = lazy(() =>
  import('./OrganizationMembersPanel').then((m) => ({ default: m.OrganizationMembersPanel })),
)
const OrganizationMembershipPanel = lazy(() =>
  import('./OrganizationMembershipPanel').then((m) => ({ default: m.OrganizationMembershipPanel })),
)
const OrganizationWalletPanel = lazy(() =>
  import('./OrganizationWalletPanel').then((m) => ({ default: m.OrganizationWalletPanel })),
)
const OrganizationUsageDashboard = lazy(() =>
  import('./OrganizationUsageDashboard').then((m) => ({ default: m.OrganizationUsageDashboard })),
)
const OrganizationBillingPanel = lazy(() =>
  import('./OrganizationBillingPanel').then((m) => ({ default: m.OrganizationBillingPanel })),
)
const OrganizationServiceCatalogPanel = lazy(() =>
  import('./OrganizationServiceCatalogPanel').then((m) => ({ default: m.OrganizationServiceCatalogPanel })),
)
const OrganizationTrashedSpacesPanel = lazy(() =>
  import('./OrganizationTrashedSpacesPanel').then((m) => ({ default: m.OrganizationTrashedSpacesPanel })),
)
const OrganizationResourceTrashPanel = lazy(() =>
  import('./OrganizationResourceTrashPanel').then((m) => ({ default: m.OrganizationResourceTrashPanel })),
)
// ── Lazy imports（个人侧） ──
// 打平后个人设置一级入口（个人资料 / 系统通知 / 外观显示 / 语音习惯）由 SettingsSpace
// 直接渲染单面板，不再走组合面板；此处只保留 AI 设置页堆叠所需的两块内容。

const ResourceOpenPreferencesPanel = lazy(() =>
  import('./ResourceOpenPreferencesPanel').then((m) => ({ default: m.ResourceOpenPreferencesPanel })),
)
const PersonalRulesPanel = lazy(() =>
  import('./PersonalRulesPanel').then((m) => ({ default: m.PersonalRulesPanel })),
)
// 「系统权限」页堆叠所需：系统通知分类（embedded）+ OS 系统权限（embedded）。
const NotificationPreferencesPanel = lazy(() =>
  import('./NotificationPreferencesPanel').then((m) => ({ default: m.NotificationPreferencesPanel })),
)
const StorageManagerPanel = lazy(() =>
  import('./StorageManagerPanel').then((m) => ({ default: m.StorageManagerPanel })),
)
const PerformancePanel = lazy(() =>
  import('./PerformancePanel').then((m) => ({ default: m.PerformancePanel })),
)
const CredentialsBrowserPanel = lazy(() =>
  import('./CredentialsBrowserPanel').then((m) => ({ default: m.CredentialsBrowserPanel })),
)
const CredentialsAiPanel = lazy(() =>
  import('./CredentialsAiPanel').then((m) => ({ default: m.CredentialsAiPanel })),
)
const CredentialsAppsPanel = lazy(() =>
  import('./CredentialsAppsPanel').then((m) => ({ default: m.CredentialsAppsPanel })),
)
// 「设备」组 tab：授权（OS 系统权限）与关于（更新）从原侧栏一级单 panel 迁入。
const AuthorizationSystemPanel = lazy(() =>
  import('./AuthorizationSystemPanel').then((m) => ({ default: m.AuthorizationSystemPanel })),
)
const UpdatePanel = lazy(() => import('./UpdatePanel').then((m) => ({ default: m.UpdatePanel })))
// SSH 远程服务器管理：IA Phase 1·1B 从 Agent 资料页迁入「设备」组，按当前 Electron 设备管理。
const SSHPanel = lazy(() =>
  import('@components/space-settings/SSHPanel').then((m) => ({ default: m.SSHPanel })),
)
// 本机 MCP 连接管理：IA Phase 1·1D 从 Agent 资料页迁入「设备」组（数据仍走 localMcp，未接后端）。
const McpPanel = lazy(() =>
  import('@components/space-settings/McpPanel').then((m) => ({ default: m.McpPanel })),
)

// ── Shared helpers ──

const wrap = (node: React.ReactNode): React.ReactNode => (
  <Suspense fallback={<SettingsSkeleton />}>{node}</Suspense>
)

function useProfileTabRouter(): (section: ProfileSettingsSection) => void {
  const setRoute = useSettingsSpaceStore(useShallow((s) => s.setRoute))
  return useCallback(
    (section: ProfileSettingsSection) => setRoute({ category: 'profile', section }),
    [setRoute],
  )
}

function useOrganizationTabRouter(organizationId: string): (section: OrganizationSettingsSection) => void {
  const setRoute = useSettingsSpaceStore(useShallow((s) => s.setRoute))
  return useCallback(
    (section: OrganizationSettingsSection) =>
      setRoute({ category: 'organization', section, organizationId }),
    [setRoute, organizationId],
  )
}

function useDeviceTabRouter(): (section: DeviceSettingsSection) => void {
  const setRoute = useSettingsSpaceStore(useShallow((s) => s.setRoute))
  return useCallback(
    (section: DeviceSettingsSection) => setRoute({ category: 'device', section }),
    [setRoute],
  )
}

// ── 个人侧 ──

interface ProfileCompositeProps {
  activeSubsection?: ProfileSettingsSection | null
}

export const CredentialsComposite: React.FC<ProfileCompositeProps> = ({ activeSubsection }) => {
  const { t } = useTranslation('settings')
  const onSelect = useProfileTabRouter()
  // 浏览器登录态已迁入「设备」组（DeviceComposite），此处仅剩 AI / 应用两 tab。
  const tabs: SettingsCompositeTab[] = [
    {
      value: 'credentials-ai',
      label: t('sections.credentialsAi'),
      render: () => wrap(<CredentialsAiPanel />),
    },
    {
      value: 'credentials-apps',
      label: t('sections.credentialsApps'),
      render: () => wrap(<CredentialsAppsPanel />),
    },
  ]
  return (
    <SettingsCompositeContainer
      tabs={tabs}
      activeSubsection={activeSubsection ?? undefined}
      onSelectSubsection={(v) => onSelect(v as ProfileSettingsSection)}
    />
  )
}

// AuthorizationComposite 已删除——授权改为单 panel，由 SettingsSpace 直接渲染。
// PreferencesComposite 已删除——系统通知 / 外观显示 / 语音习惯 打平为一级入口，由 SettingsSpace 直接渲染单面板。

/**
 * AI 设置页：IA 打平后取代原「我的 AI」二级 tab，单页纵向堆叠两块内容——
 * 「通用规则」（对所有 Agent 生效的口吻/规则）在上，「默认打开方式」（Agent 产物默认载体）在下。
 */
export const MyAIComposite: React.FC<ProfileCompositeProps> = () => {
  const { t } = useTranslation('settings')
  return (
    <SettingsPanelLayout>
      <SettingsSectionHeader section="myAI" subtitle={t('groupOverview.myAIGroupDesc')} />
      <SettingsSection
        title={t('sections.personalRules')}
        subtitle={(
          <>
            <p>{t('groupOverview.personalRulesDesc')}</p>
            <p className="mt-1.5">{t('personalRules.hint')}</p>
          </>
        )}
        subtitleAsTooltip
      >
        {wrap(<PersonalRulesPanel embedded />)}
      </SettingsSection>
      <SettingsSection
        title={t('sections.resourceOpenPreferences')}
        subtitle={(
          <>
            <p>{t('resourceOpenPreferences.behaviorHint')}</p>
            <p className="mt-1.5">{t('resourceOpenPreferences.fallbackHint')}</p>
          </>
        )}
        subtitleAsTooltip
      >
        {wrap(<ResourceOpenPreferencesPanel embedded />)}
      </SettingsSection>
    </SettingsPanelLayout>
  )
}

/**
 * 系统权限页（个人设置 `notifications` 入口）：单页纵向堆叠两块——
 * 「通知偏好」（要不要按分类提醒，客户端唯一能真实控制的通知维度）在上，
 * 「其他权限」（macOS / Windows 给 TabTin 的 OS 系统权限，含桌面通知授权）在下。
 *
 * 文案刻意区分：上半用「通知偏好」，OS 权限行用「桌面通知」，避免同页出现两个「系统通知」
 * 。
 */
export const SystemPermissionsComposite: React.FC<ProfileCompositeProps> = () => {
  const { t } = useTranslation('settings')
  return (
    <SettingsPanelLayout>
      <SettingsSectionHeader section="notifications" />
      <SettingsSection title={t('sections.notifications')}>
        {wrap(<NotificationPreferencesPanel embedded />)}
      </SettingsSection>
      <SettingsSection title={t('notifications.otherPermsSection')}>
        {wrap(<AuthorizationSystemPanel embedded />)}
      </SettingsSection>
    </SettingsPanelLayout>
  )
}

// 「设备」组：单层 7-tab 组合（授权 / 浏览器 / 本地存储 / 性能 / 关于 / MCP / SSH），
// 全部 device-local。tab 顺序须与 settingsGroupConfig.ts 的 deviceGroup.items 一致。
interface DeviceCompositeProps {
  activeSubsection?: DeviceSettingsSection | null
}

// 「关于 TabTin」页（设备侧 `permissionUpdate` 入口）：授权已迁到个人设置「系统权限」，
// 这里只剩版本信息与软件更新，单面板无 tab。
export const PermissionUpdateComposite: React.FC<DeviceCompositeProps> = () => {
  return <UpdatePanel />
}

export const BrowserSessionComposite: React.FC<DeviceCompositeProps> = ({ activeSubsection }) => {
  const { t } = useTranslation('settings')
  const onSelect = useDeviceTabRouter()
  const tabs: SettingsCompositeTab[] = [
    {
      value: 'credentials-browser',
      label: t('sections.credentialsBrowser'),
      render: () => wrap(<CredentialsBrowserPanel />),
    },
  ]
  return (
    <SettingsCompositeContainer
      tabs={tabs}
      activeSubsection={activeSubsection ?? undefined}
      onSelectSubsection={(v) => onSelect(v as DeviceSettingsSection)}
    />
  )
}

export const LocalMaintenanceComposite: React.FC<DeviceCompositeProps> = ({ activeSubsection }) => {
  const { t } = useTranslation('settings')
  const onSelect = useDeviceTabRouter()
  const tabs: SettingsCompositeTab[] = [
    {
      value: 'storageManager',
      label: t('sections.storageManager'),
      render: () => wrap(<StorageManagerPanel />),
    },
    {
      value: 'performance',
      label: t('sections.performance'),
      render: () => wrap(<PerformancePanel />),
    },
  ]
  return (
    <SettingsCompositeContainer
      tabs={tabs}
      activeSubsection={activeSubsection ?? undefined}
      onSelectSubsection={(v) => onSelect(v as DeviceSettingsSection)}
    />
  )
}

// 「本机维护」拆分后的两个一级入口：存储管理 / 性能监控，各自单页无 tab。
// 两个面板都自带 SettingsPanelLayout + SettingsPanelHeader，这里只做 Suspense 包裹。
export const StorageManagerComposite: React.FC<DeviceCompositeProps> = () => wrap(<StorageManagerPanel />)

export const PerformanceComposite: React.FC<DeviceCompositeProps> = () => wrap(<PerformancePanel />)

// 「MCP 连接」一级入口：SSH 服务器尚未完善，已从页面移除，这里只渲染 MCP 单面板（无 tab 条）。
export const AdvancedConnectionsComposite: React.FC<DeviceCompositeProps> = () => wrap(<McpPanel />)

export const DeviceComposite: React.FC<DeviceCompositeProps> = ({ activeSubsection }) => {
  const { t } = useTranslation('settings')
  const onSelect = useDeviceTabRouter()
  const tabs: SettingsCompositeTab[] = [
    {
      value: 'authorization',
      label: t('sections.authorizationGroup'),
      render: () => wrap(<AuthorizationSystemPanel />),
    },
    {
      value: 'credentials-browser',
      label: t('sections.credentialsBrowser'),
      render: () => wrap(<CredentialsBrowserPanel />),
    },
    {
      value: 'storageManager',
      label: t('sections.storageManager'),
      render: () => wrap(<StorageManagerPanel />),
    },
    {
      value: 'performance',
      label: t('sections.performance'),
      render: () => wrap(<PerformancePanel />),
    },
    {
      value: 'about',
      label: t('sections.about'),
      render: () => wrap(<UpdatePanel />),
    },
    {
      value: 'mcp',
      label: t('sections.mcp'),
      render: () => wrap(<McpPanel />),
    },
    {
      value: 'ssh',
      label: t('sections.ssh'),
      render: () => wrap(<SSHPanel />),
    },
  ]
  return (
    <SettingsCompositeContainer
      tabs={tabs}
      activeSubsection={activeSubsection ?? undefined}
      onSelectSubsection={(v) => onSelect(v as DeviceSettingsSection)}
    />
  )
}

// ── 团队侧 ──

interface OrganizationCompositeProps {
  organization: Organization
  canManageOrganization: boolean
  currentUserRole?: OrganizationRole | null
  activeSubsection?: OrganizationSettingsSection | null
}

// 团队资料：单页依次展示「团队资料」+「会员与点券」+「危险操作」，不再有二级 tab。
// 会员与点券从「订阅与账单」移入此处，作为团队资料下的一个分区。
export const TeamComposite: React.FC<OrganizationCompositeProps> = ({ organization, canManageOrganization }) => {
  const { t } = useTranslation('settings')
  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Building2 className="h-4 w-4" />}
        title={t('sections.teamGroup')}
        subtitle={organization.name}
      />
      {wrap(
        <OrganizationSettingsPanel organization={organization} embedded>
          <OrganizationMembershipPanel organization={organization} canManageOrganization={canManageOrganization} embedded />
        </OrganizationSettingsPanel>,
      )}
    </SettingsPanelLayout>
  )
}

// 原「AI 与模型」组合已拆成两个独立一级入口，各自单页、无 tab：
//  - LlmComposite（模型配置）：默认模型 / 渠道 / 模型管理
//  - ServicesComposite（AI 成本）：AI 可用状态、自动补充与余额预警
export const LlmComposite: React.FC<OrganizationCompositeProps> = ({ organization, canManageOrganization }) => {
  const { t } = useTranslation('settings')
  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Sparkles className="h-4 w-4" />}
        title={t('sections.organizationLlm')}
        subtitle={t('groupOverview.llmDesc')}
      />
      {wrap(<OrganizationModelSettings organizationId={organization.id} canManageOrganization={canManageOrganization} />)}
    </SettingsPanelLayout>
  )
}

export const ServicesComposite: React.FC<OrganizationCompositeProps> = ({ organization, canManageOrganization }) => (
  wrap(<OrganizationServiceCatalogPanel organization={organization} canManageOrganization={canManageOrganization} />)
)

export const AppsIntegrationComposite: React.FC<OrganizationCompositeProps> = ({
  organization,
  canManageOrganization,
  activeSubsection,
}) => {
  const { t } = useTranslation('settings')
  const onSelect = useOrganizationTabRouter(organization.id)
  // 统一应用市场：原 apps（应用市场）+ extensions（插件市场）合并为一个「应用市场」tab
  // （内部分协作 / 本机分区）。旧深链 appCatalog / extensions / appsIntegration 一律归到 apps tab。
  const activeValue =
    activeSubsection === 'appCatalog' ||
    activeSubsection === 'extensions' ||
    activeSubsection === 'appsIntegration'
      ? 'apps'
      : activeSubsection
  const tabs: SettingsCompositeTab[] = [
    {
      value: 'apps',
      label: t('sections.organizationApps'),
      render: () =>
        wrap(
          <AppMarketplacePanel
            organization={organization}
            canManageOrganization={canManageOrganization}
            initialTab={activeSubsection === 'extensions' ? 'local' : 'collaborative'}
          />,
        ),
    },
    {
      value: 'installedExtensions',
      label: t('pluginMarketplace.installedTab'),
      render: () =>
        wrap(
          <LocalPluginMarketplacePanel
            organization={organization}
            canManageOrganization={canManageOrganization}
            view="installed"
          />,
        ),
    },
  ]
  return (
    <SettingsCompositeContainer
      tabs={tabs}
      activeSubsection={activeValue ?? undefined}
      onSelectSubsection={(v) => onSelect(v as OrganizationSettingsSection)}
    />
  )
}

// 成员与额度：单一成员列表——每行同时承载角色与本月用量/额度，行操作含改角色 / 编辑额度 / 移除，
// 顶部配默认预算策略卡片。不再拆成两份列表、两个 tab（角色权限矩阵已于  移除）。
export const TeamMembersComposite: React.FC<OrganizationCompositeProps> = ({
  organization,
  currentUserRole,
}) => {
  const { t } = useTranslation('settings')
  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Users className="h-4 w-4" />}
        title={t('sections.teamMembers')}
        subtitle={organization.name}
      />
      {wrap(<OrganizationMembersPanel organization={organization} currentUserRole={currentUserRole} embedded />)}
    </SettingsPanelLayout>
  )
}

// 权益组现仅含「当前套餐 / 权益 / 点券 / 团队余额」单面板；流水并入「用量中心」。
export const MembershipWalletComposite: React.FC<OrganizationCompositeProps> = ({
  organization,
  canManageOrganization,
}) => wrap(<OrganizationMembershipPanel organization={organization} canManageOrganization={canManageOrganization} />)

export const UsageBillingComposite: React.FC<OrganizationCompositeProps> = ({
  organization,
  canManageOrganization,
  activeSubsection,
}) => {
  const { t } = useTranslation('settings')
  const onSelect = useOrganizationTabRouter(organization.id)
  const activeValue = (() => {
    if (activeSubsection === 'wallet') return 'usage'
    // 会员与点券已移入「团队资料」页；旧深链落到用量中心。
    if (activeSubsection === 'membership' || activeSubsection === 'membershipWallet') return 'usage'
    if (activeSubsection === 'storage' || activeSubsection === 'storageFiles') return 'billing'
    if (activeSubsection === 'services') return 'pricing'
    return activeSubsection
  })()
  const tabs: SettingsCompositeTab[] = [
    {
      value: 'usage',
      label: t('sections.organizationUsageCenter'),
      render: () =>
        wrap(
          <SettingsPanelLayout>
            <SettingsPanelHeader
              icon={<BarChart3 className="h-4 w-4" />}
              title={t('sections.organizationUsageCenter')}
              subtitle={t('groupOverview.usageDesc')}
            />
            <div className="space-y-6">
              <OrganizationUsageDashboard organization={organization} embedded />
              <OrganizationWalletPanel organization={organization} embedded />
            </div>
          </SettingsPanelLayout>,
        ),
    },
    {
      value: 'billing',
      label: t('sections.organizationBilling'),
      render: () =>
        wrap(<OrganizationBillingPanel organization={organization} canManageOrganization={canManageOrganization} />),
    },
    {
      value: 'pricing',
      label: t('sections.organizationPricingRulesTab'),
      render: () =>
        wrap(
          <OrganizationServiceCatalogPanel
            organization={organization}
            canManageOrganization={canManageOrganization}
            readOnly
          />,
        ),
    },
  ]
  return (
    <SettingsCompositeContainer
      tabs={tabs}
      activeSubsection={activeValue ?? undefined}
      onSelectSubsection={(v) => onSelect(v as OrganizationSettingsSection)}
    />
  )
}

export const SystemCenterComposite: React.FC<OrganizationCompositeProps> = ({
  organization,
  canManageOrganization,
  activeSubsection,
}) => {
  const { t } = useTranslation('settings')
  const onSelect = useOrganizationTabRouter(organization.id)
  const tabs: SettingsCompositeTab[] = [
    ...(SPACE_TRASH_UI_ENABLED
      ? [
          {
            value: 'trashedSpaces',
            label: t('sections.organizationTrashedSpaces'),
            render: () =>
              wrap(
                <OrganizationTrashedSpacesPanel
                  organization={organization}
                  canManageOrganization={canManageOrganization}
                  embedded
                />,
              ),
          } satisfies SettingsCompositeTab,
        ]
      : []),
    {
      value: 'trashedResources',
      label: t('sections.organizationTrashedResources'),
      render: () =>
        wrap(
          <OrganizationResourceTrashPanel
            organization={organization}
            canManageOrganization={canManageOrganization}
            embedded
          />,
        ),
    },
  ]
  // 旧深链 / 刷新落到已隐藏的工作空间回收站时，落到资源回收站
  const resolvedSubsection =
    !SPACE_TRASH_UI_ENABLED && activeSubsection === 'trashedSpaces'
      ? 'trashedResources'
      : activeSubsection
  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<HardDrive className="h-6 w-6" />}
        title={t('sections.systemCenter')}
        subtitle={t(
          SPACE_TRASH_UI_ENABLED
            ? 'groupOverview.systemCenterPageDesc'
            : 'groupOverview.systemCenterPageDescResourcesOnly',
        )}
      />
      <SettingsCompositeContainer
        tabBarPlacement="standalone"
        tabs={tabs}
        activeSubsection={resolvedSubsection ?? undefined}
        onSelectSubsection={(v) => onSelect(v as OrganizationSettingsSection)}
      />
    </SettingsPanelLayout>
  )
}
