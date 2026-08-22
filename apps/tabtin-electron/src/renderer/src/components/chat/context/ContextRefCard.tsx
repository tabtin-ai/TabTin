/**
 * ContextRefCard — 对话中的上下文引用预览卡片
 *
 * 可折叠，显示来源类型图标、名称、内容摘要，
 * 点击可跳转到源位置。
 */

import React, { useState } from 'react'
import { Table2, FileText, Columns3, ChevronDown, ChevronRight, ExternalLink, Presentation, Video, Globe2, FolderOpen, FileCode2, Code2, ListChecks, Boxes } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { getRefSourceLabel } from './contextRefDisplay'
import { isFileContextRefBlock } from '@utils/chat/fileContextRefBlock'

/** 消息中的引用块（从 content_blocks_json 中提取 context ref 类型） */
export interface ContextBlock {
  type?: string
  preview?: string
  table_id?: string
  doc_id?: string
  field_id?: string
  field_ids?: string[]
  record_ids?: string[]
  block_ids?: string[]
  full_text?: string
  space_id?: string
  space_name?: string
  file_path?: string
  /**  / ：云盘 TabFiles ContextRef 的 FileRecord id */
  file_id?: string
  filename?: string
  size?: number
  source?: { type?: string; url?: string; data?: string }
  root_path?: string
  language?: string
  start_line?: number
  end_line?: number
  /** ：plan 计划引用卡的名称 */
  plan_name?: string
  url?: string
  page_title?: string
  /**
   * 「Agent 产物在 Space 内的打开」机制 B 字段。
   * - resource_id：D5 自有格式资源 id（Agent → user 路径统一标识）
   * - hint_carrier_app_id：D2 第 3 层 Agent hint
   * - modifierExternal：⌘+点击 / Ctrl+点击 时为 true，走 D2 第 5 层系统应用
   *   （瞬态字段，不持久化到 content_blocks_json）
   */
  resource_id?: string
  hint_carrier_app_id?: string
  modifierExternal?: boolean
  connection_id?: string
  server_name?: string
  source_label?: string
}

interface ContextRefCardProps {
  block: ContextBlock
  /** 可选：点击跳转回调 */
  onNavigate?: (block: ContextBlock) => void
}

/** 判断一个 block 是否为上下文引用 */
export function isContextRefBlock(block: ContextBlock): boolean {
  if (typeof block.type !== 'string') return false
  // TabVideo @ 引用带 video_id；用户上传聊天附件也是 type=video，但带 file_id/url/source。
  // 二者不能共用门控，否则会多出一条「视频」黄条（ UI）。
  if (block.type === 'video') {
    const videoId = (block as { video_id?: unknown }).video_id
    return typeof videoId === 'string' && videoId.length > 0
  }
  // TabDoc @ 引用带 doc_id；LLM/上传文档附件也是 type=document（ DocumentBlock），
  // 但只有 source.url/title、无 doc_id——不能共用门控，否则切会话后多出「文档」蓝条。
  if (block.type === 'document') {
    return typeof block.doc_id === 'string' && block.doc_id.length > 0
  }
  if (block.type === 'mcp_server') {
    return typeof block.connection_id === 'string' && block.connection_id.length > 0
  }
  // ：云盘 / TabFiles @ 引用带 file_id + preview；上传附件也是 type=file，
  // 但带 filename/size/url——不能共用门控，否则发送后误画「附件 0 B」。
  if (block.type === 'file') {
    return isFileContextRefBlock(block)
  }
  // ：与 BLOCK_TYPE_TO_REF + 气泡已支持的 document/table/plan 对齐，
  // 避免 memo/whiteboard/tracker 等已落库却不渲染 ContextRef 卡。
  const refTypes = [
    'table_selection', 'doc_selection', 'table', 'field',
    'code_file', 'code_selection', 'web_selection', 'web_annotation',
    'webpage', 'slide', 'site', 'folder', 'plan', 'mcp_server',
    'memo', 'whiteboard', 'phone_device', 'desktop_device',
    'terminal_session', 'tracker', 'agenda_event',
  ]
  return refTypes.includes(block.type)
}

/** 判断引用块是否应按浏览器网页来源跳转 */
export function isWebContextRefBlock(block: ContextBlock): boolean {
  return block.type === 'web_selection' || block.type === 'web_annotation' || block.type === 'webpage'
}

/** 类型 → 图标 */
const ICONS: Record<string, React.FC<{ className?: string }>> = {
  table: Table2,
  table_selection: Table2,
  document: FileText,
  doc_selection: FileText,
  field: Columns3,
  code_file: FileCode2,
  code_selection: Code2,
  file: FileText,
  web_selection: Globe2,
  web_annotation: Globe2,
  webpage: Globe2,
  slide: Presentation,
  video: Video,
  site: Globe2,
  folder: FolderOpen,
  plan: ListChecks,
  mcp_server: Boxes,
}

