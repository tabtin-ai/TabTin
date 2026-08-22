import React from 'react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@components/ui'
import { SIDEBAR_SCROLLBAR_TYPE } from '@components/layout/sidebarUi'
import { SettingsPanelHeader } from './SettingsPanelHeader'
import { SettingsPanelToolbar } from './SettingsPanelToolbar'
import { SETTINGS_SCROLL_GUTTER } from './settingsUi'

interface SettingsPanelLayoutProps {
  children: React.ReactNode
  className?: string
}

const PINNED_TYPES: React.ElementType[] = [SettingsPanelHeader, SettingsPanelToolbar]
const isPinned = (node: React.ReactNode): boolean =>
  React.isValidElement(node) && PINNED_TYPES.includes(node.type as React.ElementType)

export const SettingsPanelLayout: React.FC<SettingsPanelLayoutProps> = ({ children, className }) => {
  const items = React.Children.toArray(children)
  // 钉住开头连续的「头部 / 工具栏」，使其留在滚动区域之外
  let pinnedCount = 0
  while (pinnedCount < items.length && isPinned(items[pinnedCount])) {
    pinnedCount += 1
  }
  const pinned = items.slice(0, pinnedCount)
  const rest = items.slice(pinnedCount)
  const scrollBodyClassName = cn('space-y-4 pb-4', SETTINGS_SCROLL_GUTTER)

  if (pinned.length > 0) {
    return (
      <div className={cn('flex h-full min-h-0 w-full flex-col', className)}>
        <div className="shrink-0">{pinned}</div>
        <ScrollArea className="min-h-0 flex-1" scrollBar="vertical" type={SIDEBAR_SCROLLBAR_TYPE}>
          <div className={scrollBodyClassName}>
            {rest}
          </div>
        </ScrollArea>
      </div>
    )
  }

  return (
    <div className={cn('h-full min-h-0 w-full', className)}>
      <ScrollArea className="h-full w-full" scrollBar="vertical" type={SIDEBAR_SCROLLBAR_TYPE}>
        <div className={scrollBodyClassName}>
          {children}
        </div>
      </ScrollArea>
    </div>
  )
}
