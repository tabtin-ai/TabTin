/**
 * Skill 启用目标 Space 选择器。
 *
 * - 只有 1 个候选：不展示列表，只显示「将启用到：{name}」说明。
 * - 多个候选：勾选列表，默认勾选当前 Space；至少保留 1 个。
 */
import React, { useMemo } from 'react'
import { Checkbox } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import {
  defaultSelectedSpaceIds,
  listSkillEnableTargetSpaces,
  type SkillEnableTargetSpace,
} from './skillSpaceTargets'

export interface SkillSpacePickerProps {
  spaceId: string
  organizationId: string | null
  /** 是否启用「装到 Space」这一步；关闭时隐藏选择器。 */
  enabled: boolean
  selectedSpaceIds: string[]
  onSelectedSpaceIdsChange: (ids: string[]) => void
  className?: string
}

export function useSkillEnableTargetSpaces(
  spaceId: string,
  organizationId: string | null,
): SkillEnableTargetSpace[] {
  const spaces = useSpaceStore(state => state.spaces)
  return useMemo(
    () => listSkillEnableTargetSpaces(spaces, organizationId, spaceId),
    [spaces, organizationId, spaceId],
  )
}

export function useDefaultSkillEnableSpaceIds(
  spaceId: string,
  organizationId: string | null,
): string[] {
  const targets = useSkillEnableTargetSpaces(spaceId, organizationId)
  return useMemo(() => defaultSelectedSpaceIds(targets, spaceId), [targets, spaceId])
}

export const SkillSpacePicker: React.FC<SkillSpacePickerProps> = ({
  spaceId,
  organizationId,
  enabled,
  selectedSpaceIds,
  onSelectedSpaceIdsChange,
  className,
}) => {
  const { t } = useTranslation('context')
  const targets = useSkillEnableTargetSpaces(spaceId, organizationId)

  if (!enabled || targets.length === 0) return null

  if (targets.length === 1) {
    return (
      <p className={cn('CANVAS_TEXT_META', className)}>
        {t('skills.spacePicker.willEnableIn', { name: targets[0].name })}
      </p>
    )
  }

  const selected = new Set(selectedSpaceIds)

  const toggle = (id: string) => {
    if (selected.has(id)) {
      if (selected.size <= 1) return
      onSelectedSpaceIdsChange(selectedSpaceIds.filter(x => x !== id))
      return
    }
    onSelectedSpaceIdsChange([...selectedSpaceIds, id])
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <p className={cn('font-medium', 'text-foreground/80', CANVAS_TEXT_META_BASE)}>
        {t('skills.spacePicker.title')}
      </p>
      <p className={CANVAS_TEXT_META}>
        {t('skills.spacePicker.hint')}
      </p>
      <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border/40 bg-background/40 p-1">
        {targets.map(target => {
          const checked = selected.has(target.id)
          return (
            <div
              key={target.id}
              role="button"
              tabIndex={0}
              aria-pressed={checked}
              onClick={() => toggle(target.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle(target.id)
                }
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/30"
            >
              <Checkbox checked={checked} className="pointer-events-none shrink-0" />
              <span className="min-w-0 flex-1 truncate text-body">{target.name}</span>
              {target.isCurrent ? (
                <span className={cn('shrink-0', 'text-muted-foreground/55', CANVAS_TEXT_META)}>
                  {t('skills.spacePicker.current')}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
SkillSpacePicker.displayName = 'SkillSpacePicker'
