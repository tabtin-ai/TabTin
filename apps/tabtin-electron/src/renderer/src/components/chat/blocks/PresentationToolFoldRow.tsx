/**
 * PresentationToolFoldRow — 富内容呈现类工具的折叠卡片头（与 ToolStepCard 同款 step row）。
 *
 * 产物仍在独立 mini-message 气泡里渲染；工具卡只承担「折叠行 + 可选简介」，
 * 避免 compact 单行与周边工具步骤视觉不一致。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import {
  BG,
  CARD_PADDING,
  CARD_RADIUS,
  ICON_SIZE,
  STEP_ROW,
  SUNKEN_SHELL,
  TEXT,
  TEXT_COLOR,
} from '../registry/chatDesignTokens'
import {
  getCompactSummary,
  getToolDescriptor,
  getToolIcon,
} from '../registry/toolCardRegistry'
import { getToolDisplayName } from '../registry/toolDisplayName'
import { resolveIcon } from '../registry/iconMap'
import { getNestedArgs } from '../registry/toolCardUtils'
import { getCollapsedToolLabel } from '../tool/toolCollapsedLabel'
import { ShinyText } from '../markdown/ShinyText'

function extractPresentDetails(input: unknown): { title?: string; summary?: string } {
  const args = getNestedArgs(input)
  if (!args) return {}
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
  const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : undefined
  return { title, summary }
}

export const PRESENTATION_FOLD_TOOLS: ReadonlySet<string> = new Set(['present_to_user'])

export function isPresentationFoldTool(toolName: string): boolean {
  return PRESENTATION_FOLD_TOOLS.has(toolName)
}

export const PresentationToolFoldRow: React.FC<{
  toolName: string
  input: unknown
  finalized: boolean
  /** finalized 的 partial 兜底态不含完整参数，不能展示其标题或摘要。 */
  inputFinalized: boolean
}> = ({ toolName, input, finalized, inputFinalized }) => {
  const { t } = useTranslation('chat')
  const descriptor = getToolDescriptor(toolName)
  const label = getToolDisplayName(t, toolName)
  const compactSummary = useMemo(
    () => inputFinalized ? getCompactSummary(toolName, input) : null,
    [toolName, input, inputFinalized],
  )
  const collapsedLabel = getCollapsedToolLabel({
    input,
    inputFinalized,
    compactSummary,
    fallbackLabel: label,
  })
  const details = useMemo(
    () => inputFinalized ? extractPresentDetails(input) : {},
    [input, inputFinalized],
  )
  const hasExpandBody = inputFinalized && Boolean(
    (details.title && details.title !== collapsedLabel)
    || (details.summary && details.summary !== collapsedLabel),
  )

  const defaultExpanded = !finalized || !descriptor?.defaultCollapsed
  const [expanded, setExpanded] = useState(defaultExpanded)
  useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded])

  const iconName = getToolIcon(toolName)
  const Icon = resolveIcon(iconName)

  return (
    <div data-testid="block-tool-use-presentation-fold" data-tool-name={toolName}>
      <button
        type="button"
        className={STEP_ROW.button}
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <Icon className={cn(ICON_SIZE.md, 'shrink-0', STEP_ROW.icon)} />
        {finalized ? (
          <span className={STEP_ROW.label}>{collapsedLabel}</span>
        ) : (
          <ShinyText className={cn(STEP_ROW.label, 'truncate')}>{collapsedLabel}</ShinyText>
        )}
        <span
          className={cn(
            'shrink-0 transition-opacity',
            expanded ? 'opacity-100' : 'opacity-0 group-hover/step:opacity-100',
          )}
        >
          {expanded
            ? <ChevronDown className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'transition-colors group-hover/step:text-foreground')} />
            : <ChevronRight className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'transition-colors group-hover/step:text-foreground')} />}
        </span>
      </button>

      {expanded && hasExpandBody && (
        <div className="mt-0.5">
          <div className={cn(CARD_RADIUS, 'overflow-hidden', BG.codeSunken, SUNKEN_SHELL, CARD_PADDING.x, CARD_PADDING.y)}>
            {details.title && details.title !== collapsedLabel && (
              <p className={cn(TEXT.body, TEXT_COLOR.secondary, 'break-words')}>{details.title}</p>
            )}
            {details.summary && details.summary !== collapsedLabel && (
              <p className={cn(TEXT.body, TEXT_COLOR.muted, 'break-words', details.title ? 'mt-1' : undefined)}>
                {details.summary}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

PresentationToolFoldRow.displayName = 'PresentationToolFoldRow'
