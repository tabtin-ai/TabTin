/**
 * CodeBlock — reusable code display primitive with line numbers and copy.
 *
 * Renders monospace text with optional line numbers, line-range highlighting,
 * and a copy-to-clipboard button. Intended as a building block for tool cards
 * like FileReadCard, CodeSearchCard, etc.
 */

import React, { useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  CARD_MAX_HEIGHT,
  ICON_SIZE,
} from '../../registry/chatDesignTokens'
import { safeCopyToClipboard } from '../../utils/clipboard'
import { HighlightedCode, langFromFileName } from '../../utils/highlightCode'
import { ChatIconTooltip } from '../../panel/ChatIconTooltip'

export interface CodeBlockProps {
  /** The code content to display */
  code: string
  /** Language hint for display label (e.g. "typescript", "bash") — not used for highlighting yet */
  language?: string
  /** Show line numbers */
  showLineNumbers?: boolean
  /** First line number (1-indexed) */
  startLine?: number
  /** Set of line numbers to highlight (1-indexed, absolute) */
  highlightLines?: Set<number>
  /** Max height token key */
  maxHeight?: keyof typeof CARD_MAX_HEIGHT
  /** Use dark terminal style instead of code style */
  terminal?: boolean
  /** Optional header label (e.g. file path) */
  label?: string
  /** Optional header icon */
  icon?: React.ReactNode
  /** Wrap long lines instead of horizontal scroll */
  wrap?: boolean
}

const CodeBlock: React.FC<CodeBlockProps> = React.memo(
  ({
    code,
    language,
    showLineNumbers = false,
    startLine = 1,
    highlightLines,
    maxHeight = 'md',
    terminal = false,
    label,
    icon,
    wrap = true,
  }) => {
    const { t } = useTranslation('chat')
    const [copied, setCopied] = useState(false)

    const lines = useMemo(() => code.split('\n'), [code])

    // 语法高亮语言：终端输出不高亮；否则按文件名（label）后缀推，退而用 language 提示。
    const hlLang = useMemo(
      () => (terminal ? undefined : (langFromFileName(label) ?? language)),
      [terminal, label, language],
    )

    // 行号列宽自适应：旧实现写死 `w-8` (32px)，文件 1000+ 行时 4 位行号会撞到
    // 内容列。改成按最大行号位数计算 `ch` 单位（2 位起步保留视觉对齐感，
    // 末尾 +1ch 留空避免贴边）。
    const lineNumStyle: React.CSSProperties = useMemo(() => {
      if (!showLineNumbers) return {}
      const maxLineNum = startLine + lines.length - 1
      const digits = Math.max(2, String(Math.max(1, maxLineNum)).length) + 1
      return { width: `${digits}ch` }
    }, [showLineNumbers, startLine, lines.length])

    const handleCopy = useCallback(() => {
      safeCopyToClipboard(code, () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    }, [code])

    const bgClass = terminal ? BG.terminal : BG.code

    return (
      <div className={cn(CARD_RADIUS, 'relative group border overflow-hidden', BORDER.default)}>
        {/* Optional header */}
        {(label || language) && (
          <div
            className={cn(
              'flex min-w-0 items-center gap-1.5',
              CARD_HEADER_PADDING.x,
              CARD_HEADER_PADDING.y,
              BG.header,
              'border-b',
              BORDER.subtle,
            )}
          >
            {icon}
            {label && (
              <span className={cn(TEXT.code, TEXT_COLOR.secondary, 'min-w-0 flex-1 truncate')} title={label}>
                {label}
              </span>
            )}
            {language && !label && (
              <span className={cn(TEXT.meta, TEXT_COLOR.muted)}>{language}</span>
            )}
            <span className="ml-auto shrink-0 flex items-center gap-1.5">
              {language && label && (
                <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>{language}</span>
              )}
              <ChatIconTooltip content={t('card.copy_code')}>
                <button
                  type="button"
                  onClick={handleCopy}
                  className={cn(
                    'p-0.5 rounded hover:bg-muted/30 transition-colors',
                    TEXT_COLOR.muted,
                  )}
                  aria-label={t('card.copy_code')}
                >
                  {copied ? (
                    <Check className={cn(ICON_SIZE.sm, 'text-success')} />
                  ) : (
                    <Copy className={ICON_SIZE.sm} />
                  )}
                </button>
              </ChatIconTooltip>
            </span>
          </div>
        )}

        {/* Code body */}
        <ScrollArea className={cn(bgClass, CARD_MAX_HEIGHT[maxHeight])} scrollBar="both">
          {/* hlLang 命中时挂 tabtin-code-hl 作用域，让 hljs token 着色生效 */}
          <div className={cn('px-2 py-1.5', hlLang && 'tabtin-code-hl')}>
            {lines.map((line, i) => {
              const lineNum = startLine + i
              const isHighlighted = highlightLines?.has(lineNum)
              return (
                <div
                  key={i}
                  className={cn(
                    'flex',
                    TEXT.code,
                    'leading-[18px]',
                    isHighlighted && 'bg-accent/10',
                  )}
                >
                  {showLineNumbers && (
                    <span
                      className={cn(
                        'inline-block text-right shrink-0 pr-2 select-none tabular-nums',
                        TEXT_COLOR.faint,
                      )}
                      style={lineNumStyle}
                    >
                      {lineNum}
                    </span>
                  )}
                  <span
                    className={cn(
                      TEXT_COLOR.secondary,
                      'min-w-0',
                      wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
                    )}
                  >
                    {line ? <HighlightedCode code={line} lang={hlLang} /> : ' '}
                  </span>
                </div>
              )
            })}
          </div>
        </ScrollArea>

        {/* Copy button when no header */}
        {!label && !language && (
          <div
            className={cn(
              'absolute top-1 right-1',
              'opacity-0 group-hover:opacity-100 transition-opacity',
            )}
          >
            <ChatIconTooltip content={t('card.copy_code')}>
              <button
                type="button"
                onClick={handleCopy}
                className={cn(
                  'p-1 rounded bg-muted/40 hover:bg-muted/80 transition-colors',
                  TEXT_COLOR.muted,
                )}
                aria-label={t('card.copy_code')}
              >
                {copied ? (
                  <Check className={cn(ICON_SIZE.sm, 'text-success')} />
                ) : (
                  <Copy className={ICON_SIZE.sm} />
                )}
              </button>
            </ChatIconTooltip>
          </div>
        )}
      </div>
    )
  },
)

CodeBlock.displayName = 'CodeBlock'

export { CodeBlock }
export default CodeBlock
