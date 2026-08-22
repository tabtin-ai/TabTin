import React from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { Brain, Loader2 } from 'lucide-react'
import i18next from 'i18next'
import type { ContextTypeHandler } from '../types'
import { metaStr } from '../homeSections/metaFieldUtils'

const AgentDiaryFeed = React.lazy(
  () => import('@components/agent-memory/AgentDiaryFeed').then(m => ({ default: m.AgentDiaryFeed }))
)

export const agentdiaryHandler: ContextTypeHandler = {
  type: 'agentdiary',
  appId: 'agentdiary',
  persistOnly: true,
  displayLabel: 'Agent Diary',
  displayEmoji: '🧠',
  agent: {
    // UI 实际叫 "Tin's Memory"——Agent 跟用户对话时也用同一个名字，避免 UI/Agent 双轨。
    displayName: "Tin's Memory",
    capability: '查看 Agent 跨会话的活动记忆 / 笔记 / 学到的事实——Agent 自己的"记忆面板"。',
    aliases: ['diary', 'memory', '记忆', '日记', 'agent diary'],
  },

  getTabLabel: () => i18next.t('context:agentDiary.tabLabel', { defaultValue: "Tin's Memory" }),

  getTabIcon: () => <TabTypeEmoji appIdOrType="agentdiary" />,

  keepAlive: true,

  renderPane: (item, ctx) => {
    const spaceId = metaStr(item.meta, 'spaceId') ?? ctx?.spaceId ?? ''
    const organizationId = metaStr(item.meta, 'organizationId') ?? ''
    const initialFilter = metaStr(item.meta, 'filter') ?? 'all'
    const agentId = metaStr(item.meta, 'agentId')
    const agentName = metaStr(item.meta, 'agentName') ?? 'Tin'
    const agentAvatar = metaStr(item.meta, 'agentAvatar')

    return (
      <React.Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <div
          className="h-full w-full"
          onPointerDownCapture={() => ctx?.onPaneInteraction?.()}
          onFocusCapture={() => ctx?.onPaneInteraction?.()}
          onKeyDownCapture={() => ctx?.onPaneInteraction?.()}
        >
          <AgentDiaryFeed
            spaceId={spaceId}
            organizationId={organizationId}
            agentId={agentId}
            agentName={agentName}
            agentAvatar={agentAvatar}
            initialFilter={initialFilter}
            className="h-full w-full"
          />
        </div>
      </React.Suspense>
    )
  },
}
