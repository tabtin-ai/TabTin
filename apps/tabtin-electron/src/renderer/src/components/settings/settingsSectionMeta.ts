import type { LucideIcon } from 'lucide-react'
import { Bot, CircleUserRound, Library, Mic, Monitor, Palette, ShieldCheck, Sparkles } from 'lucide-react'
import type { ProfileSettingsSection } from '@/settings/settingsRoutes'

export interface SettingsSectionMeta {
  icon: LucideIcon
  /** settings 命名空间下的标题 key，侧栏入口与页面页眉共用，保证「侧栏 = 内容标题」一致。 */
  titleKey: string
}

/**
 * 个人设置一级入口的**单一元数据源**。
 *
 * 侧栏导航（settingsNavigation）与页面页眉（SettingsSectionHeader）都从这里读取图标与标题，
 * 不允许各面板再自造标题 / 图标——这样标题永远与侧栏一致，图标风格也统一。
 * 顺序即侧栏展示顺序：个人资料 / 我的设备 / 系统权限 / 外观显示 / 语音习惯 / AI 设置。
 * `notifications` 入口承载「系统权限」页（上半系统通知分类、下半 OS 系统权限）。
 */
export const PROFILE_SECTION_META = {
  account: { icon: CircleUserRound, titleKey: 'sections.profile' },
  devices: { icon: Monitor, titleKey: 'sections.accountDevices' },
  notifications: { icon: ShieldCheck, titleKey: 'sections.systemPermissions' },
  language: { icon: Palette, titleKey: 'sections.appearanceDisplay' },
  voice: { icon: Mic, titleKey: 'sections.voiceHabits' },
  myAI: { icon: Sparkles, titleKey: 'sections.aiSettings' },
  myAgents: { icon: Bot, titleKey: 'sections.myAgents' },
  skillLibrary: { icon: Library, titleKey: 'sections.skillLibrary' },
} satisfies Partial<Record<ProfileSettingsSection, SettingsSectionMeta>>

export type ProfileMetaSection = keyof typeof PROFILE_SECTION_META
