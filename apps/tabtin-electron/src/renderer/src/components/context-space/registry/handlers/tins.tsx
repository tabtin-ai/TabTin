import React, { Suspense } from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Puzzle } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { useTinsStore } from '@/stores/useTinsStore'
import { metaStr } from '../homeSections/metaFieldUtils'

const LazyTinPanel = React.lazy(() =>
  import('../../../tins/TinPanel').then((m) => ({ default: m.TinPanel }))
)

export const tinsHandler: ContextTypeHandler = {
  type: 'tins',
  appId: 'tins',
  persistOnly: true,
  displayLabel: 'Tins',
  displayEmoji: '🧩',
  agent: {
    displayName: 'Tins',
    capability: '轻量插件容器：书签 / 下载 / 历史 / 第三方小工具，常驻侧边栏。',
    aliases: ['tin', 'widget', '微件', '小应用', '插件'],
  },
  quickAction: {
    icon: <Puzzle className="h-3.5 w-3.5" />,
    labelKey: 'context:home.quickActions.openTins',
  },
  onNavigateFromList: (metadata) => {
    const tinInstanceId = metaStr(metadata, 'tinInstanceId')
    if (tinInstanceId) useTinsStore.getState().selectTin(tinInstanceId)
  },
  getTabLabel: () => 'Tins',
  getTabIcon: () => <TabTypeEmoji appIdOrType="tins" />,
  getDragPayload: (item) => ({
    type: item.type,
    id: item.id,
    title: item.title,
  }),
  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),
  renderPane: (item) => {
    const spaceId = metaStr(item.meta, 'spaceId') ?? item.id

    return (
      <Suspense
        fallback={<PaneLoadingSkeleton />}
      >
        <LazyTinPanel spaceId={spaceId} />
      </Suspense>
    )
  },
}
