import { isSettingsRouteVisible } from './settingsVisibility'

export const PROFILE_SETTINGS_SECTIONS = [
  // ── 侧栏个人设置段（4 项） ──
  'account',           // 组合：个人资料 + 个人访问令牌 / CLI 凭据
  'devices',           // 当前账号已登录的全部设备与实时在线快照
  'preferences',       // 组合：notifications + language + voice
  'myAI',              // 组合：personalRules + skillLibrary + resourceOpenPreferences（用量概览当前前端隐藏）
  // ── 当前隐藏的连接账号能力 ──
  'credentials',       // 组合：AI 服务 / 应用 两个 tab（浏览器已迁入设备组）
  'developer',         // account 内部 tab：DeveloperApiKeyPanel（TabTin API Key + CLI）
  // ── credentials 内部 tab（仅剩 AI / 应用） ──
  'credentials-ai',
  'credentials-apps',
  // ── preferences 内部 tab ──
  'notifications',     // 账号级通知偏好（2026-05 治理后从团队侧迁过来）
  'language',
  'voice',
  'resourceOpenPreferences',
  'personalRules',     // 个人通用规则（两层规则里的个人层）
  'skillLibrary',      // 全局技能库（ W3：Skill 跟 Agent 走，库全局浏览 + 分配给 Agent）
  'myAgents',          // 我的 Agent 管理（ W2：独立于 Workspace 设置的 Agent 列表 + 精简档案）
  'myUsage',           // 我的 AI 用量（个人任务入口，数据按当前团队预算读取）
  // ── 旧叶子 section（兼容外部深链接） ──
  'profile',           // 旧 account 默认 tab；现在 = account
] as const
// 「设备」域：device-local 的设备管理一级 category（与 profile / organization 并列）。
// 四个任务入口是侧栏主干；deviceGroup 保留给旧深链，进入完整设备组合。
export const DEVICE_SETTINGS_SECTIONS = [
  // ── 侧栏「设备管理」段入口 ──
  'permissionUpdate',  // 组合：authorization + about
  'browserSession',   // 组合：credentials-browser
  'localMaintenance', // 组合：storageManager + performance
  'advancedConnections', // 组合：mcp + ssh
  // ── 旧侧栏入口兼容 ──
  'deviceGroup',       // 组合：授权 / 浏览器 / 本地存储 / 性能 / 关于 / MCP / SSH 七个 tab（device-local）
  // ── 设备组内部 tab ──
  'authorization',     // 单 panel：OS 系统权限仪表盘（macOS TCC / Win 应用权限）
  'credentials-browser', // 单 panel：浏览器登录态复用（从 credentials 组迁入设备组）
  'storageManager',
  'performance',
  'about',
  'mcp',               // 单 panel：本机 MCP 连接管理（IA Phase 1·1D 从 Agent 资料页迁入；数据仍走 localMcp）
  'ssh',               // 单 panel：当前设备的 SSH 远程服务器管理（IA Phase 1·1B 从 Agent 资料页迁入）
] as const
export const ORGANIZATION_SETTINGS_SECTIONS = [
  // ── 侧栏直接展示 ──
  'team',               // 组合：general + notifications
  'ai',                 // 组合：llm + services
  'teamMembers',        // 组合：members + memberBudget
  'appsIntegration',    // 组合：apps + extensions
  'membershipWallet',   // 单 panel：membership（钱包余额并入其总览卡）
  'usageBilling',       // 组合：membership + usage(含流水) + billing + pricing
  'systemCenter',       // 组合：trashedSpaces（Agent 回收站）
  // ── 子项（组合面板内部 tab；保留以兼容旧深链接） ──
  'general',
  'llm',
  'myUsage',
  'notifications',
  'apps',
  'extensions',
  'installedExtensions',
  'members',
  'memberBudget',
  'membership',
  'wallet',
  'usage',
  'billing',
  'services',
  'pricing',
  'storage',
  'storageFiles',
  'trashedResources',  // 团队资源回收站（侧栏一级，与 systemCenter 同级；/#2253）
  'trashedSpaces',
  'appCatalog',
] as const

export type SettingsCategory = 'profile' | 'organization' | 'device'
export type ProfileSettingsSection = typeof PROFILE_SETTINGS_SECTIONS[number]
export type OrganizationSettingsSection = typeof ORGANIZATION_SETTINGS_SECTIONS[number]
export type DeviceSettingsSection = typeof DEVICE_SETTINGS_SECTIONS[number]
export type SettingsSection = ProfileSettingsSection | OrganizationSettingsSection | DeviceSettingsSection

export type ProfileSettingsRoute = {
  category: 'profile'
  section: ProfileSettingsSection
}

