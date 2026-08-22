import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  Bell,
  Building2,
  CreditCard,
  Database,
  ExternalLink,
  FileText,
  Gauge,
  Globe,
  HardDrive,
  Info,
  KeyRound,
  LayoutGrid,
  Layers,
  Mic,
  Plug,
  Puzzle,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCog,
  Users,
} from 'lucide-react'
import type {
  ProfileSettingsSection,
  OrganizationSettingsSection,
  DeviceSettingsSection,
  SettingsSection,
} from '@/settings/settingsRoutes'
import { SPACE_TRASH_UI_ENABLED } from '@/utils/featureFlags'

// ── 组内子项定义 ──

export interface SettingsGroupItem<TSection extends SettingsSection = SettingsSection> {
  section: TSection
  icon: LucideIcon
  titleKey: string
  descKey: string
}

export interface SettingsGroupMeta<TSection extends SettingsSection = SettingsSection> {
  icon: LucideIcon
  titleKey: string
  descKey: string
  items: SettingsGroupItem<TSection>[]
}

/**
 * 个人侧组合面板 → 内部 tab 配置（新 IA）。
 * composite 名 → 子 section[]，由各 Composite 组件按顺序渲染 tab。
 */
export const PROFILE_GROUP_META: Partial<Record<ProfileSettingsSection, SettingsGroupMeta<ProfileSettingsSection>>> = {
  credentials: {
    icon: KeyRound,
    titleKey: 'sections.credentialsGroup',
    descKey: 'groupOverview.credentialsGroupDesc',
    items: [
      // 浏览器登录态属 device-local，已迁入「设备」组（deviceGroup）。
      { section: 'credentials-ai', icon: Sparkles, titleKey: 'sections.credentialsAi', descKey: 'groupOverview.credentialsAiDesc' },
      { section: 'credentials-apps', icon: LayoutGrid, titleKey: 'sections.credentialsApps', descKey: 'groupOverview.credentialsAppsDesc' },
    ],
  },
  preferences: {
    icon: Settings2,
    titleKey: 'sections.preferencesGroup',
    descKey: 'groupOverview.preferencesDesc',
    items: [
      { section: 'notifications', icon: Bell, titleKey: 'sections.notifications', descKey: 'groupOverview.notificationsDesc' },
      { section: 'language', icon: Settings2, titleKey: 'sections.language', descKey: 'groupOverview.languageDesc' },
      { section: 'voice', icon: Mic, titleKey: 'sections.voice', descKey: 'groupOverview.voiceDesc' },
    ],
  },
  myAI: {
    icon: Sparkles,
    titleKey: 'sections.myAIGroup',
    descKey: 'groupOverview.myAIGroupDesc',
    items: [
      { section: 'personalRules', icon: UserCog, titleKey: 'sections.personalRules', descKey: 'groupOverview.personalRulesDesc' },
      { section: 'resourceOpenPreferences', icon: ExternalLink, titleKey: 'sections.resourceOpenPreferences', descKey: 'groupOverview.resourceOpenPreferencesDesc' },
    ],
  },
}

/**
 * 「设备」域组合面板 → 内部 tab 配置（设备管理一级 category）。
 * device-local 的 7 个面板拍平为单层 7-tab 组合（含 1B 迁入的 ssh、1D 迁入的 mcp）。
 * 原 storage 组合（storageManager/performance）已拍平进此组，不再单独存在；
 * 授权 / 关于 原为侧栏一级单 panel，现降为本组 tab。
 */
