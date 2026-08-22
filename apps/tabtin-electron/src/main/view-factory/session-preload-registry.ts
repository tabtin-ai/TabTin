import { session } from 'electron'

type SessionWithPreloadApi = Electron.Session & {
  partition?: string
  registerPreloadScript?: (script: {
    type: 'frame' | 'service-worker'
    filePath: string
  }) => string
  unregisterPreloadScript?: (id: string) => void
  getPreloadScripts?: () => Array<{
    id?: string
    type?: string
    filePath?: string
  }>
  getPreloads?: () => string[]
  setPreloads?: (preloads: string[]) => void
}

type SessionPreloadEntry = {
  id: string | null
  filePath: string
}

export type SessionPreloadRegistry = Map<string, Map<string, SessionPreloadEntry>>

export function createSessionPreloadRegistry(): SessionPreloadRegistry {
  return new Map()
}

function getSessionKey(partition?: string): string {
  return partition || 'shared'
}

function getTargetSession(partition?: string): SessionWithPreloadApi {
  return (partition ? session.fromPartition(partition) : session.defaultSession) as SessionWithPreloadApi
}

function ensureRegistryBucket(
  registry: SessionPreloadRegistry,
  sessionKey: string,
): Map<string, SessionPreloadEntry> {
  let bucket = registry.get(sessionKey)
  if (!bucket) {
    bucket = new Map()
    registry.set(sessionKey, bucket)
  }
  return bucket
}

export function ensureFramePreloadRegistered(
  partition: string | undefined,
  preloadPath: string,
  registry: SessionPreloadRegistry,
  log: (...args: unknown[]) => void,
): void {
  const sessionKey = getSessionKey(partition)
  const bucket = ensureRegistryBucket(registry, sessionKey)
  if (bucket.has(preloadPath)) return

  const targetSession = getTargetSession(partition)

  if (
    typeof targetSession.registerPreloadScript === 'function'
    && typeof targetSession.getPreloadScripts === 'function'
  ) {
    const existing = targetSession
      .getPreloadScripts()
      .find((script) => script.type === 'frame' && script.filePath === preloadPath)

    const preloadId = existing?.id
      || targetSession.registerPreloadScript({
        type: 'frame',
        filePath: preloadPath,
      })

    bucket.set(preloadPath, { id: preloadId ?? null, filePath: preloadPath })
    log('[ViewFactory] ✅ 已通过 session.registerPreloadScript 注册 preload:', sessionKey, preloadPath)
    return
  }

  if (
    typeof targetSession.getPreloads === 'function'
    && typeof targetSession.setPreloads === 'function'
  ) {
    const currentPreloads = targetSession.getPreloads() ?? []
    if (!currentPreloads.includes(preloadPath)) {
      targetSession.setPreloads([...currentPreloads, preloadPath])
    }
    bucket.set(preloadPath, { id: null, filePath: preloadPath })
    log('[ViewFactory] ✅ 已通过旧版 setPreloads 注册 preload:', sessionKey, preloadPath)
    return
  }

  log('[ViewFactory] ⚠️ 当前 Session 不支持 preload 注册 API:', sessionKey)
}

export async function cleanupRegisteredSessionPreloads(
  registry: SessionPreloadRegistry,
  log: (...args: unknown[]) => void,
): Promise<void> {
  if (registry.size === 0) return

  for (const [sessionKey, bucket] of registry.entries()) {
    const targetSession = getTargetSession(sessionKey === 'shared' ? undefined : sessionKey)

    try {
      if (
        typeof targetSession.unregisterPreloadScript === 'function'
        && typeof targetSession.getPreloadScripts === 'function'
      ) {
        const registeredScripts = targetSession.getPreloadScripts()
        for (const entry of bucket.values()) {
          const preloadId = entry.id
            || registeredScripts.find((script) => script.type === 'frame' && script.filePath === entry.filePath)?.id
          if (preloadId) {
            targetSession.unregisterPreloadScript(preloadId)
          }
        }
        log('[ViewFactory] ✅ 已清理 session preload:', sessionKey)
        continue
      }

      if (
        typeof targetSession.getPreloads === 'function'
        && typeof targetSession.setPreloads === 'function'
      ) {
        const managedPaths = new Set(Array.from(bucket.values(), (entry) => entry.filePath))
        const nextPreloads = (targetSession.getPreloads() ?? []).filter((item) => !managedPaths.has(item))
        targetSession.setPreloads(nextPreloads)
        log('[ViewFactory] ✅ 已清理旧版 session preload:', sessionKey)
      }
    } catch (error) {
      log('[ViewFactory] ⚠️ 清理 session preload 失败:', sessionKey, error)
    }
  }

  registry.clear()
}
