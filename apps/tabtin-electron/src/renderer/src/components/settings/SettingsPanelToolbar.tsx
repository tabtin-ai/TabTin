import React from 'react'
import { cn } from '@utils/cn'

interface SettingsPanelToolbarProps {
  children: React.ReactNode
  className?: string
}

/**
 * 固定在面板头部下方、滚动区域之外的工具栏（搜索、筛选等）。
 * 由 SettingsPanelLayout 识别并钉在滚动区外，使其不随内容列表滚动。
 */
export const SettingsPanelToolbar: React.FC<SettingsPanelToolbarProps> = ({ children, className }) => (
  <div className={cn('mb-4', className)}>{children}</div>
)
