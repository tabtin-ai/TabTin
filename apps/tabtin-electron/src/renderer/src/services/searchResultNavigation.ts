import { useSpaceListStore, type FtsSearchResultItem } from '@tabtin/app-shell'

import { contextRegistry, type ContextItemType, type ContextTabKey } from '@components/context-space/registry'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { enterChatSession } from '@/services/chatSessionNavigation'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useTabDocRevealStore } from '@stores/useTabDocRevealStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { buildTabDocSearchReveal, firstSearchString, textContainsSearchQuery } from './tabDocSearchReveal'

export type NavigateSearchResultPayload = {
  item: FtsSearchResultItem
  committedQuery?: string
}

function tt(key: string, defaultValue: string): string {
  const t = window.i18n?.t
  if (typeof t === 'function') {
    return t(key, { defaultValue }) as string
  }
  return defaultValue
}

function queueTabDocSearchReveal(
  item: FtsSearchResultItem,
  resourceId: string,
  committedQuery?: string,
): void {
  const metadata = item.metadata && typeof item.metadata === 'object'
    ? item.metadata as Record<string, unknown>
    : {}
  const hasBodyHighlight = Boolean(
    firstSearchString(item.highlight?.preview) || firstSearchString(item.highlight?.content),
  )
  const hasTitleOnlyHighlight = !hasBodyHighlight && Boolean(firstSearchString(item.highlight?.title))
  const snippet = !hasTitleOnlyHighlight && committedQuery && textContainsSearchQuery(item.snippet, committedQuery)
    ? item.snippet
    : ''
  const reveal = buildTabDocSearchReveal({
    blockId: firstSearchString(metadata.block_id),
    blockIds: metadata.block_ids,
    snippet,
    highlightPreview: item.highlight?.preview,
    highlightContent: item.highlight?.content,
  })
  if (!reveal) return
  useTabDocRevealStore.getState().setPendingReveal(resourceId, {
    kind: 'doc_selection',
    ...reveal,
  })
}

/**
 * 执行搜索结果导航——必须在**主 renderer** 调用：导航全靠主窗口的 store 单例
 * （useSpaceListStore / useCrawlTabStore）与 enterChatSession / contextRegistry 驱动。
 * 全局搜索 UI 跑在透明子窗口（独立 renderer），点击结果经 IPC 把 item 代理到主 renderer
 * 调用本函数执行（见 ）。
 */
export async function navigateSearchResult(
  item: FtsSearchResultItem,
  opts: { committedQuery?: string } = {},
): Promise<void> {
  const organizationId = useOrganizationStore.getState().selectedOrganization?.id
  const activeSpaceId = useSpaceStore.getState().selectedSpace?.id ?? null
  const committedQuery = opts.committedQuery

  try {
    switch (item.type) {
      case 'message': {
        if (!item.space_id || !item.session_id) return
        await enterChatSession(item.space_id, item.session_id, {
          organizationId,
          messageId: item.id,
          highlightMessage: true,
          highlightTerms: committedQuery ? [committedQuery] : undefined,
          loadContextWindow: 20,
        })
        return
      }
      case 'im': {
        const convId = item.session_id
        if (!convId) return
        const ok = useSpaceListStore.getState().activateConversation(convId)
        if (!ok) {
          toast.error(tt('navigate.imNotFound', '该 IM 会话不在当前列表中（可能正在加载或已被删除）'))
        }
        return
      }
      case 'space': {
        const ok = useSpaceListStore.getState().activateSpace(item.id)
        if (!ok) {
          toast.error(tt('navigate.spaceNotFound', '该 Space 不在当前列表中（可能正在加载或无访问权限）'))
          return
        }
        // closeMemo 不再切 tab；从消息域搜进 Space 须显式回任务
        useMainNavStore.getState().setCurrentTab('agent')
        return
      }
      case 'agent': {
        const spaceIds = (item.metadata?.space_ids as string[] | undefined) || []
        if (!spaceIds[0]) {
          toast.info(tt('navigate.agentNoSpace', '该 Agent 暂无可进入的 Space'))
          return
        }
        const ok = useSpaceListStore.getState().activateSpace(spaceIds[0])
        if (!ok) {
          toast.error(tt('navigate.agentSpaceNotFound', '该 Agent 的主 Space 不在当前列表中'))
          return
        }
        useMainNavStore.getState().setCurrentTab('agent')
        return
      }
      case 'resource': {
        if (!item.space_id) return
        const rawItemType = item.metadata?.item_type as string | undefined
        if (!rawItemType) {
          toast.error(tt('navigate.resourceTypeMissing', '该资源缺少类型信息，暂时无法打开'))
          return
        }
        const resourceType = contextRegistry.normalizeBackendType(rawItemType) as ContextItemType
        if (!contextRegistry.isKnownType(resourceType)) {
          toast.error(tt('navigate.resourceTypeUnsupported', '暂不支持打开该类型资源'))
          return
        }
        const sameSpace = activeSpaceId === item.space_id
        const ok = useSpaceListStore.getState().activateSpace(item.space_id)
        if (!ok) {
          toast.error(tt('navigate.spaceNotFound', '该 Space 不在当前列表中（可能正在加载或无访问权限）'))
          return
        }
        useMainNavStore.getState().setCurrentTab('agent')
        const dispatchOpen = () => {
          const tabScopeKey = resolveForegroundTabScopeKey(item.space_id!)
          const cs = useCrawlTabStore.getState().getSpaceCrawlspace(tabScopeKey)
          const resourceId = item.resource_id || item.id
          if (resourceType === 'tabdoc') {
            queueTabDocSearchReveal(item, resourceId, committedQuery)
          }
          const meta = {
            ...(item.metadata as Record<string, unknown>),
            spaceId: item.space_id,
          }
          contextRegistry.dispatchSelect(
            {
              type: resourceType,
              id: resourceId,
              tabKey: `${resourceType}:${resourceId}` as ContextTabKey,
              title: item.title,
              meta,
            },
            {
              spaceId: item.space_id!,
              tabScopeKey,
              crawlspaceId: cs?.id ?? null,
              closeBrowserView: () => {},
            },
          )
        }
        if (sameSpace) {
          dispatchOpen()
        } else {
          setTimeout(dispatchOpen, 80)
        }
        return
      }
      case 'memo': {
        if (item.space_id) {
          const ok = useSpaceListStore.getState().activateSpace(item.space_id)
          if (ok) useMainNavStore.getState().setCurrentTab('agent')
        }
        return
      }
    }
  } catch (err) {
    const { logger } = await import('@/utils/logger')
    logger.error('[searchResultNavigation] navigate failed:', err)
  }
}
