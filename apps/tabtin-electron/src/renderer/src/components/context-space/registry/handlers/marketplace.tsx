import React, { Suspense } from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Store } from 'lucide-react'
import i18n from '@/i18n'
import type { ContextTypeHandler } from '../types'
import { PaneLoadingSkeleton } from '@components/common/ListSkeletons'
import { metaStr } from '../homeSections/metaFieldUtils'

const LazyMarketplacePanel = React.lazy(() =>
  import('../../marketplace/MarketplacePanel').then(m => ({ default: m.MarketplacePanel })),
)

export const marketplaceHandler: ContextTypeHandler = {
  type: 'marketplace',
  appId: 'marketplace',
  persistOnly: true,
  appEntryMode: 'panel',
  sidebarPanel: LazyMarketplacePanel,
  displayLabel: 'Marketplace',
  displayEmoji: '✨',
  agent: {
    displayName: '增强',
    capability: '发现并安装组织或 Space 可用的 Skill 与应用能力',
    aliases: ['技能市场', '应用市场', '市场', '增强'],
  },
  getTabLabel: () => i18n.t('marketplace.title', { ns: 'context', defaultValue: 'Marketplace' }),
  getTabIcon: () => <TabTypeEmoji appIdOrType="marketplace" />,
  renderPane: (item) => {
    const spaceId = metaStr(item.meta, 'spaceId') ?? item.id

    return (
      <Suspense fallback={<PaneLoadingSkeleton />}>
        <LazyMarketplacePanel spaceId={spaceId} />
      </Suspense>
    )
  },
}
