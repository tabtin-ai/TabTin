/**
 * 静态只读文件 Diff：loadDiffContents + structuredPatch 行模型 + lowlight 高亮。
 * 连续审阅专用，不创建 Monaco。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { createLogger } from '@/utils/logger'
import { HighlightedCode, langFromFileName } from '@components/chat/utils/highlightCode'
import { loadDiffContents, type DiffMode } from '@components/tabcode/components/diffContentCache'
import {
  markFirstDiffReady,
  trackStaticBlockDispose,
  trackStaticBlockMount,
} from './changesPerfMetrics'
import {
  buildStaticUnifiedDiffViewModel,
  type StaticDiffRow,
  type StaticDiffViewModel,
} from './staticUnifiedDiffModel'

export interface StaticDiffReadyInfo {
  hasChanges: boolean
  insertions: number
  deletions: number
}

/** 接近 GitHub / 常见 Git Diff 的增删色（不用 brand success/destructive） */
export const STATIC_DIFF_COLORS = {
  addBg: 'bg-green-500/15',
  addText: 'text-green-600 dark:text-green-400',
  removeBg: 'bg-red-500/15',
  removeText: 'text-red-600 dark:text-red-400',
  /** gap 随内容壳同宽（见 STATIC_DIFF_CONTENT_WIDTH_CLASS） */
  gapBand: 'w-full border-y border-border/60 bg-muted/40 px-3 py-1.5 text-center text-body text-muted-foreground',
} as const

/**
 * 滚动区内层：至少铺满视口，并被最长行撑开。
 * 行本身用 w-full 吃满此壳，短行增删底色也会铺到行末空白。
 */
export const STATIC_DIFF_CONTENT_WIDTH_CLASS = 'inline-block min-w-full'

/** 行盒：铺满内容壳；背景画在整行上，而不是只盖住文字 */
export const STATIC_DIFF_ROW_WIDTH_CLASS = 'w-full'

export interface StaticUnifiedFileDiffProps {
  rootPath?: string
  filePath?: string
  relativePath: string
  contentRevision?: number
  priority?: boolean
  diffMode?: DiffMode
  commitHash?: string
  /** 内存左右文本：有值时不走 Git loadDiffContents，供 Agent 冻结补丁使用 */
  leftText?: string
  rightText?: string
  /** 当前页面搜索命中的行 id */
  highlightRowId?: string | null
  /** 与 highlightRowId 搭配：同文件同行走位时递增以强制重滚 */
  highlightRequestId?: number
  onDiffReady?: (info: StaticDiffReadyInfo) => void
  onModelReady?: (model: StaticDiffViewModel) => void
}

const log = createLogger('StaticUnifiedFileDiff')
const LINE_HEIGHT_PX = 18

function rowBackground(kind: StaticDiffRow['kind']): string {
  if (kind === 'add') return STATIC_DIFF_COLORS.addBg
  if (kind === 'remove') return STATIC_DIFF_COLORS.removeBg
  return ''
}

function rowMarker(kind: StaticDiffRow['kind']): { symbol: string; className: string } {
  if (kind === 'add') return { symbol: '+', className: STATIC_DIFF_COLORS.addText }
  if (kind === 'remove') return { symbol: '-', className: STATIC_DIFF_COLORS.removeText }
  return { symbol: ' ', className: 'text-muted-foreground/40' }
}

