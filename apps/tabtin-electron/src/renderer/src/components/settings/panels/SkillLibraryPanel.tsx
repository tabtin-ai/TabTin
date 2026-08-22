/**
 * SkillLibraryPanel — 全局技能库（ W3 / ）。
 *
 * 挂在「个人设置 → 我的 AI → 技能库」。目录按 organizationId 加载，与 Agent 无关；
 * spaceId 仅给 SkillPanel 本地 IPC（list/install）用，可缺省为空。
 */
import React, { Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { cn } from '@utils/cn'
import {
  useCompositeTabActive,
  useSettingsPanelHeaderFooter,
} from '../SettingsPanelHeader'

const LazySkillPanel = React.lazy(() =>
  import('@components/context-space/skills/SkillPanel').then(m => ({ default: m.SkillPanel })),
)

/**
 * 解析全局技能库的查询锚 Space（当前选中 → 当前团队第一个）。
 * 导出供「我的 Agent」面板复用同一套上下文解析（技能池 picker 查询锚）。
 */
export function useSkillLibraryContextSpaceId(
  organizationId?: string | null,
): string | null {
  const selectedOrganizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const effectiveOrganizationId = organizationId === undefined
    ? selectedOrganizationId
    : organizationId
  return useSpaceStore(state => {
    const selected = state.selectedSpace
    if (selected && (!effectiveOrganizationId || selected.organization_id === effectiveOrganizationId)) {
      return selected.id
    }
    const fallbackSpace = effectiveOrganizationId
      ? state.spaces.find(s => s.organization_id === effectiveOrganizationId)
      : state.spaces[0]
    return fallbackSpace?.id ?? null
  })
}

export interface SkillLibraryPanelProps {
  /** 一级 Skill 工作台铺满主画布；设置入口保留设置面板的可读宽度。 */
  standalone?: boolean
  /**
   * app-page 嵌入：外边距/页眉由 AppFullPageHost 承接，
   * 不再渲染 SkillPanel 内置同款标题。
   */
  embeddedInWorkbench?: boolean
}

export const SkillLibraryPanel: React.FC<SkillLibraryPanelProps> = ({
  standalone = false,
  embeddedInWorkbench = false,
}) => {
  const { t } = useTranslation('settings')
  // ：技能库只锚 organizationId；spaceId 给本地 IPC，不要求 selectedAgent。
  const organizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const spaceId = useSkillLibraryContextSpaceId(organizationId)
  const tabBar = useSettingsPanelHeaderFooter()
  const showTabBar = useCompositeTabActive()

  return (
    <div className={cn(
      'flex h-full min-h-0 w-full flex-col',
      !standalone && !embeddedInWorkbench && 'max-w-5xl',
    )}>
      {tabBar != null && showTabBar ? <div className="mb-1 shrink-0">{tabBar}</div> : null}
      {organizationId ? (
        <div className="min-h-0 flex-1">
          <Suspense fallback={<PaneLoadingSkeleton />}>
            <LazySkillPanel
              spaceId={spaceId ?? ''}
              contentShell={embeddedInWorkbench ? 'bleed' : 'default'}
              hidePageHeader={embeddedInWorkbench}
            />
          </Suspense>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16">
          <Sparkles className="h-6 w-6 text-muted-foreground/40" />
          <p className="text-body text-muted-foreground/80">
            {t('skillLibrary.emptyNoOrganization', {
              defaultValue: '请先选择或创建一个组织，技能库会按组织展示可用技能。',
            })}
          </p>
        </div>
      )}
    </div>
  )
}

export default SkillLibraryPanel