export type DeviceSettingsRoute = {
  category: 'device'
  section: DeviceSettingsSection
}

export type UnresolvedOrganizationRoute = {
  category: 'organization'
  section: OrganizationSettingsSection
  organizationId?: string
}

export type ResolvedOrganizationRoute = {
  category: 'organization'
  section: OrganizationSettingsSection
  organizationId: string
}

export type SettingsRouteInput = ProfileSettingsRoute | UnresolvedOrganizationRoute | DeviceSettingsRoute

export type SettingsRoute = ProfileSettingsRoute | ResolvedOrganizationRoute | DeviceSettingsRoute

export type OrganizationSettingsRoute = ResolvedOrganizationRoute

export type SettingsRouteByCategory = {
  profile: ProfileSettingsRoute
  organization: ResolvedOrganizationRoute
  device: DeviceSettingsRoute
}

export const isProfileSettingsSection = (section: unknown): section is ProfileSettingsSection => (
  typeof section === 'string' && PROFILE_SETTINGS_SECTIONS.includes(section as ProfileSettingsSection)
)

export const isOrganizationSettingsSection = (section: unknown): section is OrganizationSettingsSection => (
  typeof section === 'string' && ORGANIZATION_SETTINGS_SECTIONS.includes(section as OrganizationSettingsSection)
)

export const isDeviceSettingsSection = (section: unknown): section is DeviceSettingsSection => (
  typeof section === 'string' && DEVICE_SETTINGS_SECTIONS.includes(section as DeviceSettingsSection)
)

export const DEFAULT_SETTINGS_ROUTES: SettingsRouteByCategory = {
  profile: { category: 'profile', section: 'account' },
  organization: { category: 'organization', section: 'team', organizationId: '__unresolved__' },
  device: { category: 'device', section: 'permissionUpdate' },
}

