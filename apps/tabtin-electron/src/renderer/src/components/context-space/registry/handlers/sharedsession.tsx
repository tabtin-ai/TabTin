import React from 'react'
import { Loader2, Share2 } from 'lucide-react'
import i18n from '@/i18n'
import type { ContextTypeHandler } from '../types'
import { metaBool, metaStr } from '../homeSections/metaFieldUtils'
import { SHARED_SESSION_TAB_TYPE } from '@/components/chat/shared-view/openSharedSessionInIm'

const SharedSessionConversationPane = React.lazy(() =>
  import('@/components/chat/shared-view/SharedSessionConversationPane').then(module => ({
    default: module.SharedSessionConversationPane,
  })),
)

export const sharedSessionHandler: ContextTypeHandler = {
  type: SHARED_SESSION_TAB_TYPE,
  renderMode: 'pane',
  // ：切走即卸载，避免 hidden ChatPanel 与回首页同帧挂卸打出
  keepAlive: false,
  persistOnly: true,
  closable: true,
  requireResourceMembership: false,
  getTabLabel: item => metaStr(item.meta, 'title') || item.title || i18n.t('chat:sharedPane.untitled', {
    defaultValue: '共享会话',
  }),
  getTabIcon: () => <Share2 className="h-4 w-4 shrink-0 text-emerald-600" />,
  resolveTabItem: (id, context) => ({
    type: SHARED_SESSION_TAB_TYPE,
    id,
    tabKey: context.tabKey,
    title: context.persistedItem?.title,
    meta: context.persistedItem?.meta,
  }),
  renderPane: item => {
    const conversationId = metaStr(item.meta, 'conversationId')
    if (!conversationId) return null
    return (
      <React.Suspense fallback={<div className="flex h-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}>
        <SharedSessionConversationPane
          sessionId={item.id}
          conversationId={conversationId}
          shareId={metaStr(item.meta, 'shareId')}
          organizationId={metaStr(item.meta, 'organizationId')}
          workspaceId={metaStr(item.meta, 'workspaceId')}
          workspaceName={metaStr(item.meta, 'workspaceName')}
          ownerUserId={metaStr(item.meta, 'ownerUserId')}
          ownerDisplayName={metaStr(item.meta, 'ownerDisplayName')}
          incoming={metaBool(item.meta, 'incoming')}
        />
      </React.Suspense>
    )
  },
  buildCanvasContent: item => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: tabKey => ({ tabKey }),
}
