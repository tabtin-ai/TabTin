/**
 * SettingsSpace —— 「我的」tab 的主画布。
 *
 * 新 IA 渲染逻辑（参考 macOS Settings / Linear）：
 *  - route.section 可能是「组合 section」（account/preferences/team/ai/…）或「叶子 section」
 *  - 叶子 section → 通过 PROFILE_SECTION_PARENT_MAP / SECTION_PARENT_MAP 反查父组
 *  - composite 接收 activeSubsection 参数，决定默认 tab
 *  - 未知 section 兜底到 account / team
 */

import React, { lazy, Suspense, useEffect, useMemo } from 'react'
import { ShieldCheck, AlertTriangle } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useQueryClient } from '@tanstack/react-query'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useTranslation } from 'react-i18next'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { SettingsPanelLayout } from './SettingsPanelLayout'
import { SettingsSectionCard } from './SettingsSectionCard'
import { SettingsSkeleton } from './SettingsSkeleton'
import { ConfirmDialog } from '@components/ui'
import { ErrorBoundary } from '@components/common/ErrorBoundary'
import { canManageOrganization as canManageOrganizationFn } from '@/hooks/useCanManageOrganization'
import { useEffectiveFeature } from '@/hooks/useEffectiveFeature'
import { prefetchOrganizationBillingData } from '@/hooks/queries/membership'
import type { Organization, OrganizationRole } from '@tabtin/app-shell'
import {
  type ProfileSettingsSection,
  type OrganizationSettingsSection,
  type DeviceSettingsSection,
} from '@/settings/settingsRoutes'
import { isSettingsRouteVisible } from '@/settings/settingsVisibility'
import { SETTINGS_HINT } from './settingsUi'
import {
  SECTION_PARENT_MAP,
  PROFILE_SECTION_PARENT_MAP,
  DEVICE_SECTION_PARENT_MAP,
} from './settingsGroupConfig'

// ── Lazy imports ──

// 「授权」「关于」已并入「设备」组合（DeviceComposite），不再是侧栏一级单 panel。

// 个人设置打平：一级入口直接渲染单面板，不再走组合面板 + 二级 tab。
const UserProfilePanel = lazy(() => import('./panels/UserProfilePanel').then(m => ({ default: m.UserProfilePanel })))
const AccountDevicesPanel = lazy(() => import('./panels/AccountDevicesPanel').then(m => ({ default: m.AccountDevicesPanel })))
const DeveloperApiKeyPanel = lazy(() => import('./panels/DeveloperApiKeyPanel').then(m => ({ default: m.DeveloperApiKeyPanel })))
const LanguagePanel = lazy(() => import('./panels/LanguagePanel').then(m => ({ default: m.LanguagePanel })))
const VoiceSettingsPanel = lazy(() => import('./panels/VoiceSettingsPanel').then(m => ({ default: m.VoiceSettingsPanel })))
const MyAgentsPanel = lazy(() => import('./panels/MyAgentsPanel').then(m => ({ default: m.MyAgentsPanel })))
const SkillLibraryPanel = lazy(() => import('./panels/SkillLibraryPanel').then(m => ({ default: m.SkillLibraryPanel })))
const CredentialsComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.CredentialsComposite })))
// 系统权限：单页堆叠「系统通知分类 + OS 系统权限」，由 SettingsGroupComposites 承载。
const SystemPermissionsComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.SystemPermissionsComposite })))
// AI 设置：单页堆叠「通用规则 + 默认打开方式」，仍由 SettingsGroupComposites 承载。
const MyAIComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.MyAIComposite })))
const DeviceComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.DeviceComposite })))
const PermissionUpdateComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.PermissionUpdateComposite })))
const BrowserSessionComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.BrowserSessionComposite })))
const LocalMaintenanceComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.LocalMaintenanceComposite })))
const StorageManagerComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.StorageManagerComposite })))
const PerformanceComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.PerformanceComposite })))
const AdvancedConnectionsComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.AdvancedConnectionsComposite })))
const TeamComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.TeamComposite })))
const LlmComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.LlmComposite })))
const ServicesComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.ServicesComposite })))
const AppsIntegrationComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.AppsIntegrationComposite })))
const TeamMembersComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.TeamMembersComposite })))
const UsageBillingComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.UsageBillingComposite })))
const SystemCenterComposite = lazy(() => import('./panels/SettingsGroupComposites').then(m => ({ default: m.SystemCenterComposite })))
const OrganizationResourceTrashPanel = lazy(() => import('./panels/OrganizationResourceTrashPanel').then(m => ({ default: m.OrganizationResourceTrashPanel })))

