import React from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsPanelHeader } from './SettingsPanelHeader'
import { PROFILE_SECTION_META, type ProfileMetaSection } from './settingsSectionMeta'

interface SettingsSectionHeaderProps {
  /** 个人设置一级入口。图标与标题从 PROFILE_SECTION_META 单一数据源读取，与侧栏同源。 */
  section: ProfileMetaSection
  subtitle?: React.ReactNode
  meta?: React.ReactNode
}

/**
 * 个人设置页统一页眉：标题 / 图标由 PROFILE_SECTION_META 供给，保证与侧栏入口一致。
 * 各面板只提供副标题与右侧 meta 动作，不再自造标题。
 */
export const SettingsSectionHeader: React.FC<SettingsSectionHeaderProps> = ({
  section,
  subtitle,
  meta,
}) => {
  const { t } = useTranslation('settings')
  const { icon: Icon, titleKey } = PROFILE_SECTION_META[section]
  return (
    <SettingsPanelHeader
      icon={<Icon className="h-6 w-6" />}
      title={t(titleKey)}
      subtitle={subtitle}
      meta={meta}
    />
  )
}
