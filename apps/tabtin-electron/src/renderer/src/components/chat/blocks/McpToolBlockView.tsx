/**
 * McpToolBlockView — MCP 协议工具家族（v2 §3.5.1.e 第 7 行）。
 *
 * 承载 2 种 block.type：
 *   - mcp_tool_use（assistant；MCP connector 调用）
 *   - mcp_tool_result（user；MCP connector 结果）
 *
 * UI 通用 JSON 视图 + MCP server 标识：让用户清楚知道这是远端 MCP server
 * 提供的工具（不是 TabTin 内置 / Anthropic 服务端工具）。
 *
 * **W4c · W4b P1-c**：MCP tool_use 与常规 tool_use 对齐 partial parse 流式逻辑。
 * 流式期间 `block.input={}`，真实 JSON 在 `entry.pendingInputJson` 累积；本组件
 * 在 finalize 前优先用 pendingInputJson 走 `tryParsePartialJson` 兜底显示，
 * 让用户看到"正在生成参数…"的实时进展，而非空 JSON。
 */

import React, { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Plug, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react'
import { cn } from '@utils/cn'
import { useSessionBlocksRecord } from '@stores/chat/messages/messageBlocks'
import {
  CARD_RADIUS,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  ICON_SIZE,
  TAG,
} from '../registry/chatDesignTokens'
import {
  blockEntryEqual,
  partialReasonText,
  tryParsePartialJson,
  type BlockRendererProps,
  type ContentBlockEntry,
} from './types'
import { ShinyText } from '../markdown/ShinyText'

type McpToolUse = {
  type: 'mcp_tool_use'
  id: string
  name: string
  server_name: string
  input: Record<string, unknown>
}

function findMcpToolResult(
  sessionBlocks: Record<string, ContentBlockEntry[]> | undefined,
  toolCallId: string,
): { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean } | undefined {
  if (!sessionBlocks) return undefined
  for (const messageBlocks of Object.values(sessionBlocks)) {
    for (const e of messageBlocks) {
      const blk = e.block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean } | null
      if (blk?.type === 'mcp_tool_result' && blk.tool_use_id === toolCallId) {
        return blk
      }
    }
  }
  return undefined
}

