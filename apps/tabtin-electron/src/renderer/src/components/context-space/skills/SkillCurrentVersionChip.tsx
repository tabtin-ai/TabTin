import React from 'react'
import { useTranslation } from 'react-i18next'
import { History } from 'lucide-react'
import { Button } from '@components/ui'
import type { SkillIndexEntry } from '@/skills/types'
import { useSkillVersionsListQuery } from '@/hooks/queries/skills'
import { resolveCurrentSkillVersionLabel } from './skillCurrentVersion'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { cn } from '@utils/cn'

/**
 * 详情页「当前在用」版本 chip。
 * 自拉取版本列表，用 SemVer label 解析——避免缺 installed_version_label 时
 * 误把内部 version_seq 显示成 v2。
 */
export const SkillCurrentVersionChip: React.FC<{
  skill: SkillIndexEntry
  canOpenHistory: boolean
  onOpenHistory: () => void
}> = ({ skill, canOpenHistory, onOpenHistory }) => {
  const { t } = useTranslation('context')
  const skillId = skill.skill_id || null
  const { data: versions = [] } = useSkillVersionsListQuery(
    canOpenHistory ? skillId : null,
  )
  const currentVersionLabel = resolveCurrentSkillVersionLabel(skill, versions)
  if (!currentVersionLabel) return null

  if (canOpenHistory) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onOpenHistory}
        className={cn('h-auto', 'shrink-0', 'gap-1', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-0.5', 'font-normal', 'text-muted-foreground/80', 'hover:bg-foreground/[0.06]', 'hover:text-foreground', CANVAS_TEXT_MICRO)}
        title={t('skills.versionHistory.currentButton')}
      >
        {currentVersionLabel}
        <History className="h-3 w-3" />
      </Button>
    )
  }

  return (
    <span className={cn('inline-flex', 'items-center', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-0.5', 'shrink-0', CANVAS_TEXT_META)}>
      {currentVersionLabel}
    </span>
  )
}

SkillCurrentVersionChip.displayName = 'SkillCurrentVersionChip'
