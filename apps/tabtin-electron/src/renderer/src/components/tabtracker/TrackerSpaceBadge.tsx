/**
 * Workspace 归属标识：仅在「全部」(organization scope) 下展示。
 * - 跨 Space：↗ + 名称
 * - 当前 Space：只显示名称（无 ↗），方便和跨 Space 任务对照核实
 * space scope / 无名称时不渲染。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import type { ResourceScope } from '@stores/useSpaceViewPrefsStore'
import { isCrossSpaceScopedItem } from '../context-space/resourceScope'

export interface TrackerSpaceBadgeProps {
  resourceScope: ResourceScope
  currentSpaceId: string
  taskSpaceId: string | null | undefined
  spaceName?: string | null
  className?: string
}

export const TrackerSpaceBadge: React.FC<TrackerSpaceBadgeProps> = ({
  resourceScope,
  currentSpaceId,
  taskSpaceId,
  spaceName,
  className,
}) => {
  const { t } = useTranslation('context')
  if (resourceScope !== 'organization') return null

  const label = (spaceName ?? '').trim()
  if (!label) return null

  const crossSpace = isCrossSpaceScopedItem(resourceScope, currentSpaceId, taskSpaceId)

  return (
    <span
      className={cn(
        'inline-flex max-w-[9rem] shrink-0 items-center gap-0.5 truncate rounded-full bg-foreground/[0.04] px-1.5 py-0.5',
        CANVAS_TEXT_META,
        className,
      )}
      title={label || t('home.assetBrowser.otherSpaceBadge')}
    >
      {crossSpace ? <span aria-hidden>↗</span> : null}
      <span className="truncate">{label}</span>
    </span>
  )
}