const McpToolUseView: React.FC<{
  entry: BlockRendererProps['entry']
  sessionId: string | null
  siblingToolResult?: BlockRendererProps['siblingToolResult']
  suppressPartialReason?: boolean
}> = ({ entry, sessionId, siblingToolResult, suppressPartialReason }) => {
  const { t } = useTranslation('chat')
  const block = entry.block as McpToolUse
  const toolCallId = block.id ?? entry.block_id
  const [expanded, setExpanded] = useState(false)
  const toolLabel = t('blockTimeline.mcp.toolUse', { defaultValue: 'MCP 工具' })

  // W4c · W4b P1-c：流式期间用 pendingInputJson 兜底；finalize 后用 block.input
  const effectiveInput = useMemo(() => {
    if (entry.finalized) return block.input as unknown
    if (entry.pendingInputJson && entry.pendingInputJson.length > 0) {
      return tryParsePartialJson(entry.pendingInputJson)
    }
    return block.input as unknown
  }, [entry.finalized, entry.pendingInputJson, block.input])

  // partial JSON 解析后类型可能是字符串（fallback 原始片段）或对象——
  // 字符串走 pre 文本；对象走 JSON.stringify 美化展示。
  const inputDisplay = useMemo(() => {
    if (effectiveInput == null) return null
    if (typeof effectiveInput === 'string') return effectiveInput
    try {
      return JSON.stringify(effectiveInput, null, 2)
    } catch {
      return String(effectiveInput)
    }
  }, [effectiveInput])
  const hasInput = inputDisplay != null && inputDisplay.length > 0
  //  阶段 6：已提交块在 messages 层，订阅 session 块记录作重算触发器（ 改自裸 version）。
  const blocksRecord = useSessionBlocksRecord(sessionId)
  const storedMcpResult = useMemo(() => {
    if (!sessionId || !entry.finalized || !toolCallId) return undefined
    return findMcpToolResult(blocksRecord, toolCallId)
  }, [sessionId, entry.finalized, toolCallId, blocksRecord])
  const resultContent = siblingToolResult?.content ?? storedMcpResult?.content
  const resultDisplay = useMemo(() => flattenMcpResultContent(resultContent), [resultContent])
  const resultIsError = siblingToolResult?.isError === true || storedMcpResult?.is_error === true
  const hasResult = resultDisplay.length > 0 || resultIsError

  useEffect(() => {
    if (resultIsError) setExpanded(true)
  }, [resultIsError])

  // input_parse_error fallback（与 ToolUseBlockView 一致）：parse 失败时
  // 显示告警 + raw partial JSON，避免 JSON.stringify(损坏对象) 二次崩溃。
  if (entry.parseError) {
    return (
      <div
        className={cn(
          'my-1 border px-3 py-2',
          CARD_RADIUS,
          'border-warning/40',
          'bg-warning/5',
        )}
        data-testid="block-mcp-tool-use-parse-error"
      >
        <div className={cn('flex items-center gap-1.5', TEXT.body, TEXT_COLOR.errorSoft)}>
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate">
            {t('blockTimeline.mcp.parseError', {
              name: toolLabel,
              defaultValue: `${toolLabel}调用参数损坏`,
            })}
          </span>
        </div>
        <pre
          className={cn(
            'mt-1 ml-5 max-h-[120px] overflow-auto whitespace-pre-wrap break-all',
            TEXT.code,
            TEXT_COLOR.muted,
          )}
        >
          {entry.parseError.partial}
        </pre>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'my-1 border',
        CARD_RADIUS,
        resultIsError ? BORDER.error : BORDER.subtle,
        resultIsError ? 'bg-destructive/5' : BG.header,
      )}
      data-testid="block-mcp-tool-use"
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
        <Plug className={cn(ICON_SIZE.md, TAG.icon, 'flex-shrink-0')} />
        <span className={cn(TEXT.body, TEXT_COLOR.secondary, 'min-w-0 truncate')}>{toolLabel}</span>
        {resultIsError && (
          <AlertCircle className={cn(ICON_SIZE.status, 'text-destructive flex-shrink-0')} />
        )}
        <span
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded',
            TAG.bg,
            TAG.text,
            TEXT.meta,
            'flex-shrink-0',
          )}
          title={t('blockTimeline.mcp.serverTooltip', { defaultValue: 'MCP 服务器名' })}
        >
          {t('blockTimeline.mcp.serverPrefix', { defaultValue: 'MCP:' })}
          <span className="font-mono">{block.server_name}</span>
        </span>
        {!entry.finalized && !(entry.pendingInputJson && entry.pendingInputJson.length > 0) && (
          <ShinyText className={cn(TEXT.meta, 'flex-shrink-0')}>
            {t('blockTimeline.mcp.calling', { defaultValue: '正在调用…' })}
          </ShinyText>
        )}
      </button>
      {expanded && (hasInput || hasResult) && (
        <div className={cn('border-t', BORDER.subtle, 'px-2.5 py-1.5 space-y-2')}>
          {hasInput && (
            <div>
              <div className={cn(TEXT.label, TEXT_COLOR.muted, 'mb-0.5')}>
                {t('card.generic_params', { defaultValue: '参数' })}
              </div>
              <pre className={cn('max-h-[200px] overflow-auto whitespace-pre-wrap break-all', TEXT.code, TEXT_COLOR.muted)}>
                {inputDisplay}
              </pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className={cn(TEXT.label, resultIsError ? TEXT_COLOR.errorSoft : TEXT_COLOR.muted, 'mb-0.5')}>
                {resultIsError
                  ? t('blockTimeline.mcp.resultError', { defaultValue: 'MCP 工具结果（失败）' })
                  : t('blockTimeline.mcp.result', { defaultValue: 'MCP 工具结果' })}
              </div>
              <pre className={cn('max-h-[400px] overflow-auto whitespace-pre-wrap break-all', TEXT.code, TEXT_COLOR.secondary)}>
                {resultDisplay || t('blockTimeline.toolResult.errorNoBody', { defaultValue: '错误信息不可用' })}
              </pre>
            </div>
          )}
        </div>
      )}
      {!entry.finalized && entry.pendingInputJson && entry.pendingInputJson.length > 0 && (
        <div className={cn('border-t', BORDER.subtle, 'px-2.5 py-1', TEXT.meta)}>
          <ShinyText>
            {t('blockTimeline.mcp.generatingArgs', { defaultValue: '正在生成参数…' })}
          </ShinyText>
        </div>
      )}
      {entry.partial && !suppressPartialReason && (
        // W4c · W4a-L12：MCP 工具块按 partialReason 显示统一文案
        <div className={cn('border-t', BORDER.subtle, 'px-2.5 py-1', TEXT.meta, TEXT_COLOR.faint, 'italic')}>
          {partialReasonText(entry.partialReason, t)}
        </div>
      )}
    </div>
  )
}
McpToolUseView.displayName = 'McpToolUseView'

function flattenMcpResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c) => {
    if (!c || typeof c !== 'object') return ''
    const text = (c as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  }).filter(Boolean).join('\n')
}

const McpToolResultView: React.FC<{ entry: BlockRendererProps['entry'] }> = () => null
McpToolResultView.displayName = 'McpToolResultView'

export const McpToolBlockView: React.FC<BlockRendererProps> = React.memo((props) => {
  const block = props.entry.block
  if (block.type === 'mcp_tool_use') {
    return (
      <McpToolUseView
        entry={props.entry}
        sessionId={props.sessionId}
        siblingToolResult={props.siblingToolResult}
        suppressPartialReason={props.suppressPartialReason}
      />
    )
  }
  if (block.type === 'mcp_tool_result') return <McpToolResultView entry={props.entry} />
  return null
}, blockEntryEqual)
McpToolBlockView.displayName = 'McpToolBlockView'