/** 类型 → 颜色 */
const COLORS: Record<string, string> = {
  table: 'border-accent/30 bg-accent/5',
  table_selection: 'border-accent/30 bg-accent/5',
  document: 'border-info/30 bg-info/5',
  doc_selection: 'border-info/30 bg-info/5',
  field: 'border-warning/30 bg-warning/5',
  code_file: 'border-success/30 bg-success/5',
  code_selection: 'border-success/30 bg-success/5',
  file: 'border-success/30 bg-success/5',
  web_selection: 'border-primary/30 bg-primary/5',
  web_annotation: 'border-primary/30 bg-primary/5',
  webpage: 'border-primary/30 bg-primary/5',
  slide: 'border-info/30 bg-info/5',
  video: 'border-accent/30 bg-accent/5',
  site: 'border-primary/30 bg-primary/5',
  folder: 'border-warning/30 bg-warning/5',
  plan: 'border-primary/30 bg-primary/5',
  mcp_server: 'border-primary/30 bg-primary/5',
}

/** i18n key → type mapping (hardcoded labels removed) */
const LABEL_KEYS: Record<string, string> = {
  table: 'contextRef.table',
  table_selection: 'contextRef.tableSelection',
  document: 'contextRef.document',
  doc_selection: 'contextRef.documentSelection',
  field: 'contextRef.field',
  code_file: 'contextRef.codeFile',
  code_selection: 'contextRef.codeSelection',
  file: 'contextRef.file',
  web_selection: 'contextRef.webSelection',
  web_annotation: 'contextRef.webAnnotation',
  webpage: 'contextRef.webpage',
  slide: 'contextRef.slide',
  video: 'contextRef.video',
  site: 'contextRef.site',
  folder: 'contextRef.folder',
  plan: 'contextRef.plan',
  mcp_server: 'contextRef.mcpServer',
}

export const ContextRefCard: React.FC<ContextRefCardProps> = ({ block, onNavigate }) => {
  const { t } = useTranslation('chat')
  const [expanded, setExpanded] = useState(false)
  const typeKey = block.type ?? ''
  const Icon = ICONS[typeKey] || FileText
  const colorClass = COLORS[typeKey] || 'border-border/30 bg-muted/5'
  const label = LABEL_KEYS[typeKey] ? t(LABEL_KEYS[typeKey]) : t('contextRef.generic')
  const preview = block.preview as string || ''
  // 头部来源标识：code_file 等类型的 preview 是文件原文（含 HTML/Markdown），
  // 必须用 file_path 文件名作标题，原文只放进展开区。见 。
  const sourceLabel = getRefSourceLabel(block)

  return (
    <div className={cn('rounded-lg border text-body', colorClass)}>
      {/* 头部 */}
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-foreground/5"
        onClick={() => setExpanded(prev => !prev)}
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
        <span className="shrink-0 font-medium text-foreground/80">{label}</span>
        {block.space_name && (
          <span className="shrink-0 text-caption text-muted-foreground/40">· {block.space_name}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
          {sourceLabel}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/40" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
        )}
      </button>

      {/* 展开内容 */}
      {expanded && preview && (
        <div className="border-t border-inherit px-3 py-2 space-y-1.5">
          <ScrollArea className="max-h-[120px]">
            <pre className="whitespace-pre-wrap text-caption text-foreground/80 font-mono leading-relaxed">
              {preview}
            </pre>
          </ScrollArea>
          {onNavigate && typeKey !== 'mcp_server' && (
            <button
              type="button"
              className="flex items-center gap-1 text-caption text-accent hover:text-accent/80 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                onNavigate(block)
              }}
            >
              <ExternalLink className="h-2.5 w-2.5" />
              {t('contextRef.navigate')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** 上下文引用卡片列表（过滤 content_blocks_json 中的引用块） */
export const ContextRefCards: React.FC<{
  blocks: ContextBlock[]
  onNavigate?: (block: ContextBlock) => void
}> = ({ blocks, onNavigate }) => {
  const refBlocks = blocks.filter(isContextRefBlock)
  if (refBlocks.length === 0) return null

  return (
    <div className="space-y-1.5">
      {refBlocks.map((block, i) => (
        <ContextRefCard
          key={`ctx-${block.type}-${block.table_id || block.doc_id || block.field_id || block.file_path || block.url || block.connection_id || ''}-${i}`}
          block={block}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  )
}
