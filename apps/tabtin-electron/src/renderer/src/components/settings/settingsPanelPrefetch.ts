import type { SettingsSidebarItem } from './settingsNavigation'
import type {
  DeviceSettingsSection,
  ProfileSettingsSection,
  OrganizationSettingsSection,
} from '@/settings/settingsRoutes'
import {
  DEVICE_GROUP_META,
  PROFILE_GROUP_META,
  SETTINGS_GROUP_META,
} from './settingsGroupConfig'

type PrefetchTask = () => Promise<unknown>

const prefetchSettingsGroupComposites: PrefetchTask = () =>
  import('./panels/SettingsGroupComposites')

const PROFILE_INNER_PANEL_IMPORTS: Partial<Record<ProfileSettingsSection, PrefetchTask>> = {
  'credentials-ai': () => import('./panels/CredentialsAiPanel'),
}

const DEVICE_INNER_PANEL_IMPORTS: Partial<Record<DeviceSettingsSection, PrefetchTask>> = {
  about: () => import('./panels/UpdatePanel'),
  // 存储管理 / 性能监控为一级入口直渲染单面板，预取直接命中对应 chunk。
  storageManager: () => import('./panels/StorageManagerPanel'),
  performance: () => import('./panels/PerformancePanel'),
}

const ORGANIZATION_INNER_PANEL_IMPORTS: Partial<Record<OrganizationSettingsSection, PrefetchTask>> = {
  general: () => import('./panels/OrganizationSettingsPanel'),
  llm: () => import('@components/organization/OrganizationModelSettings'),
  services: () => import('./panels/OrganizationServiceCatalogPanel'),
  apps: () => import('./panels/AppMarketplacePanel'),
  extensions: () => import('./panels/AppMarketplacePanel'),
  installedExtensions: () => import('./panels/LocalPluginMarketplacePanel'),
  members: () => import('./panels/OrganizationMembersPanel'),
  membership: () => import('./panels/OrganizationMembershipPanel'),
  usage: () => import('./panels/OrganizationUsageDashboard'),
  storage: () => import('./panels/OrganizationStorageDashboard'),
}

function defaultGroupChildSection<TSection extends string>(
  meta: Partial<Record<TSection, { items: Array<{ section: TSection }> }>>,
  parent: TSection,
): TSection {
  return meta[parent]?.items[0]?.section ?? parent
}

function compositePrefetchTasks<TSection extends string>(
  innerImports: Partial<Record<TSection, PrefetchTask>>,
  parent: TSection,
  groupMeta: Partial<Record<TSection, { items: Array<{ section: TSection }> }>>,
): PrefetchTask[] {
  const items = groupMeta[parent]?.items ?? [{ section: defaultGroupChildSection(groupMeta, parent) }]
  const innerTasks = items
    .map((item) => innerImports[item.section])
    .filter((task): task is PrefetchTask => Boolean(task))
  const uniqueInner = [...new Set(innerTasks)]
  return uniqueInner.length > 0
    ? [prefetchSettingsGroupComposites, ...uniqueInner]
    : [prefetchSettingsGroupComposites]
}

// 打平后个人设置一级入口直渲染单面板，预取直接命中对应 chunk（不经组合面板）。
const PROFILE_DIRECT_PANEL_IMPORTS: Partial<Record<ProfileSettingsSection, PrefetchTask[]>> = {
  account: [() => import('./panels/UserProfilePanel')],
  devices: [() => import('./panels/AccountDevicesPanel')],
  developer: [() => import('./panels/DeveloperApiKeyPanel')],
  // 系统权限页由 SettingsGroupComposites 承载，堆叠「系统通知 + OS 权限」两块 chunk。
  notifications: [
    prefetchSettingsGroupComposites,
    () => import('./panels/NotificationPreferencesPanel'),
    () => import('./panels/AuthorizationSystemPanel'),
  ],
  language: [() => import('./panels/LanguagePanel')],
  voice: [() => import('./panels/VoiceSettingsPanel')],
  // AI 设置页由 SettingsGroupComposites 承载，堆叠两块内容 chunk。
  myAI: [
    prefetchSettingsGroupComposites,
    () => import('./panels/PersonalRulesPanel'),
    () => import('./panels/ResourceOpenPreferencesPanel'),
  ],
  myAgents: [() => import('./panels/MyAgentsPanel')],
  skillLibrary: [() => import('./panels/SkillLibraryPanel')],
}

function tasksForProfileSection(section: ProfileSettingsSection): PrefetchTask[] {
  return (
    PROFILE_DIRECT_PANEL_IMPORTS[section] ??
    compositePrefetchTasks(PROFILE_INNER_PANEL_IMPORTS, section, PROFILE_GROUP_META)
  )
}

function tasksForDeviceSection(section: DeviceSettingsSection): PrefetchTask[] {
  return compositePrefetchTasks(DEVICE_INNER_PANEL_IMPORTS, section, DEVICE_GROUP_META)
}

function tasksForOrganizationSection(section: OrganizationSettingsSection): PrefetchTask[] {
  return compositePrefetchTasks(ORGANIZATION_INNER_PANEL_IMPORTS, section, SETTINGS_GROUP_META)
}

function tasksForSidebarItem(item: SettingsSidebarItem): PrefetchTask[] {
  if (item.category === 'profile') {
    return tasksForProfileSection(item.section as ProfileSettingsSection)
  }
  if (item.category === 'device') {
    return tasksForDeviceSection(item.section as DeviceSettingsSection)
  }
  return tasksForOrganizationSection(item.section as OrganizationSettingsSection)
}

const startedPrefetches = new Set<string>()

export function prefetchSettingsPanel(item: SettingsSidebarItem): void {
  const key = `${item.category}:${item.section}`
  if (startedPrefetches.has(key)) {
    return
  }

  const tasks = tasksForSidebarItem(item)
  if (tasks.length === 0) {
    return
  }

  startedPrefetches.add(key)
  void Promise.all(tasks.map((task) => task())).catch(() => {
    startedPrefetches.delete(key)
  })
}

/** @internal 单测重置 dedupe 状态 */
export function resetSettingsPanelPrefetchForTests(): void {
  startedPrefetches.clear()
}
