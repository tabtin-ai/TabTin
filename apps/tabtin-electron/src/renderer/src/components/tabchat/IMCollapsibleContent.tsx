import React, { useCallback, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * IM 长文本的阅读预算：虚拟列表只能减少同时挂载的消息数，单条特别长的 Markdown
 * 仍会在进入视口时同步解析并阻塞滚动。因此默认仅渲染可读摘要，用户主动展开后才
 * 挂载完整内容。
 */
export const IM_COLLAPSE_CHAR_THRESHOLD = 12_000
export const IM_COLLAPSED_PREVIEW_LENGTH = 1_200

const expandedMessageIds = new Set<string>()
const MAX_REMEMBERED_EXPANDED_MESSAGES = 100

function previewContent(content: string): string {
  const preview = content.slice(0, IM_COLLAPSED_PREVIEW_LENGTH)
  const lastLineBreak = preview.lastIndexOf('\n')
  return lastLineBreak >= IM_COLLAPSED_PREVIEW_LENGTH - 300
    ? preview.slice(0, lastLineBreak)
    : preview
}

interface IMCollapsibleContentProps {
  messageKey: string
  content: string
  shouldCollapse: boolean
  children: () => React.ReactNode
}

/**
 * 保留用户已展开过的消息 id，避免 Virtuoso 回收并重新挂载该行后又折叠全文。
 * 仅保存有限数量，避免长会话无限增长本地状态。
 */
export const IMCollapsibleContent: React.FC<IMCollapsibleContentProps> = React.memo(({
  messageKey,
  content,
  shouldCollapse,
  children,
}) => {
  const { t } = useTranslation('tabchat')
  const [isExpanded, setIsExpanded] = useState(
    () => !shouldCollapse || expandedMessageIds.has(messageKey),
  )

  const expand = useCallback(() => {
    setIsExpanded(true)
    expandedMessageIds.add(messageKey)
    if (expandedMessageIds.size > MAX_REMEMBERED_EXPANDED_MESSAGES) {
      const oldest = expandedMessageIds.values().next().value
      if (oldest !== undefined) expandedMessageIds.delete(oldest)
    }
  }, [messageKey])

  const collapse = useCallback(() => {
    setIsExpanded(false)
    expandedMessageIds.delete(messageKey)
  }, [messageKey])

  if (!shouldCollapse || isExpanded) {
    return (
      <>
        {children()}
        {shouldCollapse && (
          <button
            type="button"
            onClick={collapse}
            className="mt-1.5 flex items-center gap-1 text-caption text-muted-foreground/80 transition-colors hover:text-muted-foreground"
          >
            <ChevronUp className="h-3 w-3" />
            {t('collapseLongMessage', { defaultValue: '收起' })}
          </button>
        )}
      </>
    )
  }

  const preview = previewContent(content)
  return (
    <div className="min-w-0">
      <div className="whitespace-pre-wrap break-words text-foreground/80 [overflow-wrap:anywhere]">
        {preview}{preview.length < content.length ? '…' : ''}
      </div>
      <button
        type="button"
        onClick={expand}
        className="mt-1.5 flex items-center gap-1 text-caption font-medium text-accent transition-colors hover:text-accent/80"
      >
        <ChevronDown className="h-3 w-3" />
        {t('expandLongMessage', { defaultValue: '展开全文' })}
      </button>
    </div>
  )
})

IMCollapsibleContent.displayName = 'IMCollapsibleContent'
