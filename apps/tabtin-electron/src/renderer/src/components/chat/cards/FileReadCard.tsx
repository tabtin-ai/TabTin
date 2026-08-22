/**
 * FileReadCard — structured rendering for read_file tool results.
 *
 * Displays file path, language hint, and code content with line numbers.
 * Self-registers as 'FileReadCard'.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { cn } from '@utils/cn'
import type { CardRendererProps } from '../registry/types'
import type { FileReadData, MaterializedFilesData } from '@tabtin/chat-client'
import { CodeBlock } from './primitives'
import {
  ICON_SIZE,
  TEXT_COLOR,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { basename } from '../utils/path'
import { detectLanguage } from '../utils/lang'
import { ErrorBanner, LoadingPlaceholder } from './primitives'

const MAX_FILE_CONTENT = 100_000

/**
 * 历史会话回放兼容：
 *
 * - W14 工具协议对齐前，read_file 输出 `${行号}|${内容}` 格式（管道符）。
 * - W14 后切到 cat -n 风格 `${行号}\t${内容}`（tab）。
 *
 * 新走 `contentRaw + start_line` 路径，**不**再调本函数；本函数仅用于
 * 历史会话或外部 Agent 的 Read 工具回放——它们的 output 里没有 contentRaw，
 * 只有带前缀的 content 字符串。pattern 同时识别 `|` 和 `\t` 两种分隔符。
 */
function stripLineNumbers(content: string): { code: string; startLine: number } {
  const lines = content.split('\n')
  const lineNumPattern = /^\s*(\d+)[|\t]/
  const firstMatch = lines[0]?.match(lineNumPattern)
  if (!firstMatch) return { code: content, startLine: 1 }

  const stripped = lines.map((l) => {
    const m = l.match(lineNumPattern)
    return m ? l.slice(m[0].length) : l
  })
  return { code: stripped.join('\n'), startLine: parseInt(firstMatch[1], 10) || 1 }
}

interface FileReadCardProps {
  path: string
  /** 行号化的 content（`${行号}\t${内容}`），用于 fallback 路径。 */
  content?: string
  /** 不带行号前缀的纯内容（W14 协议标准字段，优先使用）。 */
  contentRaw?: string
  /** 工具返回的真实起始行号（1-indexed）。 */
  startLineFromTool?: number
  offset?: number
  limit?: number
}

const FileReadCard: React.FC<FileReadCardProps> = React.memo(
  ({ path, content, contentRaw, startLineFromTool, offset, limit }) => {
    const { t } = useTranslation('chat')
    const language = detectLanguage(path)

    // W14 协议优先路径：用 contentRaw + start_line（无前缀，无需 strip）。
    // 历史会话 / 外部 Agent fallback：解析 content 里的行号前缀。
    const { code, startLine } = contentRaw != null
      ? { code: contentRaw, startLine: startLineFromTool ?? 1 }
      : stripLineNumbers(content ?? '')

    const displayCode = code.length > MAX_FILE_CONTENT
      ? `${code.slice(0, MAX_FILE_CONTENT)}\n\n... (${t('card.file_truncated', { total: code.length.toLocaleString(), shown: MAX_FILE_CONTENT.toLocaleString() })})`
      : code
    const effectiveStart = offset ?? startLine
    const lineCount = displayCode.split('\n').length

    // rangeLabel 显示规则：
    //
    // | 条件                       | 显示                        |
    // |---|---|
    // | 传了 limit                 | `(L<start>–<end>)`          |
    // | 起始行 > 1（部分文件读取） | `(L<start>–<end>)`          |
    // | 整文件 + 多行             | `(N 行)`                    |
    // | 单行                       | （空）                      |
    //
    // 旧实现仅当 `limit` 传了才显示 L 范围；只传 `offset` / 工具自带 `start_line` 但
    // 没 `limit` 的场景（譬如 read_file 大文件流式读取，工具内部决定的 start_line>1）
    // 会错误显示 "(N 行)"，丢失"实际从哪一行读起"的关键信息。
    const isPartialRead = !!limit || effectiveStart > 1
    const rangeLabel = isPartialRead
      ? ` (L${effectiveStart}–${effectiveStart + lineCount - 1})`
      : lineCount > 1 ? ` (${t('card.lines_count', { count: lineCount })})` : ''

    return (
      <CodeBlock
        code={displayCode}
        language={language}
        showLineNumbers
        startLine={effectiveStart}
        maxHeight="md"
        label={`${basename(path)}${rangeLabel}`}
        icon={<FileText className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />}
      />
    )
  },
)

