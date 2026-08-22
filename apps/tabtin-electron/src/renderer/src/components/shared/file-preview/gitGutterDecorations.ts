import { structuredPatch } from 'diff'

export type GitGutterChangeKind = 'added' | 'modified' | 'deleted'

export interface GitGutterMarker {
  lineNumber: number
  kind: GitGutterChangeKind
}

export interface GitGutterBaseline {
  content: string
  revision: number
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function countContentLines(value: string): number {
  const normalized = normalizeNewlines(value)
  if (normalized.length === 0) return 0
  const lineCount = normalized.split('\n').length
  return normalized.endsWith('\n') ? Math.max(0, lineCount - 1) : lineCount
}

function markerKey(marker: GitGutterMarker): string {
  return `${marker.lineNumber}:${marker.kind}`
}

/**
 * Convert a HEAD → current content patch into the three VS Code-style gutter
 * states used by the normal TabCode editor.
 *
 * A hunk containing both removed and added lines is treated as a modification
 * and paints the current (added) lines blue. A deletion has no current line to
 * decorate, so it is anchored to the first line after the deletion; trailing
 * deletions are clamped to the last current line (or line 1 for an empty file).
 */
export function buildGitGutterMarkers(
  baselineContent: string,
  currentContent: string,
): GitGutterMarker[] {
  const baseline = normalizeNewlines(baselineContent)
  const current = normalizeNewlines(currentContent)
  if (baseline === current) return []

  const patch = structuredPatch(
    'HEAD',
    'WORKTREE',
    baseline,
    current,
    undefined,
    undefined,
    { context: 0 },
  )
  const currentLineCount = countContentLines(current)
  const markers: GitGutterMarker[] = []

  for (const hunk of patch.hunks) {
    let newLine = hunk.newStart
    let hasRemovedLines = false
    let hasAddedLines = false
    const addedLineNumbers: number[] = []

    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith('\\')) continue
      const marker = rawLine.charAt(0)
      if (marker === '-') {
        hasRemovedLines = true
      } else if (marker === '+') {
        hasAddedLines = true
        addedLineNumbers.push(newLine)
        newLine += 1
      } else {
        newLine += 1
      }
    }

    if (hasAddedLines) {
      const kind: GitGutterChangeKind = hasRemovedLines ? 'modified' : 'added'
      for (const lineNumber of addedLineNumbers) {
        markers.push({ lineNumber, kind })
      }
      continue
    }

    if (hasRemovedLines) {
      const lineNumber = Math.max(
        1,
        Math.min(hunk.newStart, Math.max(1, currentLineCount)),
      )
      markers.push({ lineNumber, kind: 'deleted' })
    }
  }

  const unique = new Map<string, GitGutterMarker>()
  for (const marker of markers) unique.set(markerKey(marker), marker)
  return [...unique.values()]
}
