/**
 * DiffCard — renders a file diff with line-level additions/removals.
 *
 * Extracted from the inline InlineDiff in ToolStepCard and enhanced with
 * copy-to-clipboard, change stats, and proper design-token integration.
 */

import React, { useCallback, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePenLine, Copy, Check, ChevronDown, ChevronUp, Loader2, PanelsTopLeft } from 'lucide-react'
import { cn } from '@utils/cn'
import type { CardRendererProps } from '../registry/types'
import type { DiffOutputData } from '@tabtin/chat-client'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import {
  CARD_RADIUS,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
  ANIMATION,
  DIFF,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'

const EMPTY_LINES: string[] = []
import { safeCopyToClipboard } from '../utils/clipboard'
import { ErrorBanner, FileToolPlaceholder } from './primitives'
import { FileCardHeader } from './primitives/FileCardHeader'
import { useFileOpenAction } from './hooks/useFileOpenAction'
import { useFileToolStreaming } from './hooks/useFileToolStreaming'
import { HighlightedCode, langFromFileName } from '../utils/highlightCode'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'

interface DiffCardProps {
  file: string
  startLine: number
  endLine: number
  oldLines: string[]
  newLines: string[]
  replacements?: number
  oldStartLine?: number
  newStartLine?: number
  /** 前台工作台标签桶；与 TerminalCard 同契约，缺省由 openInTabCode 解析。 */
  tabScopeKey?: string | null
}

type PatchHunk = DiffOutputData & {
  old_start_line?: number
  new_start_line?: number
}

type DiffOutputWithHunks = DiffOutputData & {
  hunks?: PatchHunk[]
}

/**
 * Build a unified-diff string suitable for clipboard.
 */
function toUnifiedDiff(props: DiffCardProps): string {
  const oldStart = props.oldStartLine ?? props.startLine
  const newStart = props.newStartLine ?? props.startLine
  const header = `--- a/${props.file}\n+++ b/${props.file}`
  const hunk = `@@ -${oldStart},${props.oldLines.length} +${newStart},${props.newLines.length} @@`
  const removed = props.oldLines.map((l) => `-${l}`)
  const added = props.newLines.map((l) => `+${l}`)
  return [header, hunk, ...removed, ...added].join('\n')
}

/**
 * diff 是「要验收的产出物」——默认就把变更摊开让用户当场读（默认展开验收）。
 * 仅当变更很大（> 14 行）才折叠到这个预算 + 常驻「展开」按钮，避免整文件级
 * diff 铺满 chat。小/中改动直接全展开。
 *
 * Phase2 Task6：折叠 body 按 min(total, DIFF_COLLAPSED_LINES) * leading-[18px] 预留高度，
 * 流式 0→N 时单调增长；用户展开大 diff 后取消强制 minHeight。
 */
export const DIFF_COLLAPSED_LINES = 14
/** 与 ScrollArea `leading-[18px]` 对齐的行高预算。 */
export const DIFF_LINE_HEIGHT_PX = 18

export function diffCollapsedBodyMinHeightPx(totalLines: number): number {
  return Math.min(Math.max(0, totalLines), DIFF_COLLAPSED_LINES) * DIFF_LINE_HEIGHT_PX
}

function splitCollapsedLineBudget(oldCount: number, newCount: number): { oldBudget: number; newBudget: number } {
  const total = oldCount + newCount
  if (total <= DIFF_COLLAPSED_LINES) return { oldBudget: oldCount, newBudget: newCount }

  let oldBudget = oldCount > 0
    ? Math.max(1, Math.round(DIFF_COLLAPSED_LINES * oldCount / total))
    : 0
  let newBudget = DIFF_COLLAPSED_LINES - oldBudget

  if (newCount > 0 && newBudget < 1) {
    newBudget = 1
    oldBudget = DIFF_COLLAPSED_LINES - 1
  }

  oldBudget = Math.min(oldCount, oldBudget)
  newBudget = Math.min(newCount, newBudget)

  let spare = DIFF_COLLAPSED_LINES - oldBudget - newBudget
  if (spare > 0 && oldCount > oldBudget) {
    const take = Math.min(spare, oldCount - oldBudget)
    oldBudget += take
    spare -= take
  }
  if (spare > 0 && newCount > newBudget) {
    newBudget += Math.min(spare, newCount - newBudget)
  }

  return { oldBudget, newBudget }
}

const DiffCard: React.FC<DiffCardProps> = React.memo(
  ({ file, startLine, endLine, oldLines, newLines, replacements, oldStartLine, newStartLine, tabScopeKey }) => {
    const { t } = useTranslation('chat')
    const { openInTabCode } = useFileOpenAction()
    const [copied, setCopied] = useState(false)

    const totalLines = oldLines.length + newLines.length
    const shouldCollapse = totalLines > DIFF_COLLAPSED_LINES
    const [isExpanded, setIsExpanded] = useState(false)
    const effectiveExpanded = !shouldCollapse || isExpanded
    // 折叠/小 diff：按可见行预算占位；用户展开大 diff 后放开，避免永久撑高。
    const bodyMinHeightPx =
      shouldCollapse && isExpanded ? undefined : diffCollapsedBodyMinHeightPx(totalLines)

    const handleToggleExpand = useCallback(() => {
      setIsExpanded(prev => !prev)
    }, [])

    const handleCopy = useCallback(() => {
      const text = toUnifiedDiff({
        file,
        startLine,
        endLine,
        oldLines,
        newLines,
        replacements,
        oldStartLine,
        newStartLine,
      })
      safeCopyToClipboard(text, () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    }, [file, startLine, endLine, oldLines, newLines, replacements, oldStartLine, newStartLine])

    const additions = newLines.length
    const removals = oldLines.length
    // 按文件后缀推语法语言（命不中则不高亮，原样纯文本）
    const lang = useMemo(() => langFromFileName(file), [file])

    const { visibleOld, visibleNew } = useMemo(() => {
      if (effectiveExpanded) return { visibleOld: oldLines, visibleNew: newLines }
      const { oldBudget, newBudget } = splitCollapsedLineBudget(oldLines.length, newLines.length)
      return {
        visibleOld: oldLines.slice(0, oldBudget),
        visibleNew: newLines.slice(0, newBudget),
      }
    }, [effectiveExpanded, oldLines, newLines])

    // 行号列宽自适应：根据最大行号位数决定 ch 单位宽度。
    //
    // 旧实现写死 `w-8` (32px)：3 位行号刚好顶满，4+ 位会撞到 `+/-` 列。W14 把
    // 大 diff 默认完整展开后这个问题更明显——本卡片可能被用来渲染整个文件级别
    // 的 diff（行号 1000+）。`+1` 是给末尾留 0.5ch 空隙避免数字贴边。
    const lineNumChars = useMemo(() => {
      const maxLine = Math.max(
        (oldStartLine ?? startLine) + visibleOld.length - 1,
        (newStartLine ?? startLine) + visibleNew.length - 1,
        endLine,
      )
      return Math.max(2, String(Math.max(1, maxLine)).length) + 1
    }, [startLine, endLine, oldStartLine, newStartLine, visibleOld.length, visibleNew.length])
    const lineNumStyle: React.CSSProperties = { width: `${lineNumChars}ch` }
    const toggleLabel = isExpanded
      ? t('card.collapse_diff', { defaultValue: '收起' })
      : t('card.expand_diff', {
          total: totalLines,
          defaultValue: `展开全部 (${totalLines} 行)`,
        })

    const handleOpenInIde = useCallback((path: string) => {
      void openInTabCode(path, {
        line: (newStartLine ?? startLine) > 0 ? (newStartLine ?? startLine) : undefined,
        endLine: endLine > 0 ? endLine : undefined,
        // HEAD vs 工作区：突出 Agent 刚改的内容
        gitDiffMode: 'head',
        tabScopeKey,
      })
    }, [openInTabCode, startLine, endLine, newStartLine, tabScopeKey])

    return (
      <div className="overflow-hidden">
        <FileCardHeader
          filePath={file}
          onTitleClick={handleOpenInIde}
          meta={
            <span className={cn('inline-flex items-center gap-1.5', TEXT.meta, TEXT_COLOR.muted)}>
              {additions > 0 && <span className={DIFF.addText}>+{additions}</span>}
              {removals > 0 && <span className={DIFF.removeText}>-{removals}</span>}
              <span className={TEXT_COLOR.faint}>
                L{startLine}-{endLine}
              </span>
              <ChatIconTooltip content={t('card.openDiffInIde', { defaultValue: '在 IDE 中查看 Diff' })}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleOpenInIde(file)
                  }}
                  className={cn(
                    'p-0.5 rounded hover:bg-foreground/10 transition-colors',
                    TEXT_COLOR.muted,
                  )}
                  aria-label={t('card.openDiffInIde', { defaultValue: '在 IDE 中查看 Diff' })}
                >
                  <PanelsTopLeft className={ICON_SIZE.sm} />
                </button>
              </ChatIconTooltip>
              <ChatIconTooltip content={t('card.copy_diff')}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCopy()
                  }}
                  className={cn(
                    'p-0.5 rounded hover:bg-foreground/10 transition-colors',
                    TEXT_COLOR.muted,
                  )}
                  aria-label={t('card.copy_diff')}
                >
                  {copied ? <Check className={ICON_SIZE.sm} /> : <Copy className={ICON_SIZE.sm} />}
                </button>
              </ChatIconTooltip>
            </span>
          }
        />

        <div className="group/diff-body relative">
          {/*
           * Diff body
           *
           * 高度策略：折叠态直接裁成 4 行，展开态铺开完整 diff，由外层聊天区滚动。
           * 横向滚动仍由 ScrollArea 处理（长行不换行）。
           */}
          {/*
           * `tabtin-code-hl` = 语法高亮色彩作用域（globals.css）。红绿只留在
           * 行背景（DIFF.addBg/removeBg）与行首 +/- 标记上；代码本身走语法色，
           * 不再被整行染成红/绿（可读性更高）。
           */}
          <ScrollArea
            data-testid="diff-body"
            className={cn(
              'tabtin-code-hl',
              TEXT.code,
              'leading-[18px]',
            )}
            style={
              bodyMinHeightPx != null && bodyMinHeightPx > 0
                ? { minHeight: bodyMinHeightPx }
                : undefined
            }
            scrollBar="both"
          >
            {visibleOld.map((line, i) => (
              <div key={`old-${i}`} data-diff-row="remove" className={cn('flex', DIFF.removeBg)}>
                <span
                  className={cn(
                    'inline-block text-right shrink-0 pr-1 select-none tabular-nums',
                    TEXT_COLOR.faint,
                  )}
                  style={lineNumStyle}
                >
                  {(oldStartLine ?? startLine) + i}
                </span>
                <span className={cn('select-none shrink-0 w-4 text-center', DIFF.removeText)}>-</span>
                <span className="whitespace-pre"><HighlightedCode code={line} lang={lang} /></span>
              </div>
            ))}
            {visibleNew.map((line, i) => (
              <div key={`new-${i}`} data-diff-row="add" className={cn('flex', DIFF.addBg)}>
                <span
                  className={cn(
                    'inline-block text-right shrink-0 pr-1 select-none tabular-nums',
                    TEXT_COLOR.faint,
                  )}
                  style={lineNumStyle}
                >
                  {(newStartLine ?? startLine) + i}
                </span>
                <span className={cn('select-none shrink-0 w-4 text-center', DIFF.addText)}>+</span>
                <span className="whitespace-pre"><HighlightedCode code={line} lang={lang} /></span>
              </div>
            ))}
          </ScrollArea>

          {/* 展开/收起：常驻底部按钮（不再 hover 才浮现）——大 diff 也一眼能看到入口 */}
          {shouldCollapse && (
            <button
              type="button"
              onClick={handleToggleExpand}
              aria-label={toggleLabel}
              title={toggleLabel}
              className={cn(
                'flex w-full items-center justify-center gap-1 border-t py-1 transition-colors',
                BORDER.subtle,
                TEXT.meta,
                TEXT_COLOR.muted,
                'hover:bg-muted/20 hover:text-foreground',
              )}
            >
              {isExpanded ? <ChevronUp className={ICON_SIZE.sm} /> : <ChevronDown className={ICON_SIZE.sm} />}
              {toggleLabel}
            </button>
          )}
        </div>
      </div>
    )
  }
)