export const DEVICE_GROUP_META: Partial<Record<DeviceSettingsSection, SettingsGroupMeta<DeviceSettingsSection>>> = {
  permissionUpdate: {
    icon: Info,
    titleKey: 'sections.aboutTabtin',
    descKey: 'groupOverview.aboutDesc',
    // 授权（OS 系统权限）已迁到个人设置「系统权限」，这里只剩版本与更新。
    items: [
      { section: 'about', icon: Info, titleKey: 'sections.aboutTabtin', descKey: 'groupOverview.aboutDesc' },
    ],
  },
  browserSession: {
    icon: Globe,
    titleKey: 'sections.browserSession',
    descKey: 'groupOverview.browserSessionDesc',
    items: [
      { section: 'credentials-browser', icon: Globe, titleKey: 'sections.credentialsBrowser', descKey: 'groupOverview.credentialsBrowserDesc' },
    ],
  },
  localMaintenance: {
    icon: HardDrive,
    titleKey: 'sections.localMaintenance',
    descKey: 'groupOverview.localMaintenanceDesc',
    items: [
      { section: 'storageManager', icon: Database, titleKey: 'sections.storageManager', descKey: 'groupOverview.storageManagerDesc' },
      { section: 'performance', icon: Gauge, titleKey: 'sections.performance', descKey: 'groupOverview.performanceDesc' },
    ],
  },
  advancedConnections: {
    icon: Plug,
    titleKey: 'sections.advancedConnections',
    descKey: 'groupOverview.advancedConnectionsDesc',
    items: [
      { section: 'mcp', icon: Plug, titleKey: 'sections.mcp', descKey: 'groupOverview.mcpDesc' },
      { section: 'ssh', icon: Server, titleKey: 'sections.ssh', descKey: 'groupOverview.sshDesc' },
    ],
  },
  deviceGroup: {
    icon: HardDrive,
    titleKey: 'sections.deviceGroup',
    descKey: 'groupOverview.deviceGroupDesc',
    items: [
      { section: 'authorization', icon: ShieldCheck, titleKey: 'sections.authorizationGroup', descKey: 'groupOverview.authorizationGroupDesc' },
      { section: 'credentials-browser', icon: Globe, titleKey: 'sections.credentialsBrowser', descKey: 'groupOverview.credentialsBrowserDesc' },
      { section: 'storageManager', icon: Database, titleKey: 'sections.storageManager', descKey: 'groupOverview.storageManagerDesc' },
      { section: 'performance', icon: Gauge, titleKey: 'sections.performance', descKey: 'groupOverview.performanceDesc' },
      { section: 'about', icon: Info, titleKey: 'sections.about', descKey: 'groupOverview.aboutDesc' },
      { section: 'mcp', icon: Plug, titleKey: 'sections.mcp', descKey: 'groupOverview.mcpDesc' },
      { section: 'ssh', icon: Server, titleKey: 'sections.ssh', descKey: 'groupOverview.sshDesc' },
    ],
  },
}

/** 团队侧组合面板 → 内部 tab 配置 */
export const SETTINGS_GROUP_META: Partial<Record<OrganizationSettingsSection, SettingsGroupMeta<OrganizationSettingsSection>>> = {
  team: {
    icon: Building2,
    titleKey: 'sections.teamGroup',
    descKey: 'groupOverview.teamGroupDesc',
    // 「通知规则」尚未做好、配置无实际效果，已下线；团队资料只保留基础信息单面板。
    items: [
      { section: 'general', icon: Building2, titleKey: 'sections.organizationGeneral', descKey: 'groupOverview.organizationGeneralDesc' },
    ],
  },
  ai: {
    icon: Settings2,
    titleKey: 'sections.aiGroup',
    descKey: 'groupOverview.aiGroupDesc',
    items: [
      { section: 'llm', icon: Settings2, titleKey: 'sections.organizationLlm', descKey: 'groupOverview.llmDesc' },
      { section: 'services', icon: Layers, titleKey: 'sections.organizationServices', descKey: 'groupOverview.servicesDesc' },
    ],
  },
  appsIntegration: {
    icon: LayoutGrid,
    titleKey: 'sections.appsIntegration',
    descKey: 'groupOverview.appsIntegrationDesc',
    items: [
      { section: 'apps', icon: LayoutGrid, titleKey: 'sections.organizationApps', descKey: 'groupOverview.appsDesc' },
      { section: 'installedExtensions', icon: Puzzle, titleKey: 'pluginMarketplace.installedTab', descKey: 'groupOverview.installedExtensionsDesc' },
    ],
  },
  teamMembers: {
    icon: Users,
    titleKey: 'sections.teamMembers',
    descKey: 'groupOverview.teamMembersDesc',
    // 成员额度已并入成员列表（每行含用量/额度 + 编辑额度），不再单列一张卡片。
    items: [
      { section: 'members', icon: Users, titleKey: 'sections.organizationMembers', descKey: 'groupOverview.membersDesc' },
    ],
  },
  membershipWallet: {
    icon: CreditCard,
    titleKey: 'sections.membershipWallet',
    descKey: 'groupOverview.membershipWalletDesc',
    items: [
      { section: 'membership', icon: CreditCard, titleKey: 'sections.organizationMembership', descKey: 'groupOverview.membershipDesc' },
    ],
  },
  usageBilling: {
    icon: BarChart3,
    titleKey: 'sections.usageBilling',
    descKey: 'groupOverview.usageBillingDesc',
    // 会员与点券已移入「团队资料」页；此处只保留用量 / 账单 / 计费规则。
    items: [
      { section: 'usage', icon: BarChart3, titleKey: 'sections.organizationUsageCenter', descKey: 'groupOverview.usageDesc' },
      { section: 'billing', icon: FileText, titleKey: 'sections.organizationBilling', descKey: 'groupOverview.billingDesc' },
      { section: 'pricing', icon: Layers, titleKey: 'sections.organizationPricingRulesTab', descKey: 'groupOverview.pricingRulesDesc' },
    ],
  },
  systemCenter: {
    icon: HardDrive,
    titleKey: 'sections.systemCenter',
    descKey: SPACE_TRASH_UI_ENABLED
      ? 'groupOverview.systemCenterDesc'
      : 'groupOverview.systemCenterDescResourcesOnly',
    items: [
      ...(SPACE_TRASH_UI_ENABLED
        ? [
            {
              section: 'trashedSpaces' as const,
              icon: Trash2,
              titleKey: 'sections.organizationTrashedSpaces',
              descKey: 'groupOverview.trashedSpacesDesc',
            },
          ]
        : []),
      { section: 'trashedResources', icon: Trash2, titleKey: 'sections.organizationTrashedResources', descKey: 'groupOverview.trashedResourcesDesc' },
    ],
  },
}