FileReadCard.displayName = 'FileReadCard'

const FileReadCardRenderer: React.FC<CardRendererProps> = ({ data, input, output, error, phase }) => {
  const { t } = useTranslation('chat')
  if (error) return <ErrorBanner error={error} />

  // input.path 在 W2/W3 string output 形态下是 path 的唯一来源 —— extractor 拿不到
  // input，所以 FileReadData.path 在 string 路径下被填空字符串，由这里补齐。
  const inp = ((input as any)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const inputPath = String(inp.path ?? '')

  const fileRead = data as FileReadData | undefined

  const materializedFiles = data as MaterializedFilesData | undefined
  if (materializedFiles?.kind === 'materialized_files') {
    return (
      <div className="text-body text-muted-foreground/60 px-3 py-2">
        {t('card.files_viewed', { count: materializedFiles.file_count })}
      </div>
    )
  }

  if (fileRead && fileRead.kind === 'file_read' && (fileRead.content || fileRead.contentRaw)) {
    return (
      <FileReadCard
        // W2/W3 string output 路径下 fileRead.path 为空，回退到 input.path。
        path={fileRead.path || inputPath}
        content={fileRead.content}
        contentRaw={fileRead.contentRaw}
        startLineFromTool={fileRead.start_line}
        offset={fileRead.offset}
        limit={fileRead.limit}
      />
    )
  }

  // **W2/W3 (2026-05-10) defense-in-depth**：output 是 raw string（read_file 多行
  // 明文 / PDF/DOCX/XLSX system-reminder + body）的兜底分支。正常情况下
  // `extractFileRead`（fileToolCards.ts）已经把 string 形态解析成 FileReadData，
  // 这里走不到；保留是为了：
  //   (a) extractor 注册被绕过 / 历史会话回放 / 外部 Agent alias 未注册 extractor
  //   (b) 让 string output 永远能被渲染——避免再出现"用户看到 file_content_empty
  //       但 LLM 拿到了正确内容"的视觉破绽
  if (typeof output === 'string' && output.length > 0) {
    const reminderMatch = output.match(
      /^<system-reminder>([\s\S]*?)<\/system-reminder>\n*([\s\S]*)$/,
    )
    if (reminderMatch) {
      const reminderText = reminderMatch[1].trim()
      const body = reminderMatch[2]
      return (
        <FileReadCard
          path={inputPath}
          contentRaw={body ? `[${reminderText}]\n\n${body}` : `[${reminderText}]`}
          offset={inp.offset as number | undefined}
          limit={inp.limit as number | undefined}
        />
      )
    }
    return (
      <FileReadCard
        path={inputPath}
        // 整段当 cat -n 行号化 content 让 FileReadCard.stripLineNumbers 兜底解析。
        content={output}
        offset={inp.offset as number | undefined}
        limit={inp.limit as number | undefined}
      />
    )
  }

  const raw = ((output as any)?.data ?? output ?? {}) as Record<string, unknown>
  const content = raw.content as string | undefined
  const contentRaw = raw.contentRaw as string | undefined
  const rawStartLine = typeof raw.start_line === 'number' ? (raw.start_line as number) : undefined

  if ((!content || typeof content !== 'string') && (!contentRaw || typeof contentRaw !== 'string')) {
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    const emptyPath = inputPath || String(raw.path ?? '')
    return (
      <div className="text-body text-muted-foreground/60 px-3 py-2">
        {emptyPath
          ? `${emptyPath} — ${t('card.file_content_empty')}`
          : t('card.file_content_empty')}
      </div>
    )
  }

  return (
    <FileReadCard
      path={inputPath || String(raw.path ?? '')}
      content={content}
      contentRaw={contentRaw}
      startLineFromTool={rawStartLine}
      offset={inp.offset as number | undefined}
      limit={inp.limit as number | undefined}
    />
  )
}

FileReadCardRenderer.displayName = 'FileReadCardRenderer'

registerCardRenderer('FileReadCard', FileReadCardRenderer)

export { FileReadCard, FileReadCardRenderer }
export default FileReadCard
