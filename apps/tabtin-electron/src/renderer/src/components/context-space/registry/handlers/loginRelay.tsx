import React from 'react'
import { Globe } from 'lucide-react'
import type { ContextItem, ContextTypeHandler } from '../types'
import { metaStr } from '../homeSections/metaFieldUtils'
import { BrowserPaneRenderer } from './renderers/BrowserPaneRenderer'

/**
 * 本机登录接力标签。
 *
 * 它的标签归属仍是当前聊天的 UI scope，但 crawlspace 不绑定远端执行 Space，
 * 从而保持本机 BrowserView 与远端执行设备的隔离，而不会被远端设备门禁替换。
 */
export const loginRelayHandler: ContextTypeHandler = {
  type: 'login_relay',
  renderMode: 'pane',
  persistOnly: true,
  closable: true,
  requireResourceMembership: false,
  getTabLabel: (item) => item.title || '登录页面',
  getTabIcon: () => <Globe className="h-4 w-4 shrink-0" />,
  resolveTabItem: (id, ctx) => ({
    type: 'login_relay',
    id,
    tabKey: ctx.tabKey,
    title: ctx.persistedItem?.title,
    meta: ctx.persistedItem?.meta,
  }),
  renderPane: (item: ContextItem, ctx) => {
    const crawlspaceId = metaStr(item.meta, 'crawlspaceId')
    if (!crawlspaceId) {
      return <div className="flex h-full items-center justify-center text-muted-foreground">登录页面已失效</div>
    }
    return (
      <BrowserPaneRenderer
        crawlspaceId={crawlspaceId}
        viewId={item.id}
        isGroupActive={ctx.isGroupActive ?? true}
        isPaneActive={ctx.isPaneActive}
        onPaneInteraction={ctx.onPaneInteraction}
      />
    )
  },
}