const StaticDiffRowView = React.memo(function StaticDiffRowView({
  row,
  lang,
  lineNumChars,
  highlighted,
  gapLabel,
}: {
  row: StaticDiffRow
  lang?: string
  lineNumChars: number
  highlighted: boolean
  gapLabel: string
}) {
  if (row.kind === 'gap') {
    return (
      <div
        data-testid="static-diff-gap"
        data-row-id={row.id}
        className={STATIC_DIFF_COLORS.gapBand}
      >
        {gapLabel}
      </div>
    )
  }

  const marker = rowMarker(row.kind)
  const displayLine = row.newLine ?? row.oldLine
  return (
    <div
      data-testid="static-diff-row"
      data-row-id={row.id}
      data-diff-kind={row.kind}
      className={cn(
        'flex font-mono text-[12px] leading-[18px]',
        STATIC_DIFF_ROW_WIDTH_CLASS,
        rowBackground(row.kind),
        highlighted && 'ring-1 ring-inset ring-primary/50 bg-primary/10',
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
      {/* 不可用 min-w-0：会把 flex 行宽锁在视口内，横向滚动时增删底色断裂 */}
      <span className="shrink-0 whitespace-pre">
        <HighlightedCode code={row.text} lang={lang} />
      </span>
    </div>
  )
})

export const StaticUnifiedFileDiff: React.FC<StaticUnifiedFileDiffProps> = ({
  rootPath,
  filePath,
  relativePath,
  contentRevision = 0,
  priority = false,
  diffMode = 'head',
  commitHash,
  leftText,
  rightText,
  highlightRowId = null,
  highlightRequestId = 0,
  onDiffReady,
  onModelReady,
}) => {
  const { t } = useTranslation('context')
  const [model, setModel] = useState<StaticDiffViewModel | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loadGenerationRef = useRef(0)
  const onDiffReadyRef = useRef(onDiffReady)
  onDiffReadyRef.current = onDiffReady
  const onModelReadyRef = useRef(onModelReady)
  onModelReadyRef.current = onModelReady
  const priorityRef = useRef(priority)
  priorityRef.current = priority
  const previousModelRef = useRef<StaticDiffViewModel | null>(null)
  const highlightAnchorRef = useRef<HTMLDivElement | null>(null)

  const useInMemory = leftText !== undefined || rightText !== undefined

  useEffect(() => {
    trackStaticBlockMount()
    return () => {
      trackStaticBlockDispose()
    }
  }, [filePath, relativePath])

  useEffect(() => {
    const generation = ++loadGenerationRef.current
    let cancelled = false
    const hasPrevious = previousModelRef.current != null
    if (!hasPrevious) setIsLoading(true)
    setError(null)

    const applyModel = (left: string, right: string) => {
      if (cancelled || generation !== loadGenerationRef.current) return
      const next = buildStaticUnifiedDiffViewModel(left, right, {
        filePath: relativePath,
      })
      previousModelRef.current = next
      setModel(next)
      setIsLoading(false)
      onModelReadyRef.current?.(next)
      onDiffReadyRef.current?.({
        hasChanges: next.hasChanges,
        insertions: next.insertions,
        deletions: next.deletions,
      })
      if (next.hasChanges) markFirstDiffReady()
    }

    if (useInMemory) {
      applyModel(leftText ?? '', rightText ?? '')
      return () => {
        cancelled = true
      }
    }

    if (!rootPath || !filePath) {
      setIsLoading(false)
      setError(null)
      return () => {
        cancelled = true
      }
    }

    void loadDiffContents({
      rootPath,
      filePath,
      diffMode,
      commitHash,
      contentRevision,
      priority: priorityRef.current,
    }).then(({ left, right }) => {
      applyModel(left, right)
    }).catch((err) => {
      if (cancelled || generation !== loadGenerationRef.current) return
      setIsLoading(false)
      if (hasPrevious) {
        log.warn('static diff refresh failed', { filePath, error: String(err) })
        return
      }
      setError(String(err))
      onDiffReadyRef.current?.({ hasChanges: false, insertions: 0, deletions: 0 })
    })

    return () => {
      cancelled = true
    }
  }, [
    rootPath,
    filePath,
    relativePath,
    contentRevision,
    diffMode,
    commitHash,
    leftText,
    rightText,
    useInMemory,
  ])

  useEffect(() => {
    if (!highlightRowId || !highlightAnchorRef.current) return
    highlightAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [highlightRowId, highlightRequestId, model])

  const lang = useMemo(() => langFromFileName(relativePath), [relativePath])
  const lineNumChars = useMemo(() => {
    if (!model) return 3
    let max = 1
    for (const row of model.rows) {
      const n = row.newLine ?? row.oldLine
      if (typeof n === 'number' && n > max) max = n
    }
    return Math.max(2, String(max).length) + 1
  }, [model])

  if (error) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-4 text-caption text-destructive"
        data-testid="static-diff-error"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-all">{error}</span>
      </div>
    )
  }

  if (isLoading && !model) {
    return (
      <div
        className="flex h-24 items-center justify-center gap-2 text-muted-foreground"
        data-testid="static-diff-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('codeWorkspace.loading', { defaultValue: '读取变更…' })}
      </div>
    )
  }

  if (!model || !model.hasChanges) {
    return (
      <div
        className="px-3 py-4 text-caption text-muted-foreground/60"
        data-testid="static-diff-empty"
      >
        {t('codeWorkspace.fileNoLineDiffInline', {
          defaultValue: '此文件没有可展示的行级 Diff。',
          file: relativePath,
        })}
      </div>
    )
  }

  return (
    <div
      className="tabtin-code-hl overflow-x-auto px-1 py-1"
      data-testid="static-unified-file-diff"
      style={{ minHeight: Math.min(model.rows.length, 8) * LINE_HEIGHT_PX }}
    >
      <div
        className={STATIC_DIFF_CONTENT_WIDTH_CLASS}
        data-testid="static-unified-file-diff-content"
      >
        {model.rows.map((row) => {
          const highlighted = Boolean(highlightRowId && highlightRowId === row.id)
          return (
            <div
              key={row.id}
              ref={highlighted ? highlightAnchorRef : undefined}
              className="w-full"
            >
              <StaticDiffRowView
                row={row}
                lang={lang}
                lineNumChars={lineNumChars}
                highlighted={highlighted}
                gapLabel={t('codeWorkspace.unchangedLinesGap', {
                  defaultValue: '⋯ {{count}} unchanged lines ⋯',
                  count: row.skippedLines ?? 0,
                })}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default StaticUnifiedFileDiff
