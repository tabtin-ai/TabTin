/**
 * CodeSearchCard — structured rendering for grep_search / glob_search / semantic_search.
 *
 * Displays search pattern, match count, and a list of matching files with
 * code snippets. Self-registers as 'CodeSearchCard'.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, FileCode2 } from 'lucide-react'
import { cn } from '@utils/cn'
import type { CardRendererProps } from '../registry/types'
import type { CodeSearchData } from '@tabtin/chat-client'
import { SearchResultList, type SearchResultItem } from './primitives'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { basename } from '../utils/path'
import { ErrorBanner, LoadingPlaceholder } from './primitives'

interface CodeSearchCardProps {
  pattern?: string
  globPattern?: string
  query?: string
  matches: Array<{ file: string; line: number; text: string }>
  matchCount: number
  mode: 'grep' | 'glob' | 'semantic'
}

const CodeSearchCard: React.FC<CodeSearchCardProps> = React.memo(
  ({ pattern, globPattern, query, matches, matchCount, mode }) => {
    const { t } = useTranslation('chat')
    const searchTerm = pattern || globPattern || query || ''
    const highlightTerms = pattern ? [pattern] : []

    const items: SearchResultItem[] = matches.map((m, i) => ({
      key: `${m.file}:${m.line}:${i}`,
      icon: <FileCode2 className={ICON_SIZE.sm} />,
      title: basename(m.file),
      subtitle: m.file + (m.line > 0 ? `:${m.line}` : ''),
      preview: m.text,
      highlightTerms,
    }))

    const modeLabel = mode === 'grep' ? 'grep' : mode === 'glob' ? 'glob' : 'semantic'

    return (
      <div className={'overflow-hidden'}>
        {/* Header */}
        <div
          className={cn(
            'flex items-center gap-1.5',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            BG.header,
            'border-b',
            BORDER.subtle,
          )}
        >
          <Search className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
          <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>{modeLabel}</span>
          {searchTerm && (
            <span className={cn(TEXT.code, TEXT_COLOR.secondary, 'truncate')} title={searchTerm}>
              {searchTerm}
            </span>
          )}
          <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'ml-auto shrink-0')}>
            {t('card.match_count', { count: matchCount })}
          </span>
        </div>

        {/* Results */}
        <SearchResultList items={items} maxHeight="md" emptyMessage={t('card.no_matches')} />
      </div>
    )
  },
)

CodeSearchCard.displayName = 'CodeSearchCard'

const CodeSearchCardRenderer: React.FC<CardRendererProps> = ({ data, input, output, toolName, error, phase }) => {
  if (error) return <ErrorBanner error={error} />

  const search = data as CodeSearchData | undefined

  if (search && search.kind === 'code_search') {
    const mode = toolName === 'glob_search' ? 'glob' : toolName === 'semantic_search' ? 'semantic' : 'grep'
    return (
      <CodeSearchCard
        pattern={search.pattern}
        globPattern={search.glob_pattern}
        query={search.query}
        matches={search.matches || []}
        matchCount={search.match_count ?? search.matches?.length ?? 0}
        mode={mode}
      />
    )
  }

  const raw = ((output as Record<string, unknown>)?.data ?? output ?? {}) as Record<string, unknown>
  const inp = ((input as Record<string, unknown>)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const mode = toolName === 'glob_search' ? 'glob' as const : toolName === 'semantic_search' ? 'semantic' as const : 'grep' as const

  let matches: Array<{ file: string; line: number; text: string }> = []
  let matchCount = 0

  // T2-SEV-1 (2026-05-12)：fallback 路径同款识别 grep/glob 零结果固定文案 +
  // 截断说明行（跟 fileToolCards.ts::extractCodeSearch 保持一致）。
  // 旧逻辑会把 "No matches found." / "(Results are truncated...)" 当成 1 条匹配。
  const ZERO_RESULT_OUTPUTS = new Set<string>([
    'No matches found.',
    'No files found.',
    'Found 0 total occurrences across 0 files.',
  ])
  // T2 final R2/R3：count 0 匹配复合双段文案识别——见 fileToolCards.ts 同款注释
  const isFullZeroResultOutput = (rawOutput: string): boolean => {
    const trimmed = rawOutput.trim()
    if (ZERO_RESULT_OUTPUTS.has(trimmed)) return true
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return false
    return lines.every((line) => ZERO_RESULT_OUTPUTS.has(line))
  }
  const isTruncationNoticeLine = (line: string): boolean => {
    const trimmed = line.trim()
    if (!trimmed) return true
    return (
      trimmed.startsWith('... truncated') ||
      trimmed.startsWith('(Results are truncated') ||
      trimmed === '(no matches in this page)'
    )
  }
  // T2 follow-up B3：grep files_with_matches 输出 `Found N files` 汇总头不是匹配
  const isSummaryHeaderLine = (line: string): boolean => /^Found \d+ files?(\s|$)/.test(line.trim())

  let zeroResult = false

  if (Array.isArray(raw.matches)) {
    matches = (raw.matches as Array<Record<string, unknown>>).map((m) => ({
      file: String(m.file ?? m.path ?? ''),
      line: Number(m.line ?? m.line_number ?? 0),
      text: String(m.text ?? m.content ?? ''),
    }))
    matchCount = Number(raw.count ?? raw.match_count ?? matches.length)
  } else if (typeof raw.output === 'string') {
    if (isFullZeroResultOutput(raw.output as string)) {
      zeroResult = true
      matches = []
      matchCount = 0
    } else {
      const lines = (raw.output as string).split('\n').filter(Boolean)
      matches = lines
        .slice(0, 50)
        .filter((line) => !isTruncationNoticeLine(line) && !isSummaryHeaderLine(line))
        .map((line) => {
          const colonIdx = line.indexOf(':')
          const secondColon = colonIdx >= 0 ? line.indexOf(':', colonIdx + 1) : -1
          if (secondColon > colonIdx) {
            return {
              file: line.slice(0, colonIdx),
              line: parseInt(line.slice(colonIdx + 1, secondColon), 10) || 0,
              text: line.slice(secondColon + 1),
            }
          }
          // T2 follow-up E2：纯路径行 → file 填路径让 CodeSearchCard title 显示文件名
          // （原 file:'' 让 basename('') = ''，title 空显示只剩 preview）
          return { file: line, line: 0, text: '' }
        })
      // 优先用 adapter 给的 total_matches / total_files，避免显示截断后数字
      matchCount = Number(
        raw.count ?? raw.total_matches ?? raw.total_files ?? matches.length,
      )
    }
  } else if (Array.isArray(raw.files)) {
    matches = (raw.files as string[]).map((f) => ({ file: f, line: 0, text: '' }))
    matchCount = matches.length
  }

  if (matches.length === 0 && !raw.output && !zeroResult) {
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    return null
  }

  return (
    <CodeSearchCard
      pattern={String(inp.pattern ?? '')}
      globPattern={String(inp.glob_pattern ?? '')}
      query={String(inp.query ?? '')}
      matches={matches}
      matchCount={matchCount}
      mode={mode}
    />
  )
}

CodeSearchCardRenderer.displayName = 'CodeSearchCardRenderer'

registerCardRenderer('CodeSearchCard', CodeSearchCardRenderer)

export { CodeSearchCard, CodeSearchCardRenderer }
export default CodeSearchCard
