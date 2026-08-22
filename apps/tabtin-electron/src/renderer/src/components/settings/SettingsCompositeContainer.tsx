/**
 * SettingsCompositeContainer — 设置组合面板的通用顶部 tab 容器。
 *
 * 设计原则：
 *  - 子 section 的状态由 URL/store 持有（activeRoute.section = 当前子项），不在 composite 内部 useState
 *  - 切换 tab 触发 setRoute，URL 可深链
 *  - 父 section 在侧栏高亮，由 SECTION_PARENT_MAP 反查
 *  - 子 tab 用 forceMount 保活 DOM，避免首次切换时的 lazy/Suspense「重载感」
 *
 * 用法：
 *   <SettingsCompositeContainer
 *     parentSection="account"
 *     activeSubsection={resolvedSection}
 *     onSelectSubsection={(s) => setRoute({ category: 'profile', section: s })}
 *     tabs={[{ value: 'profile', label, render }, ...]}
 *   />
 */

import React from 'react'
import { TabsRoot, TabsContent } from '@components/ui'
import { cn } from '@utils/cn'
import { ChipTabBar } from '@components/common/ChipTabBar'
import { SettingsPanelHeaderFooterProvider, CompositeTabActiveProvider } from './SettingsPanelHeader'

export interface SettingsCompositeTab {
  value: string
  label: React.ReactNode
  render: () => React.ReactNode
}

interface SettingsCompositeContainerProps {
  tabs: SettingsCompositeTab[]
  /** 当前激活的子 section，受控；不在 tabs 内时回退第一个 */
  activeSubsection?: string | null
  /** 切换 tab 回调（传给上层 → setRoute） */
  onSelectSubsection: (value: string) => void
  className?: string
  /**
   * header-footer：tab 条挂在子面板 SettingsPanelHeader 下方（默认）。
   * standalone：tab 条独立渲染在容器顶部，供组合页外层已放固定页眉时使用。
   */
  tabBarPlacement?: 'header-footer' | 'standalone'
}

export const SettingsCompositeContainer: React.FC<SettingsCompositeContainerProps> = ({
  tabs,
  activeSubsection,
  onSelectSubsection,
  className,
  tabBarPlacement = 'header-footer',
}) => {
  const fallback = tabs[0]?.value ?? ''
  const value = tabs.some((tab) => tab.value === activeSubsection)
    ? (activeSubsection as string)
    : fallback
  const tabBar = (
    <ChipTabBar
      items={tabs.map((tab) => ({ value: tab.value, label: tab.label }))}
      value={value}
      onValueChange={onSelectSubsection}
    />
  )

  const tabPanels = (
    <TabsRoot value={value} onValueChange={onSelectSubsection} className={cn('h-full min-h-0', className)}>
      {tabs.map((tab) => (
        <TabsContent
          key={tab.value}
          value={tab.value}
          forceMount
          className="h-full min-h-0 focus-visible:outline-none data-[state=inactive]:hidden"
        >
          <CompositeTabActiveProvider value={tab.value === value}>
            {tab.render()}
          </CompositeTabActiveProvider>
        </TabsContent>
      ))}
    </TabsRoot>
  )

  if (tabBarPlacement === 'standalone') {
    return (
      <div className={cn('min-h-0', className)}>
        <div className="mb-4 shrink-0">{tabBar}</div>
        {tabPanels}
      </div>
    )
  }

  return (
    <SettingsPanelHeaderFooterProvider value={tabBar}>
      {tabPanels}
    </SettingsPanelHeaderFooterProvider>
  )
}
