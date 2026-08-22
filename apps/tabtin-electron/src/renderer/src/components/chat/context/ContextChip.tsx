/* eslint-disable tabtin/no-chat-design-violations -- 上下文类型身份色板（表格=accent / 文档=info / 代码=success / 字段=warning…），每种资源类型一个签名色，等同文件类型识别色，整套保留才能一眼区分引用类型，非单点 UI 警示 */
/**
 * ContextChip — 上下文引用标签
 *
 * 在输入框上方展示已添加的上下文引用（@提及、表格选区、文档选区等），
 * 可删除，发送消息后自动清除。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { X, Table2, FileText, Columns3, SquareMousePointer, FileCode2, Code2, Presentation, Video, Globe2, FolderOpen, StickyNote, Lightbulb, Smartphone, Monitor, Terminal as TerminalIcon, Activity, Calendar, Crop, MessageSquareText, Boxes } from 'lucide-react'
import { cn } from '@utils/cn'
import type { ContextRef, ContextRefType } from '../types'

interface ContextChipProps {
  ref_: ContextRef
  onRemove: (id: string) => void
}

/** 类型 → 图标 */
const ICONS: Record<ContextRefType, React.FC<{ className?: string }>> = {
  table: Table2,
  document: FileText,
  field: Columns3,
  table_selection: SquareMousePointer,
  doc_selection: FileText,
  code_file: FileCode2,
  code_selection: Code2,
  web_selection: Globe2,
  web_annotation: Crop,
  slide: Presentation,
  video: Video,
  site: Globe2,
  folder: FolderOpen,
  // 「Agent 产物在 Space 内的打开」manifest opens 配套类型
  file: FolderOpen,
  email_thread: FileText,
  webpage: Globe2,
  memo: StickyNote,
  whiteboard: Lightbulb,
  phone_device: Smartphone,
  desktop_device: Monitor,
  terminal_session: TerminalIcon,
  tracker: Activity,
  agenda_event: Calendar,
  mcp_server: Boxes,
  conversation_reference: MessageSquareText,
}

/** 类型 → 配色 */
const COLORS: Record<ContextRefType, string> = {
  table: 'bg-accent/10 text-accent',
  document: 'bg-info/10 text-info',
  field: 'bg-warning/10 text-warning',
  table_selection: 'bg-accent/10 text-accent',
  doc_selection: 'bg-info/10 text-info',
  code_file: 'bg-success/10 text-success',
  code_selection: 'bg-success/10 text-success',
  web_selection: 'bg-primary/10 text-primary',
  web_annotation: 'bg-primary/10 text-primary',
  slide: 'bg-info/10 text-info',
  video: 'bg-accent/10 text-accent',
  site: 'bg-primary/10 text-primary',
  folder: 'bg-warning/10 text-warning',
  file: 'bg-warning/10 text-warning',
  email_thread: 'bg-info/10 text-info',
  webpage: 'bg-primary/10 text-primary',
  memo: 'bg-warning/10 text-warning',
  whiteboard: 'bg-accent/10 text-accent',
  phone_device: 'bg-info/10 text-info',
  desktop_device: 'bg-info/10 text-info',
  terminal_session: 'bg-success/10 text-success',
  tracker: 'bg-warning/10 text-warning',
  agenda_event: 'bg-info/10 text-info',
  mcp_server: 'bg-primary/10 text-primary',
  conversation_reference: 'bg-primary/10 text-primary',
}

/** 类型 → 标签前缀 */
const PREFIXES: Record<ContextRefType, string> = {
  table: '@表格',
  document: '@文档',
  field: '@字段',
  table_selection: '选区',
  doc_selection: '选区',
  code_file: '@代码',
  code_selection: '代码选区',
  web_selection: '网页选区',
  web_annotation: '网页注释',
  slide: '@演示文稿',
  video: '@视频',
  site: '@站点',
  folder: '@文件夹',
  file: '@文件',
  email_thread: '@邮件',
  webpage: '@网页',
  memo: '@笔记',
  whiteboard: '@画板',
  phone_device: '@手机',
  desktop_device: '@桌面',
  terminal_session: '@终端',
  tracker: '@追踪器',
  agenda_event: '@日程',
  mcp_server: '@MCP',
  conversation_reference: '引用对话',
}

/**
 * 「片段引用」类型集合：用户引用的是 tab 资源里的一个局部（选区/字段），
 * 而不是整个 tab。chip 上叠加 Crop 角标视觉提示，让用户一眼区分
 * 「Agent 拿到的是片段还是整体」。
 */
const SELECTION_TYPES: ReadonlySet<ContextRefType> = new Set<ContextRefType>([
  'table_selection',
  'doc_selection',
  'code_selection',
  'web_selection',
  'web_annotation',
  'field',
])

export const ContextChip: React.FC<ContextChipProps> = ({ ref_, onRemove }) => {
  const { t } = useTranslation('chat')
  const Icon = ICONS[ref_.type] || FileText
  const colorClass = COLORS[ref_.type] || 'bg-muted/10 text-foreground'
  const fallbackPrefix = PREFIXES[ref_.type] || '@'
  const prefix = t(`contextChip.prefix.${ref_.type}`, { defaultValue: fallbackPrefix })
  const preview = (ref_.meta?.preview as string) || ''
  const isSelection = SELECTION_TYPES.has(ref_.type)

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-body font-medium',
        colorClass
      )}
      title={preview || ref_.label}
    >
      <div className="relative flex-shrink-0">
        <Icon className="h-3 w-3" />
        {isSelection && (
          <Crop
            className="h-2 w-2 absolute -bottom-0.5 -right-0.5 bg-background rounded-full p-0.5"
            aria-label="片段引用"
          />
        )}
      </div>
      <span className="truncate max-w-[160px]">
        {prefix} {ref_.label}
      </span>
      {ref_.spaceName && (
        <span className="text-caption opacity-60 truncate max-w-[80px]">· {ref_.spaceName}</span>
      )}
      <button
        type="button"
        onClick={() => onRemove(ref_.id)}
        className="flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-foreground/10 transition-colors"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  )
}

/** 上下文引用列表 */
export const ContextChipList: React.FC<{
  refs: ContextRef[]
  onRemove: (id: string) => void
}> = ({ refs, onRemove }) => {
  if (refs.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5 pb-1">
      {refs.map(ref_ => (
        <ContextChip key={ref_.id} ref_={ref_} onRemove={onRemove} />
      ))}
    </div>
  )
}
