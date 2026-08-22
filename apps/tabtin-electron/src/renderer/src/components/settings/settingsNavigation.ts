import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  Building2,
  Gauge,
  HardDrive,
  Info,
  Layers,
  LayoutGrid,
  Link2,
  Sparkles,
  Users,
} from 'lucide-react'
import type { ProfileSettingsSection, OrganizationSettingsSection, DeviceSettingsSection } from '@/settings/settingsRoutes'
import { isSettingsSectionVisible } from '@/settings/settingsVisibility'
import { PROFILE_SECTION_META } from './settingsSectionMeta'

interface BaseSidebarItem<TSection extends string> {
  section: TSection
  icon: LucideIcon
  labelKey: string
}

export type SettingsSidebarItem =
  | (BaseSidebarItem<ProfileSettingsSection> & { category: 'profile' })
  | (BaseSidebarItem<OrganizationSettingsSection> & {
      category: 'organization'
      requiresOrganization: true
      /** 仅组织所有者可见（两级模型下管理入口 owner-only），由 SidebarMePanel 按当前角色过滤。 */
      ownerOnly?: true
    })
  | (BaseSidebarItem<DeviceSettingsSection> & { category: 'device' })

export interface SettingsSidebarSubgroup<TItem extends SettingsSidebarItem = SettingsSidebarItem> {
  labelKey: string | null
  items: ReadonlyArray<TItem>
}

const isSidebarItemVisible = (item: SettingsSidebarItem): boolean =>
  isSettingsSectionVisible(item.category, item.section)

const HIDDEN_PROFILE_SIDEBAR_SECTIONS: ReadonlySet<ProfileSettingsSection> = new Set([
  // Agent 与 Skill 已有主导航入口；设置侧栏不再重复展示，深链接页面继续保留。
  'myAgents',
  'skillLibrary',
])

const HIDDEN_DEVICE_SIDEBAR_SECTIONS: ReadonlySet<DeviceSettingsSection> = new Set([
  // MCP 管理已收口到「技能和连接器」；设备设置侧栏隐藏入口，深链接与能力市场继续可用。
  'advancedConnections',
])

/**
 * 设置侧栏的「主干」结构（一级导航）。
 *
 * 设计原则（参考 macOS Settings / Linear / Telegram macOS）：
 *  - 侧栏只承担「去哪儿」的职责，子项收进主面板顶部 tab
 *  - 个人/团队各自只露 5–8 项主干，二级深链接走主面板内 tab
 *  - 同一主干项内的子页面（如「账户 → 资料 / 偏好」）共享一个 route，
 *    具体子 tab 由 composite 内部维护
 */
export const SETTINGS_SIDEBAR_GROUPS: ReadonlyArray<{
  category: 'profile' | 'organization' | 'device'
  titleKey: string
  subgroups: ReadonlyArray<SettingsSidebarSubgroup>
}> = [
  {
    category: 'profile',
    titleKey: 'categories.profile',
    subgroups: [
      {
        // 个人设置打平为一级入口：个人资料 / 我的设备 / 系统权限 / 外观显示 / 语音习惯 / AI 设置。
        // 图标与标题从 PROFILE_SECTION_META 单一数据源生成，保证与内容页页眉完全一致。
        // 不再有二级 tab；连接账号与开发者凭据当前隐藏。
        labelKey: null,
        items: ((Object.entries(PROFILE_SECTION_META) as Array<
          [ProfileSettingsSection, { icon: LucideIcon; titleKey: string }]
        >).map(([section, meta]) => ({
          category: 'profile' as const,
          section,
          icon: meta.icon,
          labelKey: meta.titleKey,
        })) satisfies SettingsSidebarItem[]).filter(item => (
          isSidebarItemVisible(item) && !HIDDEN_PROFILE_SIDEBAR_SECTIONS.has(item.section)
        )),
      },
    ],
  },
  {
    category: 'organization',
    titleKey: 'categories.organization',
    subgroups: [
      {
        labelKey: null,
        items: ([
          { category: 'organization', section: 'team', icon: Building2, labelKey: 'sections.teamGroup', requiresOrganization: true },
          { category: 'organization', section: 'teamMembers', icon: Users, labelKey: 'sections.teamMembers', requiresOrganization: true },
          // 「AI 与模型」拆成两个独立入口：模型配置 / AI 成本，各自单页无 tab。
          { category: 'organization', section: 'llm', icon: Sparkles, labelKey: 'sections.organizationLlm', requiresOrganization: true },
          // 自动记忆设置位于此页：成员可读，团队 Owner 可修改；账务配置仍在页面内部保持 owner-only。
          { category: 'organization', section: 'services', icon: Layers, labelKey: 'sections.organizationServices', requiresOrganization: true },
          { category: 'organization', section: 'appsIntegration', icon: LayoutGrid, labelKey: 'sections.appsIntegration', requiresOrganization: true },
          { category: 'organization', section: 'usageBilling', icon: BarChart3, labelKey: 'sections.usageBilling', requiresOrganization: true },
          // 工作空间回收站 + 资源回收站收进「回收站」组合页，侧栏只留一个入口
          { category: 'organization', section: 'systemCenter', icon: HardDrive, labelKey: 'sections.systemCenter', requiresOrganization: true },
        ] satisfies SettingsSidebarItem[]).filter(isSidebarItemVisible),
      },
    ],
  },
  {
    category: 'device',
    titleKey: 'categories.device',
    subgroups: [
      {
        // 设备状态：只承载本机能力，不混入个人账号或团队配置。
        // 顺序：登录信息 / 存储状态 / 性能监控 / TabTin 版本（MCP 侧栏入口已隐藏）。
        labelKey: null,
        items: ([
          { category: 'device', section: 'browserSession', icon: Link2, labelKey: 'sections.loginInfo' },
          { category: 'device', section: 'storageManager', icon: HardDrive, labelKey: 'sections.storageStatus' },
          { category: 'device', section: 'performance', icon: Gauge, labelKey: 'sections.performanceMonitor' },
          // MCP 不进侧栏（走「技能和连接器」）；深链 advancedConnections 仍可用。
          // 若需临时恢复侧栏入口：取消下一行注释，并确保不在 HIDDEN_DEVICE_SIDEBAR_SECTIONS。
          // { category: 'device', section: 'advancedConnections', icon: Plug, labelKey: 'sections.mcp' },
          { category: 'device', section: 'permissionUpdate', icon: Info, labelKey: 'sections.tabtinVersion' },
        ] satisfies SettingsSidebarItem[]).filter(item => (
          isSidebarItemVisible(item) && !HIDDEN_DEVICE_SIDEBAR_SECTIONS.has(item.section)
        )),
      },
    ],
  },
] as const
