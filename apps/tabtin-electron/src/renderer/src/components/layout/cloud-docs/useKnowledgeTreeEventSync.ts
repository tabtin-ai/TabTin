/**
 * 知识库树 WS 自动刷新 — 结构变更才整树 reload；resource_updated 只就地 patch。
 * ：本地删除由 useUnifiedResources.handleWsEvent 模块级同步知识树；
 * 本 hook 只在面板挂载时防抖对账，未挂载期间的漏事件由下次挂载 force reload 兜底。
 */
import { useCallback, useEffect, useRef } from 'react'
import {
  KNOWLEDGE_TREE_DEFAULT_DEPTH,
  useKnowledgeTree,
} from '@/stores/useKnowledgeTree'
import { onResourceEvent, type ResourceWsEvent } from '@/stores/useUnifiedResources'
import { useResourceEventStream } from '@/hooks/useResourceEventStream'

/**
 * 会改变知识树形的事件：整树静默 reload。
 * ：Collection 文件夹事件不刷新知识树（与云盘平行）。
 */
const TREE_STRUCTURAL_EVENTS = new Set([
  'items_reordered',
  'resource_created',
  'resource_trashed',
  'resource_archived',
  'resource_deleted',
  'resource_restored',
  'resource_access_granted',
  'resource_access_revoked',
])

const TREE_REMOVAL_EVENTS = new Set([
  'resource_trashed',
  'resource_archived',
  'resource_deleted',
  'resource_access_revoked',
])

interface UseKnowledgeTreeEventSyncOptions {
  organizationId: string
  enabled?: boolean
}

export function useKnowledgeTreeEventSync({
  organizationId,
  enabled = true,
}: UseKnowledgeTreeEventSyncOptions) {
  const loadTree = useKnowledgeTree(state => state.loadTree)
  const patchNodeMeta = useKnowledgeTree(state => state.patchNodeMeta)
  const removeNodeAndPromoteChildren = useKnowledgeTree(state => state.removeNodeAndPromoteChildren)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 静默 reload：不 invalidate、不 skeleton（store.loadTree 有缓存时不置 loading）
  const refreshTree = useCallback(() => {
    if (!organizationId || organizationId === 'unknown-organization') return
    void loadTree(organizationId, { depth: KNOWLEDGE_TREE_DEFAULT_DEPTH, force: true })
  }, [loadTree, organizationId])

  const refreshTreeRef = useRef(refreshTree)
  refreshTreeRef.current = refreshTree

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
    }
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      refreshTreeRef.current()
    }, 300)
  }, [])

  const applyRemovalAndRefresh = useCallback((resourceId?: string) => {
    if (resourceId) {
      removeNodeAndPromoteChildren(organizationId, resourceId)
    }
    scheduleRefresh()
  }, [organizationId, removeNodeAndPromoteChildren, scheduleRefresh])

  useEffect(() => () => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
    }
  }, [])

  // 本地 UI 动作也走 handleWsEvent；订阅统一事件总线即可与 WS 使用同一防抖器。
  useEffect(() => {
    if (!enabled || !organizationId || organizationId === 'unknown-organization') return

    const handleLocalResourceEvent = (event: ResourceWsEvent) => {
      if (event.organization_id && event.organization_id !== organizationId) return
      if (event.type === 'resource_updated') return
      if (TREE_REMOVAL_EVENTS.has(event.type)) {
        applyRemovalAndRefresh(event.resource_id)
        return
      }
      if (TREE_STRUCTURAL_EVENTS.has(event.type)) {
        scheduleRefresh()
      }
    }

    const unsubs = ['tabdoc', 'tabdata'].map(resourceType => (
      onResourceEvent(resourceType, handleLocalResourceEvent)
    ))
    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [applyRemovalAndRefresh, enabled, organizationId, scheduleRefresh])

  const handleAfterDispatch = useCallback((parsed: {
    structural?: { type?: string }
    resource?: { type?: string; resource_id?: string; title?: string; updated_at?: string | null }
  } | null) => {
    if (!parsed) return
    const eventType = parsed.structural?.type ?? parsed.resource?.type
    if (typeof eventType !== 'string') return

    if (eventType === 'resource_updated' && parsed.resource) {
      // 内容/标题保存：就地 patch，勿整树 reload
      patchNodeMeta(organizationId, {
        resourceId: parsed.resource.resource_id,
        title: parsed.resource.title,
        updatedAt: parsed.resource.updated_at,
      })
      return
    }

    if (TREE_REMOVAL_EVENTS.has(eventType)) {
      applyRemovalAndRefresh(parsed.resource?.resource_id)
      return
    }

    if (TREE_STRUCTURAL_EVENTS.has(eventType)) {
      scheduleRefresh()
    }
  }, [applyRemovalAndRefresh, organizationId, patchNodeMeta, scheduleRefresh])

  useResourceEventStream({
    scope: 'organization',
    enabled: enabled && Boolean(organizationId) && organizationId !== 'unknown-organization',
    onReconnected: () => refreshTreeRef.current(),
    onAfterDispatch: handleAfterDispatch,
  })

  return { refreshTree }
}
