/**
 * FileWriteCard — `write_file` 工具的卡片渲染器（cursor 风格）。
 *
 * **设计取向（W14 Wave A·向 cursor 靠齐）**：
 *   - 头部克制：文件名 + `+N` 行数 chip（绿色），不再用"写入中" / "已写入"中文徽章
 *   - 流式状态语义靠 `+N` chip 的色调表达——`+0` 灰色（流式刚开始）→ `+91` 绿色
 *   - inline preview 默认完整可见，不需要点开（CodeBlock 不带 collapse）
 *   - 仅当 partial path 还没拿到 / 流式刚启动时才显示 spinner + "writing..." 占位
 *
 * 三个数据源（fallback 链）：
 *   1. `useFileToolStreaming` 订阅 args delta buffer 拿 partial contents（流式期）
 *   2. `input.contents` / `input.kwargs.contents`（phase=start 后已完整）
 *   3. `output.data.path` / `output.path`（end 阶段兜底）
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus2, Loader2 } from 'lucide-react'
import { cn } from '@utils/cn'
import type { CardRendererProps } from '../registry/types'
import type { FileWriteData } from '@tabtin/chat-client'
import { CodeBlock } from './primitives'
import { FileCardHeader } from './primitives/FileCardHeader'
import {
  CARD_RADIUS,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  ICON_SIZE,
  ANIMATION,
  DIFF,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { detectLanguage } from '../utils/lang'
import { ErrorBanner, FileToolPlaceholder } from './primitives'
import { useFileToolStreaming } from './hooks/useFileToolStreaming'

const PREVIEW_HARD_CAP = 3000

interface FileWriteCardProps {
  path: string
  content?: string | null
  size?: number
  isStreaming?: boolean
}

const FileWriteCard: React.FC<FileWriteCardProps> = React.memo(
  ({ path, content, size, isStreaming }) => {
    const { t } = useTranslation('chat')
    const language = detectLanguage(path)

    const previewContent = useMemo(() => {
      if (!content) return null
      return content.length > PREVIEW_HARD_CAP ? content.slice(0, PREVIEW_HARD_CAP) + '\n...' : content
    }, [content])

    // cursor 风格的 +N chip：用 content 的行数（不是 content.length 字节）
    // 更符合 GitHub PR diff stat 的语义
    const lineCount = useMemo(() => {
      if (!content) return 0
      return content.split('\n').filter(Boolean).length || content.split('\n').length
    }, [content])

    return (
      <div className="overflow-hidden">
        <FileCardHeader
          filePath={path}
          meta={
            <span className={cn('inline-flex items-center gap-2', TEXT.meta)}>
              {isStreaming && (
                <Loader2 className={cn(ICON_SIZE.sm, ANIMATION.spin, TEXT_COLOR.faint)} />
              )}
              {lineCount > 0 && (
                // +N chip：cursor 风格的 GitHub diff stat 样式（点状语义色，不带 bg）
                <span className={cn(DIFF.addText, 'font-mono')}>+{lineCount}</span>
              )}
              {size != null && (
                <span className={cn(TEXT_COLOR.faint)}>
                  {size > 1024
                    ? t('card.file_size_kb', { size: (size / 1024).toFixed(1) })
                    : t('card.file_size_b', { size })}
                </span>
              )}
            </span>
          }
        />
        {previewContent ? (
          <CodeBlock
            code={previewContent}
            language={language}
            showLineNumbers
            maxHeight="md"
          />
        ) : (
          <div className={cn('px-3 py-1.5', TEXT.meta, TEXT_COLOR.faint)}>
            {isStreaming
              ? t('card.fileWrite.streamingPlaceholder', { defaultValue: 'Agent is writing…' })
              : t('card.file_content_empty', { defaultValue: '文件内容为空' })}
          </div>
        )}
      </div>
    )
  },
)

FileWriteCard.displayName = 'FileWriteCard'

const FileWriteCardRenderer: React.FC<CardRendererProps> = ({ id, data, input, output, error, phase, sessionId }) => {
  const { t } = useTranslation('chat')
  const fw = data as FileWriteData | undefined
  const inp = ((input as Record<string, unknown> | undefined)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const out = ((output as Record<string, unknown> | undefined)?.data ?? output ?? {}) as Record<string, unknown>

  const finalPath = fw?.path ?? String(inp.path ?? out.path ?? '') ?? ''
  const finalContent =
    (typeof inp.contents === 'string' ? inp.contents : null) ??
    (typeof inp.content === 'string' ? inp.content : null) ??
    (typeof out.content === 'string' ? out.content : null)

  const { streamingPath, streamingContent, isStreaming } = useFileToolStreaming({
    sessionId,
    toolCallId: id,
    toolName: 'write_file',
    finalPath: finalPath || null,
    finalContent,
  })

  if (error) return <ErrorBanner error={error} />

  const path = finalPath || streamingPath || ''
  const content = finalContent ?? streamingContent

  // path 还没就位 → "准备写入文件…" 占位（W14 修问题 1：明显感知到工具已启动）。
  // 旧实现走 LoadingPlaceholder 几乎不可见，用户在 tool_call_start → args_delta
  // 窗口看到空白片刻，体验突兀。
  if (!path && (phase === 'start' || phase === 'running')) {
    return (
      <FileToolPlaceholder
        icon={<FilePlus2 className={cn(ICON_SIZE.lg, TEXT_COLOR.muted, 'shrink-0')} />}
        text={t('card.fileWrite.preparing', { defaultValue: '准备写入文件…' })}
      />
    )
  }
  if (!path) {
    return null
  }

  const size = fw?.size

  return (
    <FileWriteCard
      path={path}
      content={content}
      size={size}
      isStreaming={isStreaming && phase !== 'end' && phase !== 'error'}
    />
  )
}

FileWriteCardRenderer.displayName = 'FileWriteCardRenderer'

registerCardRenderer('FileWriteCard', FileWriteCardRenderer)

export { FileWriteCard, FileWriteCardRenderer }
export default FileWriteCard
