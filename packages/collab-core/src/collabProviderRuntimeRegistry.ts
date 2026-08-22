import { CollabProvider } from './provider.js'
import type { CollabProviderOptions } from './types.js'

interface SharedRuntimeEntry {
  provider: CollabProvider
  leases: Map<symbol, CollabProviderOptions>
  releaseTimer: ReturnType<typeof setTimeout> | null
  serverUrl: string
  documentName: string
  userId: string
}

export interface CollabProviderRuntimeLease {
  provider: CollabProvider
  update(options: CollabProviderOptions): void
  release(): void
}

const sharedRuntimes = new Map<string, SharedRuntimeEntry>()
const SHARED_RUNTIME_RELEASE_GRACE_MS = 1_000

function invokeFirstCallback<K extends 'onTokenRefreshRequired' | 'onServerShutdown'>(
  entry: SharedRuntimeEntry,
  key: K,
): void {
  for (const options of entry.leases.values()) {
    const callback = options[key]
    if (callback) {
      callback()
      return
    }
  }
}

function invokeFirstStoreFailed(entry: SharedRuntimeEntry, message: string): void {
  for (const options of entry.leases.values()) {
    if (options.onStoreFailed) {
      options.onStoreFailed(message)
      return
    }
  }
}

function assertCompatibleRuntime(
  key: string,
  entry: SharedRuntimeEntry,
  options: CollabProviderOptions,
): void {
  if (
    entry.serverUrl !== options.serverUrl
    || entry.documentName !== options.documentName
    || entry.userId !== options.user.id
  ) {
    throw new Error(
      `[collab-runtime] sharedRuntimeKey collision: ${key} resolves to a different resource`,
    )
  }
}

/**
 * 获取进程内共享的协同资源运行时。
 *
 * 调用方只负责持有并释放租约；同一 key 的 Provider/Y.Doc/物理连接由本模块统一拥有。
 */
export function acquireCollabProviderRuntime(
  key: string,
  options: CollabProviderOptions,
): CollabProviderRuntimeLease {
  const leaseId = Symbol(key)
  let entry = sharedRuntimes.get(key)

  if (entry) {
    assertCompatibleRuntime(key, entry, options)
    if (entry.releaseTimer) {
      clearTimeout(entry.releaseTimer)
      entry.releaseTimer = null
    }
    entry.leases.set(leaseId, options)
  } else {
    const leases = new Map<symbol, CollabProviderOptions>([[leaseId, options]])
    const nextEntry = {
      provider: null as unknown as CollabProvider,
      leases,
      releaseTimer: null,
      serverUrl: options.serverUrl,
      documentName: options.documentName,
      userId: options.user.id,
    }
    const provider = new CollabProvider({
      ...options,
      onTokenRefreshRequired: () => invokeFirstCallback(nextEntry, 'onTokenRefreshRequired'),
      onServerShutdown: () => invokeFirstCallback(nextEntry, 'onServerShutdown'),
      onStoreFailed: (message) => invokeFirstStoreFailed(nextEntry, message),
    })
    nextEntry.provider = provider
    entry = nextEntry
    sharedRuntimes.set(key, entry)
    provider.connect()
  }

  let released = false
  return {
    provider: entry.provider,
    update(nextOptions) {
      if (released) return
      assertCompatibleRuntime(key, entry, nextOptions)
      entry.leases.set(leaseId, nextOptions)
      if (nextOptions.token) {
        entry.provider.updateToken(nextOptions.token)
      }
    },
    release() {
      if (released) return
      released = true
      entry.leases.delete(leaseId)
      if (entry.leases.size > 0) return
      if (sharedRuntimes.get(key) !== entry) return
      entry.releaseTimer = setTimeout(() => {
        entry.releaseTimer = null
        if (entry.leases.size > 0) return
        if (sharedRuntimes.get(key) !== entry) return
        sharedRuntimes.delete(key)
        entry.provider.disconnect()
      }, SHARED_RUNTIME_RELEASE_GRACE_MS)
    },
  }
}
