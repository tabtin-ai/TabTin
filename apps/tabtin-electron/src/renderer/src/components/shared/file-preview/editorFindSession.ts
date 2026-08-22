/**
 * EditorFindSession — 编辑器内查找会话。
 *
 * 基于 model.findMatches + decorations：工程搜索点结果时静默高亮当前命中并定位。
 * 定位用 setPosition（不整段 setSelection），避免触发划选「加入对话」工具条。
 */

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { hasUnicodeUppercase } from '@shared/ripgrep-search-types'
import {
  DEFAULT_WORD_SEPARATORS,
  type EditorFindRequest,
} from './editorFindTypes'

type MonacoEditor = monaco.editor.IStandaloneCodeEditor
type MonacoFindMatch = monaco.editor.FindMatch
type MonacoDecoration = monaco.editor.IModelDeltaDecoration

const FIND_MATCH_CURRENT_CLASS = 'tabtin-editor-find-match-current'

let stylesInjected = false

function ensureFindStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-tabtin-editor-find', 'true')
  // 颜色对齐 monaco-ide-theme 的 editor.findMatchCurrent（亮色 / 暗色用 CSS 变量兜底）
  style.textContent = `
    .monaco-editor .${FIND_MATCH_CURRENT_CLASS} {
      background-color: var(--tabtin-find-match-current, rgba(158, 106, 3, 0.67));
    }
    html:not(.dark) .monaco-editor .${FIND_MATCH_CURRENT_CLASS} {
      background-color: var(--tabtin-find-match-current, rgba(255, 223, 93, 0.6));
    }
  `
  document.head.appendChild(style)
}

export function pickPreferredMatchIndex(
  matches: ReadonlyArray<{ range: { startLineNumber: number; startColumn: number } }>,
  prefer?: EditorFindRequest['preferOccurrence'],
): number {
  if (!prefer || prefer.line < 1 || matches.length === 0) return 0

  const onLine: number[] = []
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].range.startLineNumber === prefer.line) onLine.push(i)
  }
  if (onLine.length === 0) return 0
  if (prefer.column == null || prefer.column < 1) return onLine[0]

  let best = onLine[0]
  let bestDelta = Math.abs(matches[best].range.startColumn - prefer.column)
  for (let i = 1; i < onLine.length; i++) {
    const idx = onLine[i]
    const delta = Math.abs(matches[idx].range.startColumn - prefer.column)
    if (delta < bestDelta) {
      best = idx
      bestDelta = delta
    }
  }
  return best
}

export class EditorFindSession {
  private decorationIds: string[] = []
  private matches: MonacoFindMatch[] = []
  private currentIndex = -1
  private lastRequestKey: number | undefined

  constructor(private readonly editor: MonacoEditor) {
    ensureFindStyles()
  }

  /**
   * @returns true 表示已在非空内容上消费本次 request；false 表示应等待内容后再试。
   */
  apply(request: EditorFindRequest): boolean {
    const query = request.query.trim()
    if (!query) {
      this.clear()
      return true
    }
    if (this.lastRequestKey === request.key && this.matches.length > 0) {
      return true
    }

    const model = this.editor.getModel()
    if (!model) {
      this.clear()
      return false
    }
    // 内容未到位时不消费 key，等 value 更新后重试（修复首次点搜索结果不跳行）
    if (model.getValueLength() === 0) {
      return false
    }

    this.lastRequestKey = request.key

    // rg 仍是 smart-case 的权威实现；Monaco 只能用 Unicode 大写检测做近似。
    const caseSensitive = request.caseSensitive ?? (
      request.caseMode === 'sensitive'
        ? true
        : request.caseMode === 'insensitive'
          ? false
          : hasUnicodeUppercase(query)
    )
    const wordSeparators = request.wholeWord ? DEFAULT_WORD_SEPARATORS : null
    const matches = model.findMatches(
      query,
      false,
      Boolean(request.isRegex),
      caseSensitive,
      wordSeparators,
      false,
      5000,
    )
    this.matches = matches
    if (matches.length === 0) {
      this.clearDecorations()
      this.currentIndex = -1
      if (request.preferOccurrence?.line) {
        this.revealLine(request.preferOccurrence.line)
      }
      return true
    }

    this.currentIndex = pickPreferredMatchIndex(matches, request.preferOccurrence)
    // 只高亮当前命中，避免短 query 把全文刷成一片黄
    this.paintCurrent()
    this.revealCurrent()
    return true
  }

  /** 整模替换前调用，避免旧 decoration 被拉伸成「全文高亮」。 */
  clear(): void {
    this.clearDecorations()
    this.matches = []
    this.currentIndex = -1
    this.lastRequestKey = undefined
  }

  dispose(): void {
    this.clear()
  }

  private clearDecorations(): void {
    this.decorationIds = this.editor.deltaDecorations(this.decorationIds, [])
  }

  private paintCurrent(): void {
    if (this.currentIndex < 0) {
      this.clearDecorations()
      return
    }
    const match = this.matches[this.currentIndex]
    const decorations: MonacoDecoration[] = [
      {
        range: match.range,
        options: {
          inlineClassName: FIND_MATCH_CURRENT_CLASS,
          overviewRuler: {
            color: 'rgba(158, 106, 3, 0.85)',
            position: monaco.editor.OverviewRulerLane.Center,
          },
          zIndex: 10,
        },
      },
    ]
    this.decorationIds = this.editor.deltaDecorations(this.decorationIds, decorations)
  }

  private revealCurrent(): void {
    const match = this.matches[this.currentIndex]
    if (!match) return
    const { startLineNumber, startColumn } = match.range
    // 不整段选中，避免 CodeSelectionToolbar 弹出
    this.editor.setPosition({ lineNumber: startLineNumber, column: startColumn })
    this.editor.revealRangeInCenter(match.range)
  }

  private revealLine(line: number): void {
    if (line < 1) return
    this.editor.revealLineInCenter(line)
    this.editor.setPosition({ lineNumber: line, column: 1 })
  }
}
