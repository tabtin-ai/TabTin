/**
 * SettingsSectionContext — 子面板"切换到其它 section"的统一钩子
 *
 * 历史原因：原 SpaceSettingsPane 的左导航通过 Context 把 section 与
 * `setSection` 暴露给子面板做"跳到其它 section"。该机制最初的调用方
 * （SSHPanel 里的"前往设备页"按钮）已随 SSH 迁入设备域而移除（IA Phase 1·1B），
 * 目前没有活跃调用方，但机制本身保留备用。
 * 改造为档案 + 侧边 Sheet 形态后，"切到其它 section"等价于在 Sheet 内
 * 打开新的 section，因此 setSection 由 `useAgentSettingsSheetStore.open`
 * 注入。
 *
 * 抽出独立文件是为了避免 SpaceSettingsPane ↔ AgentSettingsSheet 之间的
 * 循环依赖。
 */
import { createContext, useContext } from 'react'

export type SettingsSection = string

const defaultSetSection = () => {}

export const SettingsSectionContext = createContext<{
  section: SettingsSection
  setSection: (s: SettingsSection) => void
}>({ section: 'general', setSection: defaultSetSection })

export const useSettingsSection = () => {
  const ctx = useContext(SettingsSectionContext)
  if (process.env.NODE_ENV === 'development' && ctx.setSection === defaultSetSection) {
    console.warn('[SettingsSection] useSettingsSection called outside SettingsSectionContext.Provider')
  }
  return ctx
}
