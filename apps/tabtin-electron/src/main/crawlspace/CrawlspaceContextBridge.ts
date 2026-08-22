import { getCrawlspaceContextHub } from './CrawlspaceContextHub'
import { getViewStateRegistry, type ViewState } from '../webcontents/ViewStateRegistry'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import { getViewFactory } from '../view-factory'
import {
  syncWorkspaceViewMetadata,
  type OrganizationViewMetadataSyncInput,
} from './view-metadata-sync'
import { createLogger } from '../logger'

const log = createLogger('CrawlspaceContextBridge')

type ViewUnregisteredEvent = {
  id: string
  state: ViewState
}

type ViewUpdatedEvent = {
  id: string
  state: ViewState
  updates: Partial<ViewState>
}

function hasOwn<T extends object, K extends PropertyKey>(
  object: T,
  key: K,
): object is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function buildBridgeViewMetaSyncInput(
  viewId: string,
  crawlspaceId: string,
  state: ViewState,
  updates: Partial<ViewState>,
): OrganizationViewMetadataSyncInput | null {
  const input: OrganizationViewMetadataSyncInput = { viewId, crawlspaceId }
  let changed = false

  if (hasOwn(updates, 'url')) {
    input.url = state.url
    changed = true
  }
  if (hasOwn(updates, 'title') && typeof state.title === 'string') {
    input.title = state.title
    changed = true
  }
  if (hasOwn(updates, 'favicon')) {
    input.favicon = state.favicon ?? null
    changed = true
  }

  return changed ? input : null
}

export class CrawlspaceContextBridge {
  private readonly registry = getViewStateRegistry()
  private readonly organizationTabManager = getOrganizationTabManager()
  private readonly hub = getCrawlspaceContextHub()
  private isActive = false

  start(): void {
    if (this.isActive) return
    this.isActive = true
    this.registry.on('view:unregistered', this.handleViewUnregistered)
    this.registry.on('view:updated', this.handleViewUpdated)
  }

  stop(): void {
    if (!this.isActive) return
    this.isActive = false
    this.registry.off('view:unregistered', this.handleViewUnregistered)
    this.registry.off('view:updated', this.handleViewUpdated)
  }

  private handleViewUnregistered = (payload: ViewUnregisteredEvent): void => {
    const { id: viewId, state } = payload
    const crawlspaceId = this.resolveCrawlspaceId(viewId, state)
    if (!crawlspaceId) {
      if (this.organizationTabManager.getTabByView(viewId)) {
        this.organizationTabManager.unregisterView(viewId)
      }
      return
    }

    try {
      const viewFactory = getViewFactory()
      if (viewFactory?.isDestroyingView?.(viewId)) {
        return
      }
    } catch {
      // ignore
    }

    if (this.organizationTabManager.getTabByView(viewId)) {
      this.organizationTabManager.unregisterView(viewId)
    }

    this.hub.unregisterView(crawlspaceId, viewId)
  }

  private handleViewUpdated = (payload: ViewUpdatedEvent): void => {
    const { id: viewId, state, updates } = payload
    const crawlspaceId = this.resolveCrawlspaceId(viewId, state)
    if (!crawlspaceId) return

    try {
      const viewFactory = getViewFactory()
      if (viewFactory?.isDestroyingView?.(viewId)) {
        return
      }
    } catch {
      // ignore
    }

    const BRIDGE_FIELDS = ['url', 'title', 'status', 'favicon'] as const
    if (!BRIDGE_FIELDS.some(f => f in updates)) return

    const metaInput = buildBridgeViewMetaSyncInput(viewId, crawlspaceId, state, updates)
    if (metaInput) {
      syncWorkspaceViewMetadata(metaInput)
    }

    if ('status' in updates) {
      if (state.status === 'error') {
        this.hub.setViewError(crawlspaceId, viewId, {
          errorDescription: state.lastErrorDescription || 'Page failed to load',
        })
      } else {
        this.hub.setViewLoading(crawlspaceId, viewId, state.status === 'loading')
      }
    }
  }

  private resolveCrawlspaceId(viewId: string, state: ViewState): string | null {
    const fromState = state.metadata?.crawlspaceId
    if (typeof fromState === 'string' && fromState.length > 0) {
      return fromState
    }
    if (state.metadata?.kind === 'workspace-view') {
      log.warn('view 缺少 crawlspaceId，跳过同步:', {
        viewId
      })
    }
    return null
  }
}

let bridgeInstance: CrawlspaceContextBridge | null = null

export function initializeCrawlspaceContextBridge(): CrawlspaceContextBridge {
  if (!bridgeInstance) {
    bridgeInstance = new CrawlspaceContextBridge()
  }
  bridgeInstance.start()
  return bridgeInstance
}

export function cleanupCrawlspaceContextBridge(): void {
  if (bridgeInstance) {
    bridgeInstance.stop()
  }
}