interface OrganizationPanelCtx {
  organization: Organization
  canManageOrganization: boolean
  currentUserRole: OrganizationRole | null | undefined
  activeSubsection: OrganizationSettingsSection | null
}

interface ProfilePanelCtx {
  closeSettings: () => void
  organization: Organization | null
  activeSubsection: ProfileSettingsSection | null
}

interface DevicePanelCtx {
  activeSubsection: DeviceSettingsSection | null
}

type ProfilePanelRenderer = (ctx: ProfilePanelCtx) => React.ReactNode
type DevicePanelRenderer = (ctx: DevicePanelCtx) => React.ReactNode
type OrganizationPanelRenderer = (ctx: OrganizationPanelCtx) => React.ReactNode

const PROFILE_COMPOSITE_PARENTS: ProfileSettingsSection[] = [
  'account',
  'devices',
  'notifications',
  'language',
  'voice',
  'credentials',
  'developer',
  'preferences',
  'myAI',
  'myAgents',
  'skillLibrary',
]

/** profile 面板渲染器（key = 一级 section）。打平后一级入口直接渲染单面板。 */
const PROFILE_PANELS: Partial<Record<ProfileSettingsSection, ProfilePanelRenderer>> = {
  account: (ctx) => <UserProfilePanel onRequestClose={ctx.closeSettings} />,
  devices: () => <AccountDevicesPanel />,
  notifications: () => <SystemPermissionsComposite />,
  language: () => <LanguagePanel />,
  voice: () => <VoiceSettingsPanel />,
  myAI: () => <MyAIComposite />,
  myAgents: () => <MyAgentsPanel />,
  skillLibrary: () => <SkillLibraryPanel />,
  // 隐藏项 / 旧深链兼容：开发者凭据与连接账号当前不在侧栏，preferences 旧入口回退到系统权限。
  developer: () => <DeveloperApiKeyPanel />,
  credentials: (ctx) => <CredentialsComposite activeSubsection={ctx.activeSubsection} />,
  preferences: () => <SystemPermissionsComposite />,
}

/** device 面板渲染器（key = 一级 section）。
 *  authorization / credentials-browser / storageManager / performance / about
 *  均为 deviceGroup 的子 tab，经 DEVICE_SECTION_PARENT_MAP 反查到 deviceGroup 渲染，
 *  不在此处单列。 */
const DEVICE_PANELS: Partial<Record<DeviceSettingsSection, DevicePanelRenderer>> = {
  permissionUpdate: (ctx) => <PermissionUpdateComposite activeSubsection={ctx.activeSubsection} />,
  browserSession: (ctx) => <BrowserSessionComposite activeSubsection={ctx.activeSubsection} />,
  // 「本机维护」拆成两个一级入口：存储管理 / 性能监控；localMaintenance 仅保留兼容旧深链。
  localMaintenance: (ctx) => <LocalMaintenanceComposite activeSubsection={ctx.activeSubsection} />,
  storageManager: () => <StorageManagerComposite />,
  performance: () => <PerformanceComposite />,
  advancedConnections: (ctx) => <AdvancedConnectionsComposite activeSubsection={ctx.activeSubsection} />,
  deviceGroup: (ctx) => <DeviceComposite activeSubsection={ctx.activeSubsection} />,
}

/** organization 组合面板渲染器 */
const ORGANIZATION_PANELS: Partial<Record<OrganizationSettingsSection, OrganizationPanelRenderer>> = {
  team: (ctx) => <TeamComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} activeSubsection={ctx.activeSubsection} />,
  // 模型配置 / AI 服务开关：两个独立一级入口（原「AI 与模型」二级 tab 拆分）。'ai' 保留为旧深链兜底。
  llm: (ctx) => <LlmComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} activeSubsection={ctx.activeSubsection} />,
  services: (ctx) => <ServicesComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} activeSubsection={ctx.activeSubsection} />,
  ai: (ctx) => <LlmComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} activeSubsection={ctx.activeSubsection} />,
  appsIntegration: (ctx) => <AppsIntegrationComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} activeSubsection={ctx.activeSubsection} />,
  teamMembers: (ctx) => <TeamMembersComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} currentUserRole={ctx.currentUserRole} activeSubsection={ctx.activeSubsection} />,
  // 会员与点券已并入「团队资料」页：旧「会员钱包」入口改指团队资料。
  membershipWallet: (ctx) => <TeamComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} activeSubsection={ctx.activeSubsection} />,
  usageBilling: (ctx) => <UsageBillingComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} activeSubsection={ctx.activeSubsection} />,
  systemCenter: (ctx) => <SystemCenterComposite organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} activeSubsection={ctx.activeSubsection} />,
  // 团队资源回收站：一级面板，与「回收站」同级（/#2253）
  trashedResources: (ctx) => <OrganizationResourceTrashPanel organization={ctx.organization} canManageOrganization={ctx.canManageOrganization} />,
}