const LEGACY_ROUTE_MAP: Record<string, SettingsRouteInput> = {
  // ── 个人侧栏一级 ──
  overview: DEFAULT_SETTINGS_ROUTES.profile,
  account: { category: 'profile', section: 'account' },
  devices: { category: 'profile', section: 'devices' },
  credentials: { category: 'profile', section: 'credentials' },
  developer: { category: 'profile', section: 'developer' },
  preferences: { category: 'profile', section: 'preferences' },
  myAI: { category: 'profile', section: 'myAI' },
  // ── 设备组（侧栏「设备」段入口 + device-local 子项深链接） ──
  permissionUpdate: { category: 'device', section: 'permissionUpdate' },
  browserSession: { category: 'device', section: 'browserSession' },
  localMaintenance: { category: 'device', section: 'localMaintenance' },
  advancedConnections: { category: 'device', section: 'advancedConnections' },
  deviceGroup: { category: 'device', section: 'deviceGroup' },
  // 授权（OS 系统权限）已迁到个人设置「系统权限」（notifications 入口承载）。
  authorization: { category: 'profile', section: 'notifications' },
  // ── 个人子项（IA 打平：系统通知 / 外观显示 / 语音习惯 均为一级入口） ──
  profile: { category: 'profile', section: 'account' },
  notifications: { category: 'profile', section: 'notifications' },
  language: { category: 'profile', section: 'language' },
  voice: { category: 'profile', section: 'voice' },
  resourceOpenPreferences: { category: 'profile', section: 'resourceOpenPreferences' },
  // 个人通用规则深链接：命中「个人设置 → 我的 AI」组合面板的 personalRules tab。
  personalRules: { category: 'profile', section: 'personalRules' },
  // storageManager / performance：原父组 'storage' 已删，改指各自字面量 section
  // （parent map 反查到 deviceGroup）。UserProfile.tsx 的「存储管理」入口依赖此条。
  storageManager: { category: 'device', section: 'storageManager' },
  performance: { category: 'device', section: 'performance' },
  about: { category: 'device', section: 'about' },
  // MCP 从 Agent 资料页迁入设备域（IA Phase 1·1D）。旧深链/书签 'mcp'（原为 Agent mcp 模块）一律改指设备域 mcp tab。
  mcp: { category: 'device', section: 'mcp' },
  // SSH 从 Agent 资料页迁入设备域（IA Phase 1·1B）。旧深链/书签 'ssh' 一律指向设备域 ssh tab。
  ssh: { category: 'device', section: 'ssh' },
  // ── 团队 ──
  organization: DEFAULT_SETTINGS_ROUTES.organization,
  workspace: DEFAULT_SETTINGS_ROUTES.organization,
  // ── 团队组合 section ──
  team: { category: 'organization', section: 'team', organizationId: '' },
  // 「AI 与模型」已拆分：旧 ai 深链落到「模型配置」。
  ai: { category: 'organization', section: 'llm', organizationId: '' },
  appsIntegration: { category: 'organization', section: 'appsIntegration', organizationId: '' },
  teamMembers: { category: 'organization', section: 'teamMembers', organizationId: '' },
  membershipWallet: { category: 'organization', section: 'membershipWallet', organizationId: '' },
  usageBilling: { category: 'organization', section: 'usageBilling', organizationId: '' },
  systemCenter: { category: 'organization', section: 'systemCenter', organizationId: '' },
  // ── 团队子项（深链接：合并入 composite） ──
  general: { category: 'organization', section: 'team', organizationId: '' },
  // 注意：`notifications` 字符串深链接已改为指向「个人 → 系统通知」一级入口（见上面 profile 段）。
  // 团队侧的「通知规则」tab 仍然叫 'notifications'，但只能通过完整 route object
  // ({ category: 'organization', section: 'notifications', organizationId }) 命中，
  // 不再走 LEGACY 字符串映射——这样兼顾"裸 notifications 默认进个人偏好"的直觉。
  llm: { category: 'organization', section: 'llm', organizationId: '' },
  myUsage: { category: 'profile', section: 'myUsage' },
  apps: { category: 'organization', section: 'apps', organizationId: '' },
  extensions: { category: 'organization', section: 'extensions', organizationId: '' },
  installedExtensions: { category: 'organization', section: 'installedExtensions', organizationId: '' },
  members: { category: 'organization', section: 'members', organizationId: '' },
  memberBudget: { category: 'organization', section: 'memberBudget', organizationId: '' },
  membership: { category: 'organization', section: 'membership', organizationId: '' },
  usage: { category: 'organization', section: 'usage', organizationId: '' },
  billing: { category: 'organization', section: 'billing', organizationId: '' },
  wallet: { category: 'organization', section: 'usage', organizationId: '' },
  // 'services' 现为独立一级入口「AI 服务开关」（服务启停），与只读的 'pricing' 区分。
  services: { category: 'organization', section: 'services', organizationId: '' },
  pricing: { category: 'organization', section: 'pricing', organizationId: '' },
  storage: { category: 'organization', section: 'billing', organizationId: '' },
  storageFiles: { category: 'organization', section: 'billing', organizationId: '' },
  trashedResources: { category: 'organization', section: 'trashedResources', organizationId: '' },
  trashedSpaces: { category: 'organization', section: 'trashedSpaces', organizationId: '' },
  // 资源回收站已迁到团队设置（/#2253）：旧 Space 管理的 'trash' 深链改指团队资源回收站。
  trash: { category: 'organization', section: 'trashedResources', organizationId: '' },
  appCatalog: { category: 'organization', section: 'apps', organizationId: '' },
  // ── 旧组级路由兼容 ──
  teamSettings: DEFAULT_SETTINGS_ROUTES.organization,
  financeCenter: { category: 'organization', section: 'llm', organizationId: '' },
  billingServices: { category: 'organization', section: 'pricing', organizationId: '' },
  // ── 旧兼容 ──
  project: DEFAULT_SETTINGS_ROUTES.profile,
  // 'skills' 深链接指向全局技能库（ W3 起 Skill 库全局化，入口在「我的 AI」）
  skills: { category: 'profile', section: 'skillLibrary' },
  // 'agents' 深链接指向「我的 Agent」管理（ W2）
  agents: { category: 'profile', section: 'myAgents' },
  'agent-security': DEFAULT_SETTINGS_ROUTES.profile,
  sharing: DEFAULT_SETTINGS_ROUTES.profile,
}

export const normalizeSettingsRoute = (route?: SettingsRouteInput | string): SettingsRouteInput => {
  if (!route) return DEFAULT_SETTINGS_ROUTES.profile
  if (typeof route === 'string') {
    const mappedRoute = LEGACY_ROUTE_MAP[route] ?? DEFAULT_SETTINGS_ROUTES.profile
    return isSettingsRouteVisible(mappedRoute)
      ? mappedRoute
      : DEFAULT_SETTINGS_ROUTES[mappedRoute.category]
  }
  if (route.category === 'profile') {
    return isProfileSettingsSection(route.section) && isSettingsRouteVisible(route)
      ? route
      : DEFAULT_SETTINGS_ROUTES.profile
  }
  if (route.category === 'organization') {
    return isOrganizationSettingsSection(route.section) && isSettingsRouteVisible(route)
      ? route
      : DEFAULT_SETTINGS_ROUTES.profile
  }
  if (route.category === 'device') {
    return isDeviceSettingsSection(route.section) && isSettingsRouteVisible(route)
      ? route
      : DEFAULT_SETTINGS_ROUTES.device
  }
  return DEFAULT_SETTINGS_ROUTES.profile
}