DiffCard.displayName = 'DiffCard'

/**
 * `DiffCardRenderer` —— 渲染 edit_file 工具结果。
 *
 * **流式策略与 FileWriteCard 不同**：edit_file 的 unified diff（旧/新行对比）
 * 不适合逐字 stream（用户看到一个未闭合的"-某行的前缀"+"加号 + 新行"会混乱）。
 * 所以 phase=start 期间只显示「正在编辑 xxx.html…」占位（FileCardHeader + spinner +
 * 文案），phase=end 来时一次性切到完整 diff——保留旧实现的折叠/+_- 数字/复制等
 * 完整能力。
 *
 * **流式 path 仍然订阅**：用 useFileToolStreaming 拿 partial path，让 LLM 还在
 * 决策"编辑哪个文件"时，FileCardHeader 的标题区已经能显示出文件名（至少是部分）。
 */
export const DiffCardRenderer: React.FC<CardRendererProps> = React.memo((props) => {
  const { t } = useTranslation('chat')
  const { id, input, output, data, error, phase, sessionId, tabScopeKey } = props

  // 流式拿 partial path；finalContent 不订阅（diff 工具没有 contents 字段，
  // 流式期间只用 path 的部分提示文件名）
  const inp = ((input as Record<string, unknown> | undefined)?.kwargs ?? input ?? {}) as Record<string, unknown>
  const finalPath = String(inp.path ?? '') || ((data as DiffOutputData | undefined)?.file ?? '')
  const { streamingPath, isStreaming } = useFileToolStreaming({
    sessionId,
    toolCallId: id,
    toolName: 'edit_file',
    finalPath: finalPath || null,
    // 不让 hook 因 finalContent 缺失就一直订阅——传个 sentinel 串告诉它"不必看 contents"
    finalContent: '',
  })

  if (error) return <ErrorBanner error={error} />

  const path = finalPath || streamingPath || ''

  // **统一 phase=start/end 渲染路径（W4.5 §流式 diff）**：
  //
  // 旧实现把 phase=start 锁定在 FileToolPlaceholder/header 占位，phase=end
  // 才渲染 diff——但 LLM 流式期间 input 里已经有 `path / old_string /
  // new_string`，`extractDiff` 在 ToolStepCard 已经把 input 当 output 喂进
  // 来解出 `data`（fileToolCards.ts:50-61 同时支持 `old_lines` 数组形态和
  // `old_string` 字符串形态）。完全可以在 phase=start 阶段就画出 partial diff，
  // diff 逐行长出来的流式体感。
  //
  // 策略：**优先看 data 是否解出 → 直接渲 diff**（不论 phase）；否则 phase=start
  // 走带 header 的 placeholder（让用户看到文件名 + spinner，感知到工具已启动），
  // phase=end 但仍无数据则 `return null`（保持旧行为，避免在工具失败时画空卡片）。
  const diff: DiffOutputWithHunks | null | undefined = (data as DiffOutputWithHunks | null | undefined)
    ?? (output as DiffOutputWithHunks | null | undefined)
  const hasDiff = !!diff && typeof diff === 'object'

  if (!hasDiff) {
    if (phase !== 'start') return null
    if (!path) {
      return (
        <FileToolPlaceholder
          icon={<FilePenLine className={cn(ICON_SIZE.lg, TEXT_COLOR.muted, 'shrink-0')} />}
          text={t('card.fileEdit.preparing', { defaultValue: '准备编辑文件…' })}
        />
      )
    }
    return (
      <div className="overflow-hidden">
        <FileCardHeader
          filePath={path}
          meta={
            <span className={cn('inline-flex items-center gap-1.5', TEXT.meta, TEXT_COLOR.faint)}>
              <Loader2 className={cn(ICON_SIZE.sm, ANIMATION.spin)} />
              {isStreaming
                ? t('card.fileEdit.streamingShort', { defaultValue: 'Editing…' })
                : t('card.fileEdit.editingShort', { defaultValue: 'Editing' })}
            </span>
          }
        />
      </div>
    )
  }

  // 有 diff 数据 — 不论 phase=start（流式 partial diff）还是 phase=end（完整 diff）
  // 都用同一段渲染路径。两者唯一区别：phase=start 阶段 file/start_line/end_line
  // 等元信息可能从 input.path 推算，oldLines/newLines 是 partial JSON 截断后的
  // 字符串 split 结果——视觉上会逐行长出来。

  const file = diff.file ?? path
  const startLine = diff.start_line ?? 0
  const endLine = diff.end_line ?? startLine
  const oldLines: string[] = diff.old_lines ?? EMPTY_LINES
  const newLines: string[] = diff.new_lines ?? EMPTY_LINES
  const replacements = diff.replacements

  if (oldLines.length === 0 && newLines.length === 0) {
    return <div className="text-body text-muted-foreground/60 px-3 py-2">{t('card.diff_empty')}</div>
  }

  if (diff.hunks && diff.hunks.length > 0) {
    return (
      <div className="space-y-2">
        {diff.hunks.map((item, index) => (
          <DiffCard
            key={`${item.file}-${index}`}
            file={item.file}
            startLine={item.new_start_line ?? item.old_start_line ?? 0}
            endLine={(item.new_start_line ?? item.old_start_line ?? 0) + Math.max(item.new_lines?.length ?? 1, 1) - 1}
            oldLines={item.old_lines ?? EMPTY_LINES}
            newLines={item.new_lines ?? EMPTY_LINES}
            replacements={item.replacements}
            oldStartLine={item.old_start_line}
            newStartLine={item.new_start_line}
            tabScopeKey={tabScopeKey}
          />
        ))}
      </div>
    )
  }

  return (
    <DiffCard
      file={file}
      startLine={startLine}
      endLine={endLine}
      oldLines={oldLines}
      newLines={newLines}
      replacements={replacements}
      tabScopeKey={tabScopeKey}
    />
  )
})

DiffCardRenderer.displayName = 'DiffCardRenderer'

registerCardRenderer('DiffCard', DiffCardRenderer)

export { DiffCard }
export default DiffCard
