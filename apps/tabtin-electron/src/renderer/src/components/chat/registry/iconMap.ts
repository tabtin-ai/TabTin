/**
 * iconMap — Centralized mapping from icon name strings to lucide-react components.
 *
 * Used by ToolStepCard, AgentSteps, and any component that needs to resolve
 * TOOL_CARDS.icon names to actual React components. When adding a new icon
 * name to TOOL_CARDS, also add it here.
 */

import {
  Wrench, FileText, FilePenLine, FileX2, Terminal, Search, Database,
  AlertCircle, Globe, Bot, Server, PlusCircle, RefreshCw,
  Trash2, Brain, FolderTree, Sparkles,
  Calendar, UserSearch, LayoutTemplate, NotebookPen, Smartphone,
} from 'lucide-react'

type IconComponent = React.FC<{ className?: string }>

const ICON_MAP: Record<string, IconComponent> = {
  Wrench,
  FileText,
  FilePenLine,
  FileX2,
  Terminal,
  Search,
  Database,
  AlertCircle,
  Globe,
  Bot,
  Server,
  PlusCircle,
  RefreshCw,
  Trash2,
  Brain,
  FolderTree,
  Sparkles,
  Calendar,
  UserSearch,
  NotebookPen,
  Smartphone,
  // 富内容呈现重建 阶段 0：show_widget 工具卡图标——"画布/视觉化布局"语义
  LayoutTemplate,
}

const FALLBACK_ICON = Wrench

export function resolveIcon(iconName: string): IconComponent {
  return ICON_MAP[iconName] ?? FALLBACK_ICON
}

export { FALLBACK_ICON }
