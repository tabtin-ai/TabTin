import React from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  Bot,
  Brain,
  Clock,
  Cloud,
  Code,
  Columns2,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Globe2,
  Home,
  LayoutDashboard,
  Presentation,
  Puzzle,
  Settings,
  Star,
  Store,
  Table,
  Terminal,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { SIDEBAR_ICON, SIDEBAR_MENU_ICON_STROKE } from './sidebarUi'

/**
 * 侧栏 / 桌面导航用的 appId / item_type → Lucide 映射。
 * 仅 ActivityRail 一级导航保留线性 SVG；App 能力入口统一走 {@link SidebarTypeEmoji}。
 * 本组件留作 chrome / 极少数仍需 Lucide 的场景。
 */
const SIDEBAR_TYPE_ICON_MAP: Record<string, LucideIcon> = {
  'cloud-resources': Cloud,
  tabdata: Table,
  table: Table,
  tabdoc: FileText,
  tabtracker: Clock,
  skill: BookOpen,
  tabweb: Globe,
  browser: Globe,
  terminal: Terminal,
  tabslide: Presentation,
  slide: Presentation,
  tabcode: Code,
  tabfolder: FolderOpen,
  folder: FolderOpen,
  bookmarks: Star,
  marketplace: Store,
  agentdiary: Brain,
  tabsettings: Settings,
  history: Clock,
  downloads: Download,
  tins: Puzzle,
  tabsite: Globe2,
  'subagent-session': Bot,
  tabfiles: Folder,
  apphome: Home,
  desktop_home: LayoutDashboard,
  orchestration: Home,
  'market-app': Store,
  cowart: Columns2,
}

const FALLBACK_SIDEBAR_ICON = Columns2

export function resolveSidebarLucideIcon(appIdOrType: string): LucideIcon {
  return SIDEBAR_TYPE_ICON_MAP[appIdOrType] ?? FALLBACK_SIDEBAR_ICON
}

export interface SidebarTypeIconProps {
  appIdOrType: string
  className?: string
  strokeWidth?: number
}

export function SidebarTypeIcon({
  appIdOrType,
  className,
  strokeWidth = SIDEBAR_MENU_ICON_STROKE,
}: SidebarTypeIconProps) {
  const Icon = resolveSidebarLucideIcon(appIdOrType)
  return <Icon className={cn(SIDEBAR_ICON, className)} strokeWidth={strokeWidth} />
}
