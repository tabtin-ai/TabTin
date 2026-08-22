/**
 * DocumentRefChip — 文档引用标签
 *
 * 在 AI 回复中展示 document_ref block，
 * 点击可跳转到 PDF 对应页面并高亮 bbox 区域。
 */

import React from 'react'
import { FileText } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@tabtin/chat-client'

interface DocumentRefChipProps {
  block: MessageBlock
  onClick?: (block: MessageBlock) => void
  className?: string
}

export const DocumentRefChip: React.FC<DocumentRefChipProps> = ({
  block,
  onClick,
  className,
}) => {
  const { t } = useTranslation('chat')
  const hasPage = typeof block.page_number === 'number'
  const hasBbox = Array.isArray(block.bbox) && block.bbox.length === 4

  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border/30',
        'bg-muted/10 px-2.5 py-1 text-caption text-muted-foreground',
        'hover:bg-accent/10 hover:border-accent/30 hover:text-foreground',
        'transition-colors cursor-pointer max-w-[280px]',
        className,
      )}
      onClick={() => onClick?.(block)}
      title={block.ref_text || block.label || t('documentRef.title')}
    >
      <FileText className="h-3 w-3 flex-shrink-0 text-accent/60" />
      <span className="truncate">
        {block.label || (hasPage ? `p${block.page_number}` : t('documentRef.label'))}
      </span>
      {hasBbox && (
        <span className="flex-shrink-0 h-1.5 w-1.5 rounded-full bg-accent/40" />
      )}
    </button>
  )
}

interface DocumentRefListProps {
  blocks: MessageBlock[]
  onRefClick?: (block: MessageBlock) => void
  className?: string
}

export const DocumentRefList: React.FC<DocumentRefListProps> = ({
  blocks,
  onRefClick,
  className,
}) => {
  const refs = blocks.filter(b => b.type === 'document_ref')
  if (refs.length === 0) return null

  return (
    <div className={cn('flex flex-wrap gap-1.5 mt-2', className)}>
      {refs.map((ref, i) => (
        <DocumentRefChip
          key={`doc-${ref.label || ''}-${ref.page_number ?? ''}-${i}`}
          block={ref}
          onClick={onRefClick}
        />
      ))}
    </div>
  )
}

DocumentRefChip.displayName = 'DocumentRefChip'
DocumentRefList.displayName = 'DocumentRefList'