/** 子 section → 父组 section（用于侧栏高亮、返回导航、深链接） */
export const SECTION_PARENT_MAP: Partial<Record<OrganizationSettingsSection, OrganizationSettingsSection>> = {
  general: 'team',
  // llm / services 已从「AI 与模型」组拆成独立一级入口，不再有父组。
  myUsage: 'usageBilling',
  apps: 'appsIntegration',
  extensions: 'appsIntegration',
  installedExtensions: 'appsIntegration',
  members: 'teamMembers',
  memberBudget: 'teamMembers',
  // 会员与点券移入「团队资料」页：membership 深链解析到 team 组渲染。
  membership: 'team',
  usage: 'usageBilling',
  billing: 'usageBilling',
  wallet: 'usageBilling',
  pricing: 'usageBilling',
  storage: 'usageBilling',
  trashedSpaces: 'systemCenter',
  trashedResources: 'systemCenter',
  storageFiles: 'usageBilling',
  appCatalog: 'appsIntegration',
}

/** 个人侧子 section → 父组 section
 *  IA 打平后：个人资料 / 系统通知 / 外观显示 / 语音习惯 / AI 设置 都是一级入口，
 *  notifications / language / voice 直接作为顶级 section（不再收进 preferences 组）；
 *  AI 设置（myAI）单页堆叠 personalRules + resourceOpenPreferences 两块内容。 */
export const PROFILE_SECTION_PARENT_MAP: Partial<Record<ProfileSettingsSection, ProfileSettingsSection>> = {
  profile: 'account',
  developer: 'account',
  'credentials-ai': 'credentials',
  'credentials-apps': 'credentials',
  resourceOpenPreferences: 'myAI',
  personalRules: 'myAI',
  myUsage: 'myAI',
}

/** 设备侧子 section → 父组 section。
 *  授权（authorization）已迁到个人设置「系统权限」，不再是设备侧子项；
 *  设备「关于 TabTin」（permissionUpdate）只承载 about。 */
export const DEVICE_SECTION_PARENT_MAP: Partial<Record<DeviceSettingsSection, DeviceSettingsSection>> = {
  about: 'permissionUpdate',
  'credentials-browser': 'browserSession',
  // storageManager / performance 已从「本机维护」组拆成独立一级入口，不再有父组
  // （resolveDevice 缺省回落到自身 → 各自渲染单面板；deviceGroup 旧深链仍可作为 tab 访问）。
  mcp: 'advancedConnections',
  ssh: 'advancedConnections',
}