/**
 * 把任意 route.section（可能是叶子）解析为：
 * - composite 父 section（用于查找 renderer）
 * - 子 section（传给 composite 决定默认 tab）
 */
function resolveProfile(section: ProfileSettingsSection): {
  parent: ProfileSettingsSection
  child: ProfileSettingsSection | null
} {
  const parent = PROFILE_SECTION_PARENT_MAP[section]
  if (parent) return { parent, child: section }
  if (PROFILE_COMPOSITE_PARENTS.includes(section)) return { parent: section, child: null }
  return { parent: section, child: null }
}

function resolveDevice(section: DeviceSettingsSection): {
  parent: DeviceSettingsSection
  child: DeviceSettingsSection | null
} {
  const parent = DEVICE_SECTION_PARENT_MAP[section]
  if (parent) return { parent, child: section }
  return { parent: section, child: null }
}

function resolveOrganization(section: OrganizationSettingsSection): {
  parent: OrganizationSettingsSection
  child: OrganizationSettingsSection | null
} {
  const parent = SECTION_PARENT_MAP[section]
  if (parent) return { parent, child: section }
  return { parent: section, child: null }
}

export const SettingsSpace: React.FC = () => {
  const { t } = useTranslation(['settings', 'organization'])
  const queryClient = useQueryClient()
  const { activeRoute, closeSettings, pendingRoute, confirmDiscard, cancelPendingRoute } = useSettingsSpaceStore(
    useShallow((s) => ({
      activeRoute: s.activeRoute,
      closeSettings: s.closeSettings,
      pendingRoute: s.pendingRoute,
      confirmDiscard: s.confirmDiscard,
      cancelPendingRoute: s.cancelPendingRoute,
    }))
  )
  const organizations = useOrganizationStore(state => state.organizations)
  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const currentUserRole = useOrganizationStore(state => state.currentUserRole)
  const user = useAuthStore(state => state.user)

  const routeOrganizationId = activeRoute?.category === 'organization'
    ? activeRoute.organizationId
    : null
  // 与侧栏一致：当前选中组织优先用 selectedOrganization（含 WS / detail 刷新的最新 name）。
  // organizations[] 列表项可能仍是旧快照（selectOrganization 曾只写 selectedOrganization）。
  const targetOrganization = routeOrganizationId
    ? (selectedOrganization?.id === routeOrganizationId
      ? selectedOrganization
      : organizations.find(w => w.id === routeOrganizationId) ?? null)
    : null
  const profileUsageOrganization = selectedOrganization
    ?? organizations.find(w => w.type === 'personal')
    ?? organizations[0]
    ?? null
  const daemonControlAvailable = useEffectiveFeature('daemon_control', selectedOrganization?.id).enabled

  useEffect(() => {
    if (routeOrganizationId) {
      prefetchOrganizationBillingData(queryClient, routeOrganizationId)
    }
  }, [routeOrganizationId, queryClient])

  const isOwner = targetOrganization && user ? targetOrganization.owner_id === user.id : false
  const effectiveRole = currentUserRole ?? (isOwner ? 'owner' as const : null)
  const canManageOrganization = canManageOrganizationFn(effectiveRole)

  // ErrorBoundary key 用组合父 section，避免 composite 内切 tab（如 应用市场 ↔ 已安装）
  // 触发整页 remount + Suspense skeleton 的「重载感」。
  const sectionKey = useMemo(() => {
    if (!activeRoute) return 'empty'
    if (activeRoute.category === 'organization') {
      const { parent } = resolveOrganization(activeRoute.section)
      return `${parent}:${routeOrganizationId}`
    }
    if (activeRoute.category === 'profile') {
      const { parent } = resolveProfile(activeRoute.section)
      return parent
    }
    if (activeRoute.category === 'device') {
      const { parent } = resolveDevice(activeRoute.section)
      return parent
    }
    return 'unknown'
  }, [activeRoute, routeOrganizationId])

  if (!activeRoute) {
    return (
      <div className="flex h-full w-full items-center justify-center overflow-hidden">
        <div className="text-center space-y-2 max-w-sm">
          <p className="text-body text-muted-foreground">
            {t('emptySelection.title', { ns: 'settings', defaultValue: '请从左侧选择一项' })}
          </p>
          <p className={SETTINGS_HINT}>
            {t('emptySelection.hint', { ns: 'settings', defaultValue: '账户、通知、组织管理等' })}
          </p>
        </div>
      </div>
    )
  }

  const route = activeRoute
  let content: React.ReactNode

  if (
    !isSettingsRouteVisible(route)
    || (route.category === 'profile' && route.section === 'devices' && !daemonControlAvailable)
  ) {
    content = PROFILE_PANELS.account!({ closeSettings, organization: profileUsageOrganization, activeSubsection: null })
  } else if (route.category === 'profile') {
    const { parent, child } = resolveProfile(route.section)
    const renderer = PROFILE_PANELS[parent] ?? PROFILE_PANELS.account!
    content = renderer({ closeSettings, organization: profileUsageOrganization, activeSubsection: child })
  } else if (route.category === 'device') {
    const { parent, child } = resolveDevice(route.section)
    const renderer = DEVICE_PANELS[parent] ?? DEVICE_PANELS.deviceGroup!
    content = renderer({ activeSubsection: child })
  } else if (!targetOrganization) {
    content = (
      <SettingsPanelLayout>
        <SettingsSectionCard tone="muted" icon={<ShieldCheck className="h-4 w-4" />} title={t('categories.organization')} subtitle={t('organization.empty')}>
          <p className="text-body text-muted-foreground">{t('organization.emptySection')}</p>
        </SettingsSectionCard>
      </SettingsPanelLayout>
    )
  } else {
    const { parent, child } = resolveOrganization(route.section)
    const isPersonalMembers = (parent === 'teamMembers' || child === 'members') && targetOrganization.type === 'personal'
    if (isPersonalMembers) {
      content = (
        <SettingsPanelLayout>
          <SettingsSectionCard tone="muted" icon={<ShieldCheck className="h-4 w-4" />} title={t('categories.organization')}>
            <p className="text-body text-muted-foreground">{t('members.personalHint', { ns: 'organization' })}</p>
          </SettingsSectionCard>
        </SettingsPanelLayout>
      )
    } else {
      const renderer = ORGANIZATION_PANELS[parent] ?? ORGANIZATION_PANELS.team!
      const ctx: OrganizationPanelCtx = {
        organization: targetOrganization,
        canManageOrganization,
        currentUserRole,
        activeSubsection: child,
      }
      content = renderer(ctx)
    }
  }

  const errorFallback = (
    <SettingsPanelLayout>
      <div className="flex flex-col items-center justify-center gap-2.5 py-12">
        <AlertTriangle className="h-5 w-5 text-muted-foreground/60" />
        <p className="text-body text-muted-foreground">{t('panelError.title', { ns: 'settings' })}</p>
        <p className={SETTINGS_HINT}>{t('panelError.hint', { ns: 'settings' })}</p>
      </div>
    </SettingsPanelLayout>
  )

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="h-full min-h-0 px-6 py-4 md:px-8 md:py-6">
        <ErrorBoundary key={sectionKey} resetKeys={[sectionKey]} fallback={errorFallback}>
          <Suspense fallback={<SettingsSkeleton />}>
            {content}
          </Suspense>
        </ErrorBoundary>
      </div>

      <ConfirmDialog
        open={Boolean(pendingRoute)}
        onOpenChange={(open) => { if (!open) cancelPendingRoute() }}
        title={t('unsavedChanges.title', { ns: 'settings' })}
        description={t('unsavedChanges.description', { ns: 'settings' })}
        confirmText={t('unsavedChanges.discard', { ns: 'settings' })}
        cancelText={t('unsavedChanges.stay', { ns: 'settings' })}
        variant="destructive"
        onConfirm={confirmDiscard}
      />
    </div>
  )
}
