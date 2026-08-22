import React from 'react'
import { Cloud, Paperclip, Loader2, Share2 } from 'lucide-react'
import i18next from 'i18next'
import type { ContextTypeHandler, ContextItem } from '../types'
import { metaStr } from '../homeSections/metaFieldUtils'
import { IM_ASSETS_TAB_TYPE, parseImAssetsId, type ImAssetKind } from '../../imAssetsTab'

const ImConversationAssetPane = React.lazy(() =>
  import('@components/tabchat/ImConversationAssetPane').then((m) => ({
    default: m.ImConversationAssetPane,
  })),
)

const ImSharedSessionsPane = React.lazy(() =>
  import('@components/tabchat/ImSharedSessionsPane').then((m) => ({
    default: m.ImSharedSessionsPane,
  })),
)

type AssetKind = ImAssetKind

function assetKindFromItem(item: ContextItem): AssetKind {
  const metaKind = metaStr(item.meta, 'kind')
  if (metaKind === 'file' || metaKind === 'document' || metaKind === 'shared_session') {
    return metaKind
  }
  return parseImAssetsId(item.id)?.kind ?? 'document'
}

/**
 * imassets —— IM 会话桌面画布内的「会话资产」列表 tab（云盘 / 文件）。
 * persistOnly：无 live source，纯靠持久化 tabOrder 存活；内部 pane 自行拉取会话历史。
 * 不声明 agent 字段 → 视为内部 UI tab，不暴露给 Agent。
 */
export const imassetsHandler: ContextTypeHandler = {
  type: IM_ASSETS_TAB_TYPE,
  persistOnly: true,
  keepAlive: true,

  getTabLabel: (item) => {
    const kind = assetKindFromItem(item)
    if (kind === 'file') {
      return i18next.t('tabchat:contentFilterFiles', { defaultValue: '文件' })
    }
    if (kind === 'shared_session') {
      return i18next.t('context:canvasRail.assetSharedSessions', { defaultValue: '共享对话' })
    }
    return i18next.t('context:canvasRail.assetDocuments', { defaultValue: '云盘' })
  },

  getTabIcon: (item) => {
    const kind = assetKindFromItem(item)
    if (kind === 'file') {
      return <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
    }
    if (kind === 'shared_session') {
      return <Share2 className="h-4 w-4 shrink-0 text-emerald-600" />
    }
    return <Cloud className="h-4 w-4 shrink-0 text-blue-500" />
  },

  renderPane: (item) => {
    const parsed = parseImAssetsId(item.id)
    const kind = assetKindFromItem(item)
    const conversationId = metaStr(item.meta, 'conversationId') ?? parsed?.conversationId ?? ''
    if (!conversationId) return null
    return (
      <React.Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        }
      >
        {kind === 'shared_session' ? (
          <ImSharedSessionsPane conversationId={conversationId} />
        ) : (
          <ImConversationAssetPane conversationId={conversationId} kind={kind} />
        )}
      </React.Suspense>
    )
  },
}
