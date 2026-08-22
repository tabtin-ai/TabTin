import React, { Suspense } from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { BookOpen } from 'lucide-react'
import i18n from '@/i18n'
import type { ContextTypeHandler } from '../types'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { metaStr } from '../homeSections/metaFieldUtils'

const LazySkillPanel = React.lazy(() =>
  import('../../skills/SkillPanel').then(m => ({ default: m.SkillPanel }))
)

export const skillHandler: ContextTypeHandler = {
  type: 'skill',
  appId: 'skill',
  persistOnly: true,
  appEntryMode: 'panel',
  sidebarPanel: LazySkillPanel,
  displayLabel: 'Skills',
  displayEmoji: '🔧',
  agent: {
    displayName: 'Skill',
    capability: '管理本地 skill 包（流程模板），Agent 通过 `skills_search` / `skills_read` 工具消费',
    aliases: ['skills', '技能包', '流程'],
  },
  getTabLabel: () => i18n.t('skills.panel.header', { ns: 'context', defaultValue: 'Skills' }),
  getTabIcon: () => <TabTypeEmoji appIdOrType="skill" />,
  getDragPayload: item => ({
    type: item.type,
    id: item.id,
    title: item.title,
  }),
  buildCanvasContent: item => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: tabKey => ({ tabKey }),
  renderPane: (item) => {
    const spaceId = metaStr(item.meta, 'spaceId') ?? item.id

    return (
      <Suspense fallback={<PaneLoadingSkeleton />}>
        <LazySkillPanel spaceId={spaceId} />
      </Suspense>
    )
  },
}
