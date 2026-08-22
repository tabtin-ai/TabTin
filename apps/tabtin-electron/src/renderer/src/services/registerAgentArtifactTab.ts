import { parseResourcePointer } from '@tabtin/resource-router'
import { resourceRouter } from './resourceRouter'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { resolveSpaceIdForResourceLink } from './openResourceLink'
import { createLogger } from '@/utils/logger'

const log = createLogger('registerAgentArtifactTab')
const inFlightRegistrations = new Set<string>()

const TAB_TYPE_BY_RESOURCE_TYPE: Record<string, string> = {
  table: 'tabdata',
  tabdata: 'tabdata',
  doc: 'tabdoc',
  document: 'tabdoc',
  tabdoc: 'tabdoc',
  slide: 'tabslide',
  site: 'tabsite',
  tracker: 'tabtracker',
  // tabfiles 是承载 App ID；标签键使用 handler.type，即 `file:<relative-path>`。
  file: 'file',
}

const CARRIER_BY_RESOURCE_TYPE: Record<string, string> = {
  table: 'tabdata',
  tabdata: 'tabdata',
  doc: 'tabdoc',
  document: 'tabdoc',
  tabdoc: 'tabdoc',
  slide: 'tabslide',
  site: 'tabsite',
  tracker: 'tabtracker',
  file: 'tabfiles',
}

export interface RegisterAgentArtifactInput {
  tabScopeKey: string | null | undefined
  resourceType: string
  resourceId: string
  title?: string | null
  hintCarrierAppId?: string | null
  token?: string | null
}

/**
 * Agent 交付物静默登记：只写当前 conversation 标签桶，不抢焦点、不展开画布。
 * 重挂载靠 tabKey 去重；并发流式块靠 token+tabKey 去重。
 */
export async function registerAgentArtifactTab(
  input: RegisterAgentArtifactInput,
): Promise<boolean> {
  const tabScopeKey = input.tabScopeKey?.trim()
  const resourceType = input.resourceType.trim()
  const resourceId = input.resourceId.trim()
  if (!tabScopeKey?.startsWith('conversation:') || !resourceType || !resourceId) {
    return false
  }

  const tabType = TAB_TYPE_BY_RESOURCE_TYPE[resourceType]
  if (!tabType || tabType === 'tabweb') return false
  const tabKey = `${tabType}:${resourceId}`
  const tabs = useSpaceContextTabsStore.getState()
  if (tabs.explicitClosedTabKeysByScope[tabScopeKey]?.includes(tabKey)) return true
  if (tabs.itemsBySpace[tabScopeKey]?.[tabKey]) return true

  const registrationKey = `${input.token || 'no-token'}:${tabScopeKey}:${tabKey}`
  if (inFlightRegistrations.has(registrationKey)) return true
  inFlightRegistrations.add(registrationKey)

  try {
    const params = new URLSearchParams()
    const carrier = input.hintCarrierAppId || CARRIER_BY_RESOURCE_TYPE[resourceType]
    if (carrier) params.set('hint', carrier)
    if (input.title?.trim()) params.set('title', input.title.trim())
    const href = `tabtin://resource/${resourceType}/${encodeURIComponent(resourceId)}${
      params.size > 0 ? `?${params.toString()}` : ''
    }`
    const spaceId = resolveSpaceIdForResourceLink(tabScopeKey)
    if (!spaceId) return false
    const outcome = await resourceRouter.open(spaceId, parseResourcePointer(href), {
      tabScopeKey,
      registerOnly: true,
      triggerSource: 'rich_resource_card',
    })
    if (outcome.outcome !== 'in_space_opened') {
      log.warn('artifact registration failed', {
        resourceType,
        resourceId,
        tabScopeKey,
        outcome: outcome.outcome,
      })
      return false
    }
    return true
  } catch (error) {
    log.warn('artifact registration threw', {
      resourceType,
      resourceId,
      tabScopeKey,
      error,
    })
    return false
  } finally {
    inFlightRegistrations.delete(registrationKey)
  }
}

export function _clearAgentArtifactRegistrationState(): void {
  inFlightRegistrations.clear()
}
