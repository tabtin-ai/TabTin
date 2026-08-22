import type { CommentThread } from '@tabtin/tabdoc-ui/api-client'
import {
  createCommentThreadReloadCoordinator,
  type CommentThreadReloadCoordinator,
  type CommentThreadReloadDiagnostic,
  type CommentThreadReloadReason,
} from './commentThreadReloadCoordinator'

export interface CommentThreadLoadResult {
  threads: CommentThread[]
  capabilities: string[]
}

interface CommentThreadLoadListener {
  onSuccess: (result: CommentThreadLoadResult) => void
  onError: (error: unknown) => void
}

interface RealtimeSubscription {
  unsubscribe: () => void
}

interface SharedEntry {
  coordinator: CommentThreadReloadCoordinator
  listeners: Set<CommentThreadLoadListener>
  lastSuccess: CommentThreadLoadResult | null
  lastError: unknown | null
  realtimeSubscription: RealtimeSubscription | null
  started: boolean
  releaseGeneration: number
}

export interface SharedCommentThreadReloadHandle {
  request: (reason: CommentThreadReloadReason) => void
  ensureRealtimeSubscription: (
    subscribe: (
      request: (reason: CommentThreadReloadReason) => void,
    ) => RealtimeSubscription,
  ) => void
  release: () => void
}

interface AcquireSharedCommentThreadReloadOptions {
  clientKey: object
  documentId: string
  load: () => Promise<CommentThreadLoadResult>
  listener: CommentThreadLoadListener
  onDiagnostic?: (event: CommentThreadReloadDiagnostic) => void
}

const registry = new WeakMap<object, Map<string, SharedEntry>>()

function resourceMapFor(clientKey: object): Map<string, SharedEntry> {
  const existing = registry.get(clientKey)
  if (existing) return existing
  const created = new Map<string, SharedEntry>()
  registry.set(clientKey, created)
  return created
}

/** 同一 AppHostClient + documentId 的多窗格共享加载、缓存和实时订阅。 */
export function acquireSharedCommentThreadReload({
  clientKey,
  documentId,
  load,
  listener,
  onDiagnostic,
}: AcquireSharedCommentThreadReloadOptions): SharedCommentThreadReloadHandle {
  const resources = resourceMapFor(clientKey)
  let entry = resources.get(documentId)

  if (!entry) {
    const listeners = new Set<CommentThreadLoadListener>()
    const created: SharedEntry = {
      listeners,
      lastSuccess: null,
      lastError: null,
      realtimeSubscription: null,
      started: false,
      releaseGeneration: 0,
      coordinator: null as unknown as CommentThreadReloadCoordinator,
    }
    created.coordinator = createCommentThreadReloadCoordinator({
      load,
      onSuccess: (value) => {
        created.lastSuccess = value
        created.lastError = null
        created.listeners.forEach((current) => current.onSuccess(value))
      },
      onError: (error) => {
        created.lastError = error
        created.listeners.forEach((current) => current.onError(error))
      },
      onDiagnostic,
    })
    resources.set(documentId, created)
    entry = created
  }

  const resource = entry
  resource.releaseGeneration += 1
  resource.listeners.add(listener)

  if (resource.lastSuccess || resource.lastError) {
    const lastSuccess = resource.lastSuccess
    const lastError = resource.lastError
    queueMicrotask(() => {
      if (!resource.listeners.has(listener)) return
      if (lastSuccess) listener.onSuccess(lastSuccess)
      if (lastError) listener.onError(lastError)
    })
  }

  if (!resource.started) {
    resource.started = true
    resource.coordinator.request('initial')
  }

  let released = false
  return {
    request(reason) {
      if (!released) resource.coordinator.request(reason)
    },
    ensureRealtimeSubscription(subscribe) {
      if (released || resource.realtimeSubscription) return
      resource.realtimeSubscription = subscribe((reason) =>
        resource.coordinator.request(reason),
      )
    },
    release() {
      if (released) return
      released = true
      resource.listeners.delete(listener)
      if (resource.listeners.size > 0) return
      const releaseGeneration = ++resource.releaseGeneration
      queueMicrotask(() => {
        if (
          resource.releaseGeneration !== releaseGeneration ||
          resource.listeners.size > 0
        )
          return
        resource.realtimeSubscription?.unsubscribe()
        resource.realtimeSubscription = null
        resource.coordinator.dispose()
        resources.delete(documentId)
        if (resources.size === 0) registry.delete(clientKey)
      })
    },
  }
}
