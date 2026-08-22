/**
 * 共享会话内打开云端产物（TabData / TabDoc）。
 * 走 openSharedResourceTab(foreignShared)，不走 owner Space 的 resourceRouter（ A）。
 */

import type { ContextBlock } from '@/components/chat/context/ContextRefCard'
import { openSharedResourceTab } from '@/services/openSharedResource'
import { expandCanvasForScope } from '@/services/openResourceLink'
import { ensureSpaceSelectedWithFeedback } from '@/services/spaceNavigation'
import { useSpaceStore } from '@stores/useSpaceStore'
import type { ImConversationCanvasTarget } from '@components/tabchat/ImConversationCanvasContext'
import { createLogger } from '@/utils/logger'

const log = createLogger('OpenSharedSessionCloudResource')

export type SharedCloudResourceType = 'doc' | 'table'

export type OpenSharedSessionCloudResourceResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'failed' }

/** table/doc 别名归一；与本轮产物 tryOpenSharedCloudArtifact 共用。 */
export function mapSharedCloudResourceType(
  type: string | undefined | null,
): SharedCloudResourceType | null {
  if (!type) return null
  const normalized = type.trim().toLowerCase()
  if (normalized === 'table' || normalized === 'tabdata') return 'table'
  if (normalized === 'doc' || normalized === 'document' || normalized === 'tabdoc') {
    return 'doc'
  }
  return null
}

/** 解析接收方可访问的 host Space（IM 画布优先，否则当前选中 / 同 org / 首个）。 */
export function resolveSharedSessionHostSpace(params: {
  organizationId?: string | null
  imCanvas?: ImConversationCanvasTarget | null
}): { hostSpaceId: string; organizationId: string } | null {
  const spaces = useSpaceStore.getState().spaces
  const eligibleSpaces = params.organizationId
    ? spaces.filter((space) => space.organization_id === params.organizationId)
    : spaces
  if (params.imCanvas?.executionSpaceId) {
    const canvasSpace = eligibleSpaces.find(
      (space) => space.id === params.imCanvas!.executionSpaceId,
    )
    if (canvasSpace?.organization_id) {
      return { hostSpaceId: canvasSpace.id, organizationId: canvasSpace.organization_id }
    }
  }

  const selected = useSpaceStore.getState().selectedSpace
  const visibleSelected = selected
    ? eligibleSpaces.find((space) => space.id === selected.id) ?? null
    : null
  const hostSpace = visibleSelected
    ?? eligibleSpaces[0]
    ?? null

  if (!hostSpace?.id || !hostSpace.organization_id) return null
  return { hostSpaceId: hostSpace.id, organizationId: hostSpace.organization_id }
}

function resolveTabScopeKey(params: {
  imCanvas?: ImConversationCanvasTarget | null
  conversationId?: string | null
}): string | undefined {
  if (params.imCanvas?.scopeKey) return params.imCanvas.scopeKey
  if (params.conversationId) return `im:${params.conversationId}`
  return undefined
}

export async function openSharedSessionCloudResourceFromBlock(params: {
  block: ContextBlock
  organizationId?: string | null
  imCanvas?: ImConversationCanvasTarget | null
  conversationId?: string | null
  tabScopeKey?: string | null
  title?: string
}): Promise<OpenSharedSessionCloudResourceResult> {
  const resourceId = params.block.resource_id?.trim()
  const resourceType = mapSharedCloudResourceType(params.block.type)
  if (!resourceId || !resourceType) {
    return { ok: false, reason: 'unsupported' }
  }

  const host = resolveSharedSessionHostSpace({
    organizationId: params.organizationId,
    imCanvas: params.imCanvas,
  })
  if (!host) {
    log.warn('open skipped: no accessible host space', {
      resourceType,
      resourceId,
      organizationId: params.organizationId || null,
    })
    return { ok: false, reason: 'failed' }
  }

  const tabScopeKey = params.tabScopeKey || resolveTabScopeKey({
    imCanvas: params.imCanvas,
    conversationId: params.conversationId,
  })
  if (!tabScopeKey) {
    const selected = await ensureSpaceSelectedWithFeedback(host.hostSpaceId, {
      organizationId: host.organizationId,
    })
    if (!selected) return { ok: false, reason: 'failed' }
  }

  openSharedResourceTab({
    hostSpaceId: host.hostSpaceId,
    resourceType,
    resourceId,
    resourceSpaceId: params.block.space_id?.trim() || undefined,
    organizationId: host.organizationId,
    title: params.title,
    ...(tabScopeKey ? { tabScopeKey } : {}),
  })
  expandCanvasForScope(tabScopeKey)
  return { ok: true }
}
