import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { CHAT_MESSAGE_TEXT_BODY } from '../../../registry/chatDesignTokens'
import { cn } from '@utils/cn'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { motion } from 'framer-motion'

export const MSG_COLLAPSE_CHAR_THRESHOLD = 1500
export const MSG_COLLAPSED_PREVIEW_LEN = 300

//  临时禁用长消息折叠：agent 输出被收起会导致 todo 与输出结果的相对位置错乱，
// 先整体关闭「展开全文」交互，恢复时把此开关改回 true 即可（组件能力本身保留）。
export const MSG_COLLAPSE_ENABLED: boolean = false

const _expandedMessageIds = new Set<string>()
const MAX_EXPANDED_ENTRIES = 100

export const CollapsibleMessage: React.FC<{
  messageId: string
  content: string
  shouldCollapse: boolean
  onExpand?: () => void
  children: (opts: { userExpanded: boolean }) => React.ReactNode
}> = React.memo(({ messageId, content, shouldCollapse, onExpand, children }) => {
  const { t } = useTranslation('chat')
  const [isExpanded, setIsExpanded] = useState(
    () => !shouldCollapse || _expandedMessageIds.has(messageId),
  )

  useEffect(() => {
    if (!shouldCollapse) setIsExpanded(true)
  }, [shouldCollapse])

  const handleExpand = useCallback(() => {
    onExpand?.()
    setIsExpanded(true)
    _expandedMessageIds.add(messageId)
    if (_expandedMessageIds.size > MAX_EXPANDED_ENTRIES) {
      const first = _expandedMessageIds.values().next().value
      if (first !== undefined) _expandedMessageIds.delete(first)
    }
  }, [messageId, onExpand])

  const handleCollapse = useCallback(() => {
    setIsExpanded(false)
    _expandedMessageIds.delete(messageId)
  }, [messageId])

  const userExpanded = shouldCollapse && isExpanded

  const { previewText, codeBlockCount, lineCount } = useMemo(() => {
    const langs: string[] = []
    const stripped = content.replace(/```(\w*)[^\n]*\n[\s\S]*?(```|$)/g, (_, lang) => {
      if (lang) langs.push(lang)
      return ''
    })
    const text = stripped.replace(/\n{2,}/g, '\n').trim().slice(0, MSG_COLLAPSED_PREVIEW_LEN)
    const codeBlockCount = langs.length || (content.match(/```/g)?.length ?? 0) >> 1
    return {
      previewText: text,
      codeBlockCount,
      lineCount: content.split('\n').length,
    }
  }, [content])

  if (!shouldCollapse || isExpanded) {
    return (
      <div className="min-w-0 w-full">
        {userExpanded ? (
          // 只做 opacity 淡入；禁止 height:0→auto（会先缩后涨，拖偏阅读锚点 ）
          <motion.div
            data-testid="collapsible-message-transition"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            {children({ userExpanded })}
          </motion.div>
        ) : children({ userExpanded })}
        {userExpanded && (
          <button
            type="button"
            onClick={handleCollapse}
            className="mt-1 text-caption text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
          >
            {t('message.collapse', { defaultValue: '收起' })}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="relative min-w-0 w-full">
      <div className={cn('text-foreground/60 whitespace-pre-wrap line-clamp-4 break-words [overflow-wrap:anywhere]', CHAT_MESSAGE_TEXT_BODY)}>
        {previewText}{previewText.length >= MSG_COLLAPSED_PREVIEW_LEN ? '…' : ''}
      </div>
      {codeBlockCount > 0 && (
        <span className="mt-1 inline-flex items-center gap-1 rounded bg-muted/30 px-1.5 py-0.5 text-caption text-muted-foreground/60">
          {'</>'}
          <span>
            {t('message.codeBlocks', {
              count: codeBlockCount,
              defaultValue: `${codeBlockCount} 个代码块`,
            })}
          </span>
        </span>
      )}
      <button
        type="button"
        onClick={handleExpand}
        className="mt-1.5 flex items-center gap-1 text-caption font-medium text-accent/80 hover:text-accent transition-colors"
      >
        <ChevronDown className="h-3 w-3" />
        {t('message.expandFull', {
          lines: lineCount,
          defaultValue: `展开全文 (${lineCount} 行)`,
        })}
      </button>
    </div>
  )
})
CollapsibleMessage.displayName = 'CollapsibleMessage'
