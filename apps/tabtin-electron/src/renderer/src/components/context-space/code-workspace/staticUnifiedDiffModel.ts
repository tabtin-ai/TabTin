/**
 * 静态只读 Diff 行模型：用 structuredPatch 生成带上下文的 hunk 行，
 * 供连续审阅与页面级搜索复用，不依赖 Monaco。
 */

import { structuredPatch } from 'diff'

export type StaticDiffRowKind = 'add' | 'remove' | 'context' | 'gap'

export interface StaticDiffRow {
  id: string
  kind: StaticDiffRowKind
  text: string
  oldLine: number | null
  newLine: number | null
  /** gap 行：中间跳过的未变更行数（按新文件侧估算） */
  skippedLines?: number
}

export interface StaticDiffViewModel {
  rows: StaticDiffRow[]
  insertions: number
  deletions: number
  hasChanges: boolean
}

export const STATIC_DIFF_CONTEXT_LINES = 3

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function countChangedLines(lines: string[]): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  for (const raw of lines) {
    if (raw.startsWith('+') && !raw.startsWith('+++')) insertions += 1
    else if (raw.startsWith('-') && !raw.startsWith('---')) deletions += 1
  }
  return { insertions, deletions }
}

/**
 * 从左右全文构建静态 Diff 行模型。
 * context 默认 3，对齐 Monaco hideUnchangedRegions 的上下文观感。
 */
export function buildStaticUnifiedDiffViewModel(
  originalContent: string,
  modifiedContent: string,
  options?: { context?: number; filePath?: string },
): StaticDiffViewModel {
  const left = normalizeNewlines(originalContent)
  const right = normalizeNewlines(modifiedContent)
  if (left === right) {
    return { rows: [], insertions: 0, deletions: 0, hasChanges: false }
  }

  const context = options?.context ?? STATIC_DIFF_CONTEXT_LINES
  const fileLabel = options?.filePath || 'file'
  const patch = structuredPatch(
    fileLabel,
    fileLabel,
    left,
    right,
    undefined,
    undefined,
    { context },
  )

  const rows: StaticDiffRow[] = []
  let insertions = 0
  let deletions = 0
  let previousOldEnd = 0
  let previousNewEnd = 0

  patch.hunks.forEach((hunk, hunkIndex) => {
    const counts = countChangedLines(hunk.lines)
    insertions += counts.insertions
    deletions += counts.deletions

    if (hunkIndex > 0) {
      const skippedOld = Math.max(0, hunk.oldStart - previousOldEnd - 1)
      const skippedNew = Math.max(0, hunk.newStart - previousNewEnd - 1)
      const skipped = Math.max(skippedOld, skippedNew)
      if (skipped > 0) {
        rows.push({
          id: `gap-${hunkIndex}-${hunk.oldStart}-${hunk.newStart}`,
          kind: 'gap',
          text: '',
          oldLine: null,
          newLine: null,
          skippedLines: skipped,
        })
      }
    }

    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    hunk.lines.forEach((rawLine, lineIndex) => {
      if (rawLine.startsWith('\\')) return
      const marker = rawLine.charAt(0)
      const text = rawLine.slice(1)
      if (marker === '-') {
        rows.push({
          id: `h${hunkIndex}-r${lineIndex}-old${oldLine}`,
          kind: 'remove',
          text,
          oldLine,
          newLine: null,
        })
        oldLine += 1
        return
      }
      if (marker === '+') {
        rows.push({
          id: `h${hunkIndex}-r${lineIndex}-new${newLine}`,
          kind: 'add',
          text,
          oldLine: null,
          newLine,
        })
        newLine += 1
        return
      }
      rows.push({
        id: `h${hunkIndex}-r${lineIndex}-ctx${newLine}`,
        kind: 'context',
        text: marker === ' ' ? text : rawLine,
        oldLine,
        newLine,
      })
      oldLine += 1
      newLine += 1
    })

    previousOldEnd = Math.max(previousOldEnd, oldLine - 1)
    previousNewEnd = Math.max(previousNewEnd, newLine - 1)
  })

  return {
    rows,
    insertions,
    deletions,
    hasChanges: insertions > 0 || deletions > 0 || rows.some((row) => row.kind !== 'gap'),
  }
}

/** 可供页面搜索的行（不含 gap） */
export function getSearchableStaticDiffRows(model: StaticDiffViewModel): StaticDiffRow[] {
  return model.rows.filter((row) => row.kind !== 'gap')
}
