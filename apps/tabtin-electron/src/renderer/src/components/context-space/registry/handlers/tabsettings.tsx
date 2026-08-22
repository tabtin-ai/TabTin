import React, { Suspense } from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Settings } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { getSpaceSettingsTitle } from '@components/space-settings/settingsTitle'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { metaStr } from '../homeSections/metaFieldUtils'

const LazySpaceSettingsPane = React.lazy(
  () => import('@components/space-settings/SpaceSettingsPane').then(m => ({ default: m.SpaceSettingsPane }))
)

const getTitle = (spaceId?: string) => getSpaceSettingsTitle(spaceId)

export const tabsettingsHandler: ContextTypeHandler = {
  type: 'tabsettings',
  persistOnly: true,
  displayLabel: 'AgentSettings',
  displayEmoji: '⚙️',

  getTabLabel: (item) => getTitle(metaStr(item.meta, 'spaceId') ?? item.id),
  getTabIcon: () => <TabTypeEmoji appIdOrType="tabsettings" />,

  onSelect: (item, ctx) => {
    const section = metaStr(item.meta, 'section')
    useSpaceContextTabsStore.getState().openResourceTab(ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId), {
      type: 'tabsettings',
      id: ctx.spaceId,
      title: getTitle(ctx.spaceId),
      meta: { spaceId: ctx.spaceId, section },
    })
  },

  renderPane: (item) => {
    const spaceId = metaStr(item.meta, 'spaceId') ?? item.id
    const section = metaStr(item.meta, 'section')
    return (
      <Suspense
        fallback={<PaneLoadingSkeleton showPreview={false} />}
      >
        <LazySpaceSettingsPane
          spaceId={spaceId}
          initialSection={section}
          renderAgentSettingsSheet={false}
        />
      </Suspense>
    )
  },
}
