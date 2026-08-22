/**
 * 空基线（新文件 / 删文件）Diff：不走 Monaco，避免空 model 假删/假增行。
 */

import React, { useEffect, useMemo } from 'react'
import { cn } from '@utils/cn'
import { HighlightedCode, langFromFileName } from '@components/chat/utils/highlightCode'
import {
  STATIC_DIFF_CONTENT_WIDTH_CLASS,
  STATIC_DIFF_ROW_WIDTH_CLASS,
} from '../../context-space/code-workspace/StaticUnifiedFileDiff'
import {
  buildStaticUnifiedDiffViewModel,
  type StaticDiffRow,
} from '../../context-space/code-workspace/staticUnifiedDiffModel'
import type { DiffLineStats } from './tabCodeDiffStats'

const DIFF_COLORS = {
  addBg: 'bg-green-500/15',
  addText: 'text-green-600 dark:text-green-400',
  removeBg: 'bg-red-500/15',
  removeText: 'text-red-600 dark:text-red-400',
} as const

export interface EmptyBaselineDiffViewProps {
  originalContent: string
  modifiedContent: string
  filePath: string
  language?: string
  autoHeight?: boolean
  onStats?: (stats: DiffLineStats) => void
}

function rowBackground(kind: StaticDiffRow['kind']): string {
  if (kind === 'add') return DIFF_COLORS.addBg
  if (kind === 'remove') return DIFF_COLORS.removeBg
  return ''
}

function rowMarker(kind: StaticDiffRow['kind']): { symbol: string; className: string } {
  if (kind === 'add') return { symbol: '+', className: DIFF_COLORS.addText }
  if (kind === 'remove') return { symbol: '-', className: DIFF_COLORS.removeText }
  return { symbol: ' ', className: 'text-muted-foreground/40' }
}

export const EmptyBaselineDiffView: React.FC<EmptyBaselineDiffViewProps> = ({
  originalContent,
  modifiedContent,
  filePath,
  language,
  autoHeight = false,
  onStats,
}) => {
  const model = useMemo(
    () => buildStaticUnifiedDiffViewModel(originalContent, modifiedContent, {
      filePath,
    }),
    [originalContent, modifiedContent, filePath],
  )

  const lang = useMemo(
    () => language || langFromFileName(filePath) || undefined,
    [language, filePath],
  )

  const lineNumChars = useMemo(() => {
    let max = 1
    for (const row of model.rows) {
      const n = row.newLine ?? row.oldLine
      if (typeof n === 'number' && n > max) max = n
    }
    return Math.max(2, String(max).length) + 1
  }, [model.rows])

  useEffect(() => {
    onStats?.({
      insertions: model.insertions,
      deletions: model.deletions,
      hasChanges: model.hasChanges,
    })
  }, [model, onStats])

  return (
    <div
      className={cn(
        'tabtin-code-hl w-full overflow-auto px-2 py-3',
        autoHeight ? '' : 'h-full',
      )}
      data-testid="empty-baseline-diff"
      data-empty-original={originalContent === '' ? 'true' : 'false'}
      data-empty-modified={modifiedContent === '' ? 'true' : 'false'}
    >
      <div
        className={STATIC_DIFF_CONTENT_WIDTH_CLASS}
        data-testid="empty-baseline-diff-content"
      >
        {model.rows.map((row) => {
          const marker = rowMarker(row.kind)
          const displayLine = row.newLine ?? row.oldLine
          if (row.kind === 'gap') {
            return null
          }
          return (
            <div
              key={row.id}
              data-testid="empty-baseline-diff-row"
              data-diff-kind={row.kind}
              className={cn(
                'flex font-mono text-[12px] leading-[18px]',
                STATIC_DIFF_ROW_WIDTH_CLASS,
                rowBackground(row.kind),
              )}
            >
              <span
                className="shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground/50"
                style={{ width: `${lineNumChars}ch` }}
              >
                {displayLine ?? ''}
              </span>
              <span className={cn('w-4 shrink-0 select-none text-center', marker.className)}>
                {marker.symbol}
              </span>
              {/* 与 StaticUnifiedFileDiff 同契约：勿用 min-w-0，否则底色只盖文字 */}
              <span className="shrink-0 whitespace-pre">
                <HighlightedCode code={row.text} lang={lang} />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default EmptyBaselineDiffView
