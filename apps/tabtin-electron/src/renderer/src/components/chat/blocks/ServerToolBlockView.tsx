/**
 * ServerToolBlockView — Anthropic 服务端工具家族（v2 §3.5.1.e 第 5 行 Web family）。
 *
 * 承载 5 种 block.type：
 *   - server_tool_use（assistant 端 — Anthropic 服务端工具调用）
 *   - web_search_tool_result（server tool 嵌入结果）
 *   - code_execution_tool_result（Claude 4 Code Interpreter）
 *   - bash_code_execution_tool_result（Claude 4 Bash 工具）
 *   - text_editor_code_execution_tool_result（Claude 4 文件编辑工具）
 *
 * 视觉跟 ToolUseBlockView 类似但加 **"Anthropic 服务端" 标识**——让用户清楚
 * 区分 "本机执行" vs "服务端执行"（v2 §3.5.1.e）。
 */

import React, { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, ChevronDown, ChevronRight } from 'lucide-react'
import type {
  ServerToolUseBlock,
} from '@tabtin/agent-wire'
import { cn } from '@utils/cn'
import {
  CARD_RADIUS,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  ICON_SIZE,
  TAG,
} from '../registry/chatDesignTokens'
import { getToolDisplayName } from '../registry/toolDisplayName'
import { blockEntryEqual, type BlockRendererProps } from './types'
import { SearchResultList, type SearchResultItem } from '../cards/primitives'

interface WebSearchResult {
  title?: string
  url?: string
  page_age?: string
}

function webSearchResultItems(content: unknown): SearchResultItem[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return []
    const result = candidate as WebSearchResult & { type?: string }
    if (result.type !== 'web_search_result' || typeof result.url !== 'string') return []
    return [{
      key: `${result.url}-${index}`,
      title: result.title || result.url,
      subtitle: result.url,
      preview: result.page_age,
    }]
  })
}

const ServerToolUseView: React.FC<Pick<BlockRendererProps, 'entry' | 'siblingToolResult'>> = ({
  entry,
  siblingToolResult,
}) => {
  const { t } = useTranslation('chat')
  const block = entry.block as ServerToolUseBlock
  const [expanded, setExpanded] = useState(false)
  const toolName = block.name ?? 'web_search'
  const label = getToolDisplayName(t, toolName)
  const resultItems = useMemo(
    () => webSearchResultItems(siblingToolResult?.content),
    [siblingToolResult?.content],
  )
  return (
    <div
      className={cn(
        'my-1 border',
        CARD_RADIUS,
        BORDER.subtle,
        BG.header,
      )}
      data-testid="block-server-tool-use"
    >
      <button
        type="button"
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1 transition-colors hover:bg-foreground/5',
          CARD_RADIUS,
        )}
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronDown className={cn(ICON_SIZE.sm, 'flex-shrink-0')} />
          : <ChevronRight className={cn(ICON_SIZE.sm, 'flex-shrink-0')} />}
        <Globe className={cn(ICON_SIZE.md, TAG.icon, 'flex-shrink-0')} />
        <span className={cn(TEXT.body, TEXT_COLOR.secondary, 'min-w-0 truncate')}>{label}</span>
        <span
          className={cn(
            'inline-flex items-center px-1.5 py-0.5 rounded',
            TAG.bg,
            TAG.text,
            TEXT.meta,
            'flex-shrink-0',
          )}
        >
          {t('blockTimeline.serverTool.badge', { defaultValue: 'Anthropic 服务端' })}
        </span>
        {resultItems.length > 0 && (
          <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-auto flex-shrink-0')}>
            {t('card.result_count', { count: resultItems.length })}
          </span>
        )}
      </button>
      {expanded && (block.input || resultItems.length > 0) && (
        <div className={cn('border-t', BORDER.subtle, 'px-2.5 py-1.5')}>
          {block.input && (
            <pre className={cn('max-h-[200px] overflow-auto whitespace-pre-wrap break-all', TEXT.code, TEXT_COLOR.muted)}>
              {JSON.stringify(block.input, null, 2)}
            </pre>
          )}
          {resultItems.length > 0 && <SearchResultList items={resultItems} maxHeight="md" />}
        </div>
      )}
    </div>
  )
}
ServerToolUseView.displayName = 'ServerToolUseView'

const CodeExecutionResultView: React.FC<{ entry: BlockRendererProps['entry']; label: string }> = ({ entry, label }) => {
  const block = entry.block as { type: string; content?: unknown }
  const [expanded, setExpanded] = useState(false)
  const display = useMemo(() => {
    const c = block.content
    if (typeof c === 'string') return c
    if (c === null || c === undefined) return ''
    try {
      return JSON.stringify(c, null, 2)
    } catch {
      return String(c)
    }
  }, [block.content])
  return (
    <div
      className={cn('my-1 border', CARD_RADIUS, BORDER.subtle, BG.header)}
      data-testid="block-code-execution-result"
    >
      <button
        type="button"
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1 transition-colors hover:bg-foreground/5',
          CARD_RADIUS,
        )}
        onClick={() => setExpanded((p) => !p)}
        aria-expanded={expanded}
      >
        {expanded
          ? <ChevronDown className={cn(ICON_SIZE.sm, 'flex-shrink-0')} />
          : <ChevronRight className={cn(ICON_SIZE.sm, 'flex-shrink-0')} />}
        <Globe className={cn(ICON_SIZE.md, TAG.icon, 'flex-shrink-0')} />
        <span className={cn(TEXT.body, TEXT_COLOR.secondary, 'min-w-0 truncate')}>{label}</span>
      </button>
      {expanded && (
        <div className={cn('border-t', BORDER.subtle, 'px-2.5 py-1.5')}>
          <pre className={cn('max-h-[300px] overflow-auto whitespace-pre-wrap break-all', TEXT.code, TEXT_COLOR.muted)}>
            {display}
          </pre>
        </div>
      )}
    </div>
  )
}
CodeExecutionResultView.displayName = 'CodeExecutionResultView'

export const ServerToolBlockView: React.FC<BlockRendererProps> = React.memo((props) => {
  const { t } = useTranslation('chat')
  const block = props.entry.block
  switch (block.type) {
    case 'server_tool_use':
      return (
        <ServerToolUseView
          entry={props.entry}
          siblingToolResult={props.siblingToolResult}
        />
      )
    case 'web_search_tool_result':
      return null
    case 'code_execution_tool_result':
      return <CodeExecutionResultView entry={props.entry} label={t('blockTimeline.serverTool.codeExecution', { defaultValue: 'Code execution' })} />
    case 'bash_code_execution_tool_result':
      return <CodeExecutionResultView entry={props.entry} label={t('blockTimeline.serverTool.bashExecution', { defaultValue: 'Bash execution' })} />
    case 'text_editor_code_execution_tool_result':
      return <CodeExecutionResultView entry={props.entry} label={t('blockTimeline.serverTool.textEditor', { defaultValue: 'Text editor' })} />
    default:
      return null
  }
}, blockEntryEqual)
ServerToolBlockView.displayName = 'ServerToolBlockView'
